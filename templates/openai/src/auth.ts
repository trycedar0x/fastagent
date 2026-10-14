import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sessionLifetime, anonymousLifetime, SessionStoreUnavailable, type Session, type SessionStore } from './session-store.js';

const scrypt = promisify(scryptCallback);
const token = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const issuanceWindow = 60 * 1000;
const issuancePerPeer = 20;
const issuancePeerCapacity = 256;

export function parsePasswordHash(value: string): { salt: Buffer; hash: Buffer } {
  if (!/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(value)) throw new Error('Invalid access protection configuration.');
  const [, salt, hash] = value.split('$');
  return { salt: Buffer.from(salt!, 'hex'), hash: Buffer.from(hash!, 'hex') };
}

interface Failure { count: number; next: number; expires: number }

export function createAuth(passwordHash: string, secure: boolean, store: SessionStore) {
  const password = parsePasswordHash(passwordHash);
  const failures = new Map<string, Failure>();
  // Direct socket peers only: forwarded headers are untrusted, proxies group users.
  const issuance = new Map<string, { count: number; expires: number }>();
  let verifications = 0;
  const prune = () => {
    const now = Date.now();
    for (const [key, value] of failures) if (value.expires <= now) failures.delete(key);
    for (const [key, value] of issuance) if (value.expires <= now) issuance.delete(key);
  };
  const cookieName = secure ? '__Host-fastagent' : 'fastagent-local';
  const cookieToken = (req: IncomingMessage): string | undefined => {
    const values = (req.headers.cookie ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${cookieName}=`));
    if (values.length !== 1) return;
    const value = values[0]!.slice(cookieName.length + 1);
    return /^[\w-]{43}$/.test(value) ? value : undefined;
  };
  const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); } catch { throw new SessionStoreUnavailable(); }
  };
  const get = async (req: IncomingMessage) => {
    prune();
    const raw = cookieToken(req);
    return raw ? safe(() => store.get(digest(raw))) : undefined;
  };
  const allowIssuance = (req: IncomingMessage) => {
    const key = digest(req.socket.remoteAddress ?? 'unknown');
    const bucket = issuance.get(key);
    if (bucket) {
      if (bucket.count >= issuancePerPeer) return false;
      bucket.count++;
    } else {
      if (issuance.size >= issuancePeerCapacity) return false;
      issuance.set(key, { count: 1, expires: Date.now() + issuanceWindow });
    }
    return true;
  };
  const setCookie = (res: ServerResponse, raw: string, lifetime: number) => {
    res.setHeader('Set-Cookie', `${cookieName}=${raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${lifetime / 1000}${secure ? '; Secure' : ''}`);
  };
  const issue = async (res: ServerResponse, replacing?: { hash: string; csrf: string }) => {
    const raw = token();
    const authenticated = !!replacing;
    const lifetime = authenticated ? sessionLifetime : anonymousLifetime;
    const session = { csrf: token(), authenticated, expires: Date.now() + lifetime };
    if (replacing) {
      if (!await safe(() => store.rotate(replacing.hash, replacing.csrf, digest(raw), session))) return undefined;
    } else await safe(() => store.issue(digest(raw), session));
    setCookie(res, raw, lifetime);
    return session;
  };
  const validCsrf = (req: IncomingMessage, session: Session | undefined) => {
    const value = req.headers['x-csrf-token'];
    if (!session || typeof value !== 'string' || !/^[\w-]{43}$/.test(value)) return false;
    return timingSafeEqual(Buffer.from(value), Buffer.from(session.csrf));
  };
  return {
    async session(req: IncomingMessage, res: ServerResponse) {
      const existing = await get(req);
      return existing ?? (allowIssuance(req) ? issue(res) : undefined);
    },
    async authorize(req: IncomingMessage) { const session = await get(req); return !!session?.authenticated && validCsrf(req, session); },
    async login(req: IncomingMessage, res: ServerResponse, candidate: string): Promise<Session | undefined> {
      const session = await get(req);
      if (!session || !validCsrf(req, session)) return undefined;
      prune();
      const key = digest(req.socket.remoteAddress ?? 'unknown');
      const failure = failures.get(key);
      if ((failure && failure.next > Date.now()) || verifications >= 2 || (!failure && failures.size >= 256)) return undefined;
      verifications++;
      let valid = false;
      try {
        const actual = await scrypt(candidate, password.salt, 64) as Buffer;
        valid = timingSafeEqual(actual, password.hash);
      } finally { verifications--; }
      if (!valid) {
        const count = Math.min((failure?.count ?? 0) + 1, 10);
        failures.set(key, { count, next: Date.now() + Math.min(60000, 500 * 2 ** (count - 1)), expires: Date.now() + 15 * 60 * 1000 });
        return undefined;
      }
      failures.delete(key);
      // CAS rotation rejects revocation, expiry, eviction or rotation while scrypt yielded.
      return issue(res, { hash: digest(cookieToken(req)!), csrf: session.csrf });
    },
    async logout(req: IncomingMessage, res: ServerResponse) {
      const session = await get(req);
      const raw = cookieToken(req);
      if (!raw || !validCsrf(req, session) || !session?.authenticated) return false;
      if (!await safe(() => store.revoke(digest(raw), session.csrf))) return false;
      setCookie(res, '', 0);
      return true;
    },
  };
}
