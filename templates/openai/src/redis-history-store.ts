import { createClient } from 'redis';
import { generationLeaseLifetime, historyLifetime, historyCapacity, historyByteLimit,
  HistoryStoreUnavailable, HistoryConflict, HistoryNotFound, HistoryCapacityExceeded,
  validateHistoryId, validateHistoryMessages, type HistoryMessage, type HistoryStore } from './history-store.js';

export function validateRedisConfig(url: string | undefined, namespace: string | undefined, localDev: boolean): void {
  if (!(localDev && !url && namespace === undefined) && (!namespace || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace))) throw new Error('Invalid history namespace configuration.');
  if (!url && localDev) return;
  try {
    if (!url || url.length > 4096 || /[\x00-\x20\x7f]/.test(url)) throw new Error();
    const parsed = new URL(url);
    decodeURIComponent(parsed.username); decodeURIComponent(parsed.password);
    if (!parsed.hostname || parsed.hash || parsed.search || !/^(?:\/(?:\d+)?)?$/.test(parsed.pathname) ||
        (parsed.pathname.length > 1 && !Number.isSafeInteger(Number(parsed.pathname.slice(1)))) ||
        (localDev ? !['redis:', 'rediss:'].includes(parsed.protocol) : parsed.protocol !== 'rediss:')) throw new Error();
  } catch { throw new Error('REDIS_URL must configure Redis with TLS in production.'); }
}

// Single-slot atomic operations use Redis TIME, not instance clocks. The index counts both
// committed conversations and short-lived new reservations. Losing the index fails closed.
const historyCommand = `
local clock = redis.call('TIME')
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
local op = ARGV[1]
local owner = ARGV[2]
local lease = redis.call('GET', KEYS[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local score = redis.call('ZSCORE', KEYS[1], KEYS[2])
local value = redis.call('GET', KEYS[2])
if value and not score then redis.call('DEL', KEYS[2]); value = false end
if score and not value and not lease then redis.call('ZREM', KEYS[1], KEYS[2]); score = false end
local function indexExpiry()
  local latest = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
  if latest[2] then redis.call('PEXPIREAT', KEYS[1], latest[2]) end
end
if op == 'get' then return value or 0 end
if op == 'delete' then
  if owner == '' then
    if lease then return -2 end
  elseif not lease or (lease ~= owner .. ':new' and lease ~= owner .. ':existing') then
    return -2
  end
  if not value then return -1 end
  redis.call('DEL', KEYS[2]); redis.call('ZREM', KEYS[1], KEYS[2]); return 1
end
if op == 'acquire' then
  if lease then return -2 end
  local isNew = ARGV[3] == '1'
  if isNew and value then return -2 end
  if not isNew and not value then return -1 end
  if isNew and redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[6]) then return -3 end
  redis.call('SET', KEYS[3], owner .. (isNew and ':new' or ':existing'), 'PX', ARGV[4])
  if isNew then redis.call('ZADD', KEYS[1], now + tonumber(ARGV[4]), KEYS[2]); indexExpiry() end
  return value or '[]'
end
if lease ~= owner .. ':new' and lease ~= owner .. ':existing' then return 0 end
if op == 'release' then
  redis.call('DEL', KEYS[3])
  if not value then redis.call('ZREM', KEYS[1], KEYS[2]) end
  return 1
end
if op == 'commit' then
  if not score or (lease == owner .. ':existing' and not value) or
      (lease == owner .. ':new' and value) then return 0 end
  redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[5])
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[5]), KEYS[2]); indexExpiry()
  redis.call('DEL', KEYS[3]); return 1
end
return 0
`;

export async function createRedisHistoryStore(url: string, namespace: string, localDev: boolean): Promise<HistoryStore> {
  validateRedisConfig(url, namespace, localDev);
  const client = (() => {
    try {
      return createClient({ url, disableOfflineQueue: true, commandsQueueMaxLength: 100, pingInterval: 5000,
        socket: { connectTimeout: 3000, socketTimeout: 10000,
          reconnectStrategy: retries => Math.min(3000, 100 * 2 ** Math.min(retries, 5)) } });
    } catch { throw new HistoryStoreUnavailable(); }
  })();
  client.on('error', () => {});
  const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HistoryStoreUnavailable()), 3000);
      })]);
    } catch { throw new HistoryStoreUnavailable(); }
    finally { clearTimeout(timer); }
  };
  try { await safe(() => client.connect()); }
  catch (error) { if (client.isOpen) client.destroy(); throw error; }
  const prefix = `fastagent:{${namespace}}:history:`;
  const command = () => client.withCommandOptions({ abortSignal: AbortSignal.timeout(3000) });
  const operate = async (op: string, id: string, owner = '', payload = '') => {
    validateHistoryId(id); if (owner) validateHistoryId(owner);
    const result = await safe(() => command().eval(historyCommand, {
      keys: [prefix + 'index', prefix + id, prefix + 'lease:' + id],
      arguments: [op, owner, payload, String(generationLeaseLifetime), String(historyLifetime), String(historyCapacity)],
    }));
    if (result === -1) throw new HistoryNotFound();
    if (result === -2) throw new HistoryConflict();
    if (result === -3) throw new HistoryCapacityExceeded();
    return result;
  };
  const decode = (value: unknown): HistoryMessage[] => {
    try {
      if (typeof value !== 'string' || Buffer.byteLength(value) > historyByteLimit) throw new Error();
      const messages: unknown = JSON.parse(value);
      validateHistoryMessages(messages); return messages;
    } catch { throw new HistoryStoreUnavailable(); }
  };
  return {
    async check() { await safe(() => command().ping()); },
    async get(id) { const value = await operate('get', id); return value === 0 ? undefined : decode(value); },
    async acquire(id, owner, isNew) {
      const value = await operate('acquire', id, owner, isNew ? '1' : '0');
      if (isNew && value === '[]') return [];
      try { return decode(value); }
      catch (error) { await operate('release', id, owner).catch(() => {}); throw error; }
    },
    async commit(id, owner, messages) {
      validateHistoryMessages(messages);
      return await operate('commit', id, owner, JSON.stringify(messages)) === 1;
    },
    async release(id, owner) { await operate('release', id, owner); },
    async delete(id, owner = '') {
      try { return await operate('delete', id, owner) === 1; }
      catch (error) { if (error instanceof HistoryNotFound) return false; throw error; }
    },
    async close() { if (client.isOpen) client.destroy(); },
  };
}
