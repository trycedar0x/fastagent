import { createClient } from 'redis';
import { anonymousCapacity, anonymousLifetime, authenticatedCapacity, sessionLifetime,
  SessionStoreUnavailable, type Session, type SessionStore } from './session-store.js';

export function validateRedisConfig(url: string | undefined, namespace: string | undefined, localDev: boolean): void {
  if (!(localDev && !url && namespace === undefined) && (!namespace || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace))) throw new Error('Invalid session namespace configuration.');
  if (!url && localDev) return;
  try {
    if (!url || /[\x00-\x20\x7f]/.test(url)) throw new Error();
    const parsed = new URL(url);
    decodeURIComponent(parsed.username); decodeURIComponent(parsed.password);
    if (!parsed.hostname || parsed.hash || parsed.search || !/^(?:\/(?:\d+)?)?$/.test(parsed.pathname) ||
        (parsed.pathname.length > 1 && !Number.isSafeInteger(Number(parsed.pathname.slice(1)))) ||
        (localDev ? !['redis:', 'rediss:'].includes(parsed.protocol) : parsed.protocol !== 'rediss:')) throw new Error();
  } catch { throw new Error('REDIS_URL must configure Redis with TLS in production.'); }
}

// All keys share a stable app hash tag. An evicted index invalidates its surviving records.
// Reads and CAS mutations check the same membership atomically, including after password verification.
const sessionCommand = `
local clock = redis.call('TIME')
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local function removeOld()
  redis.call('DEL', KEYS[3])
  redis.call('ZREM', KEYS[1], KEYS[3])
  redis.call('ZREM', KEYS[2], KEYS[3])
end
local op = ARGV[1]
local old
if op ~= 'issue' then
  local value = redis.call('GET', KEYS[3])
  if not value then removeOld(); return 0 end
  local decoded
  decoded, old = pcall(cjson.decode, value)
  if not decoded or type(old) ~= 'table' or type(old.authenticated) ~= 'boolean' or
      type(old.csrf) ~= 'string' or #old.csrf ~= 43 or not string.match(old.csrf, '^[%w_-]+$') or
      type(old.expires) ~= 'number' then removeOld(); return 0 end
  local index = old.authenticated and KEYS[1] or KEYS[2]
  local other = old.authenticated and KEYS[2] or KEYS[1]
  local score = redis.call('ZSCORE', index, KEYS[3])
  if not score or tonumber(score) ~= old.expires or old.expires <= now or
      redis.call('ZSCORE', other, KEYS[3]) then removeOld(); return 0 end
  if op == 'get' then return value end
  if old.csrf ~= ARGV[2] then return 0 end
  if op == 'revoke' then removeOld(); return 1 end
  if not old.authenticated and redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[5]) then return 0 end
end
local replacement = cjson.decode(ARGV[3])
-- Client clocks may differ: never extend the serialized deadline or Redis's maximum lifetime.
local expires = math.min(replacement.expires, now + tonumber(ARGV[4]))
if expires <= now then return 0 end
replacement.expires = expires
if op == 'rotate' then
  removeOld()
elseif redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[5]) then
  local oldest = redis.call('ZRANGE', KEYS[2], 0, 0)[1]
  redis.call('DEL', oldest)
  redis.call('ZREM', KEYS[2], oldest)
end
local index = op == 'issue' and KEYS[2] or KEYS[1]
redis.call('SET', KEYS[4], cjson.encode(replacement), 'PX', expires - now)
redis.call('ZADD', index, expires, KEYS[4])
-- A shorter-lived new record must not shorten the index's longest active deadline.
local latest = redis.call('ZRANGE', index, -1, -1, 'WITHSCORES')
redis.call('PEXPIREAT', index, latest[2])
return 1
`;

export async function createRedisSessionStore(url: string, namespace: string, localDev: boolean): Promise<SessionStore> {
  validateRedisConfig(url, namespace, localDev);
  if (!url) throw new SessionStoreUnavailable();
  const client = (() => {
    try {
      return createClient({ url, disableOfflineQueue: true, commandsQueueMaxLength: 100,
        // Native heartbeats prevent idle timeout churn; stalled sockets reconnect without queueing requests.
        pingInterval: 5000,
        socket: { connectTimeout: 3000, socketTimeout: 10000,
          reconnectStrategy: retries => Math.min(3000, 100 * 2 ** Math.min(retries, 5)) } });
    } catch { throw new SessionStoreUnavailable(); }
  })();
  // Redis error events may contain the credential-bearing URL. Never log or propagate them.
  client.on('error', () => {});
  const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SessionStoreUnavailable()), 3000);
      })]);
    } catch {
      throw new SessionStoreUnavailable();
    } finally { clearTimeout(timer); }
  };
  // Startup is bounded separately; only a ready connection may produce a listening server.
  try { await safe(() => client.connect()); }
  catch (error) { if (client.isOpen) client.destroy(); throw error; }
  const prefix = `fastagent:{${namespace}}:sessions:`;
  const key = (hash: string) => {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new SessionStoreUnavailable();
    return prefix + hash;
  };
  const command = () => client.withCommandOptions({ abortSignal: AbortSignal.timeout(3000) });
  const mutate = (op: string, hash: string, csrf = '', replacementHash = hash, session?: Session) => safe(async () =>
    await command().eval(sessionCommand, {
      keys: [prefix + 'authenticated', prefix + 'anonymous', key(hash), key(replacementHash)],
      arguments: [op, csrf, session ? JSON.stringify(session) : '',
        String(op === 'issue' ? anonymousLifetime : sessionLifetime),
        String(op === 'issue' ? anonymousCapacity : authenticatedCapacity)],
    }) === 1);
  return {
    async check() { await safe(() => command().ping()); },
    async get(hash) {
      return safe(async () => {
        const value = await command().eval(sessionCommand, {
          keys: [prefix + 'authenticated', prefix + 'anonymous', key(hash)], arguments: ['get'],
        });
        if (!value) return undefined;
        if (typeof value !== 'string') throw new Error();
        const session = JSON.parse(value) as Session;
        if (typeof session.authenticated !== 'boolean' || !/^[\w-]{43}$/.test(session.csrf) ||
            !Number.isFinite(session.expires)) throw new Error();
        return session;
      });
    },
    async issue(hash, session) { await mutate('issue', hash, '', hash, session); },
    rotate(hash, csrf, replacementHash, session) { return mutate('rotate', hash, csrf, replacementHash, session); },
    revoke(hash, csrf) { return mutate('revoke', hash, csrf); },
    async close() { if (client.isOpen) client.destroy(); },
  };
}
