export interface Session { csrf: string; expires: number; authenticated: boolean }
export const sessionLifetime = 60 * 60 * 1000;
export const anonymousLifetime = 5 * 60 * 1000;
export const authenticatedCapacity = 1000;
export const anonymousCapacity = 256;

// Keys are SHA-256 cookie digests, never raw cookies. Mutations must be atomic.
export interface SessionStore {
  check(): Promise<void>;
  get(hash: string): Promise<Session | undefined>;
  issue(hash: string, session: Session): Promise<void>;
  rotate(hash: string, csrf: string, replacementHash: string, session: Session): Promise<boolean>;
  revoke(hash: string, csrf: string): Promise<boolean>;
  close(): Promise<void>;
}
export class SessionStoreUnavailable extends Error {
  constructor() { super('Session service unavailable. Please try again.'); }
}

// Explicit localhost development only; production startup never selects this store.
export function createMemorySessionStore(): SessionStore {
  const authenticated = new Map<string, Session>();
  const anonymous = new Map<string, Session>();
  const prune = () => {
    for (const sessions of [authenticated, anonymous]) {
      for (const [hash, session] of sessions) if (session.expires <= Date.now()) sessions.delete(hash);
    }
  };
  const get = (hash: string) => authenticated.get(hash) ?? anonymous.get(hash);
  return {
    async check() {},
    async get(hash) { prune(); return get(hash); },
    async issue(hash, session) {
      prune();
      if (anonymous.size >= anonymousCapacity) anonymous.delete(anonymous.keys().next().value!);
      anonymous.set(hash, session);
    },
    async rotate(hash, csrf, replacementHash, session) {
      prune();
      const old = get(hash);
      if (!old || old.csrf !== csrf || (authenticated.size >= authenticatedCapacity && !old.authenticated)) return false;
      anonymous.delete(hash); authenticated.delete(hash);
      authenticated.set(replacementHash, session);
      return true;
    },
    async revoke(hash, csrf) {
      prune();
      if (get(hash)?.csrf !== csrf) return false;
      authenticated.delete(hash); anonymous.delete(hash);
      return true;
    },
    async close() { authenticated.clear(); anonymous.clear(); },
  };
}
