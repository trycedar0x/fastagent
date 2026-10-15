import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

// Provision at least 32 random bytes, encoded as base64url. Length alone cannot prove entropy.
export function validateApiToken(value: string): void {
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(value)) throw new Error('Invalid bearer token configuration.');
}
const digest = (value: string) => createHash('sha256').update(value).digest();

export function createAuth(apiToken: string) {
  validateApiToken(apiToken);
  const expected = digest(apiToken);
  return {
    authorize(req: IncomingMessage): boolean {
      // Duplicate authorization fields are rejected even when Node keeps only the first.
      let count = 0;
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]?.toLowerCase() === 'authorization') count++;
      const value = req.headers.authorization;
      const match = typeof value === 'string' && /^Bearer ([A-Za-z0-9_-]{43,256})$/i.exec(value);
      const actual = digest(match ? match[1]! : '');
      return timingSafeEqual(actual, expected) && !!match && count === 1;
    },
  };
}
