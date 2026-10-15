export interface HistoryMessage { role: 'user' | 'assistant'; content: string }
export const historyLifetime = 7 * 24 * 60 * 60 * 1000;
export const historyCapacity = 1000;
export const historyMessageLimit = 40;
// UTF-8 bytes of the serialized message array (not Redis envelope/keys).
export const historyByteLimit = 256 * 1024;
export const generationLeaseLifetime = 45000;
export const contextMessageLimit = 20;
export const contextCharacterLimit = 16000;

export class HistoryStoreUnavailable extends Error {
  constructor() { super('Conversation service unavailable. Please try again.'); }
}
export class HistoryConflict extends Error {}
export class HistoryNotFound extends Error {}
export class HistoryCapacityExceeded extends Error {}

// owner and id are independent server-generated 32-byte base64url values.
// acquire reserves new capacity or locks existing history; commit/release must check live ownership.
export interface HistoryStore {
  check(): Promise<void>;
  get(id: string): Promise<HistoryMessage[] | undefined>;
  acquire(id: string, owner: string, isNew: boolean): Promise<HistoryMessage[]>;
  commit(id: string, owner: string, messages: HistoryMessage[]): Promise<boolean>;
  release(id: string, owner: string): Promise<void>;
  delete(id: string, owner?: string): Promise<boolean>;
  close(): Promise<void>;
}
export function validateHistoryId(value: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new HistoryStoreUnavailable();
}
export function validateHistoryMessages(value: unknown): asserts value is HistoryMessage[] {
  if (!Array.isArray(value) || !value.length || value.length > historyMessageLimit || value.length % 2 ||
      value.some((message, index) => !message || Object.keys(message).sort().join(',') !== 'content,role' ||
        message.role !== (index % 2 ? 'assistant' : 'user') || typeof message.content !== 'string' || !message.content.trim() ||
        (index % 2 ? Buffer.byteLength(message.content) > 65536 : message.content.length > 4000)) ||
      Buffer.byteLength(JSON.stringify(value)) > historyByteLimit) throw new HistoryStoreUnavailable();
}
export function completedHistory(previous: HistoryMessage[], user: string, assistant: string): HistoryMessage[] {
  const messages: HistoryMessage[] = [...previous, { role: 'user', content: user }, { role: 'assistant', content: assistant }];
  while (messages.length > historyMessageLimit || Buffer.byteLength(JSON.stringify(messages)) > historyByteLimit) messages.splice(0, 2);
  validateHistoryMessages(messages);
  return messages;
}
export function modelContext(previous: HistoryMessage[], message: string): HistoryMessage[] {
  const messages: HistoryMessage[] = [{ role: 'user', content: message }];
  let characters = message.length;
  for (let i = previous.length - 2; i >= 0; i -= 2) {
    const user = previous[i]!; const assistant = previous[i + 1]!;
    if (messages.length + 2 > contextMessageLimit || characters + user.content.length + assistant.content.length > contextCharacterLimit) break;
    messages.unshift(user, assistant); characters += user.content.length + assistant.content.length;
  }
  return messages;
}

// Explicit localhost development only; no eviction and no production outage fallback.
export function createMemoryHistoryStore(): HistoryStore {
  const records = new Map<string, { messages: HistoryMessage[]; expires: number }>();
  const leases = new Map<string, { owner: string; expires: number; isNew: boolean }>();
  const prune = () => {
    for (const [id, record] of records) if (record.expires <= Date.now()) records.delete(id);
    for (const [id, lease] of leases) if (lease.expires <= Date.now()) leases.delete(id);
  };
  const owned = (id: string, owner: string) => {
    const lease = leases.get(id);
    return lease?.owner === owner && (lease.isNew ? !records.has(id) : records.has(id));
  };
  const copy = (messages: HistoryMessage[]) => messages.map(message => ({ ...message }));
  return {
    async check() {},
    async get(id) { validateHistoryId(id); prune(); const record = records.get(id); return record && copy(record.messages); },
    async acquire(id, owner, isNew) {
      validateHistoryId(id); validateHistoryId(owner); prune();
      if (leases.has(id)) throw new HistoryConflict();
      const record = records.get(id);
      if (isNew && record) throw new HistoryConflict();
      if (!isNew && !record) throw new HistoryNotFound();
      if (isNew && new Set([...records.keys(), ...leases.keys()]).size >= historyCapacity) throw new HistoryCapacityExceeded();
      leases.set(id, { owner, expires: Date.now() + generationLeaseLifetime, isNew });
      return record ? copy(record.messages) : [];
    },
    async commit(id, owner, messages) {
      validateHistoryId(id); validateHistoryId(owner); validateHistoryMessages(messages); prune();
      if (!owned(id, owner)) return false;
      records.set(id, { messages: copy(messages), expires: Date.now() + historyLifetime }); leases.delete(id);
      return true;
    },
    async release(id, owner) {
      validateHistoryId(id); validateHistoryId(owner); prune();
      if (leases.get(id)?.owner === owner) leases.delete(id);
    },
    async delete(id, owner) {
      validateHistoryId(id); if (owner) validateHistoryId(owner); prune();
      const lease = leases.get(id);
      // An HTTP delete carries no owner and conflicts with an active generation. An owner-bearing delete
      // is authorized only while that exact owner still holds a live lease, so a stale owner can never
      // erase a conversation another instance has since committed.
      if (owner ? lease?.owner !== owner : lease !== undefined) throw new HistoryConflict();
      return records.delete(id);
    },
    async close() { records.clear(); leases.clear(); },
  };
}
