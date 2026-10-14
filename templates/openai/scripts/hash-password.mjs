import { randomBytes, scryptSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

// Interactive hidden input; write only the salted hash to an ignored, exclusive file.
if (!process.stdin.isTTY || !process.stdin.setRawMode) {
  process.stderr.write('Run this helper in an interactive terminal.\n'); process.exit(1);
}
process.stdout.write('New access password (12–256 characters): ');
process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.resume();
let password = '';
process.stdin.on('data', async chunk => {
  for (const character of chunk) {
    if (character === '\u0003') { process.stdin.setRawMode(false); process.exit(130); }
    if (character === '\r' || character === '\n') {
      process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n');
      if (password.length < 12 || password.length > 256) { process.stderr.write('Password must be 12–256 characters.\n'); process.exitCode = 1; return; }
      const salt = randomBytes(16);
      const hash = scryptSync(password, salt, 64);
      password = '';
      try {
        await writeFile('.env.auth', `FASTAGENT_PASSWORD_HASH=scrypt-v1$${salt.toString('hex')}$${hash.toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
        process.stdout.write('Created .env.auth (hash only). Never commit or upload it.\n');
      } catch { process.stderr.write('Could not create .env.auth; existing files are not overwritten.\n'); process.exitCode = 1; }
      return;
    }
    if (character === '\u007f' || character === '\b') password = password.slice(0, -1);
    else if (character >= ' ' && password.length <= 256) password += character;
  }
});
