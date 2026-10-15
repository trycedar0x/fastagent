// Opt-in real Lua validation. Starts only an installed redis-server or a cached Docker Redis image.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';

const password = 'fastagent-local-integration-only';
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error?.message || 'unavailable'}`);
  return result.stdout.trim();
};
let server;
let container;
let directory;
try {
  let port;
  if (spawnSync('redis-server', ['--version'], { encoding: 'utf8' }).status === 0) {
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    directory = await mkdtemp(join(tmpdir(), 'fastagent-redis-'));
    server = spawn('redis-server', ['--bind', '127.0.0.1', '--port', String(port), '--save', '',
      '--appendonly', 'no', '--requirepass', password, '--dir', directory], { stdio: 'ignore' });
  } else {
    run('docker', ['info', '--format', '{{.ServerVersion}}']);
    const image = run('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'])
      .split('\n').find(value => /^redis:[^<]+$/.test(value));
    if (!image) throw new Error('No cached Redis image; integration unavailable (no image will be pulled).');
    container = `fastagent-redis-test-${randomUUID()}`;
    run('docker', ['run', '--detach', '--pull=never', '--name', container, '--publish', '127.0.0.1::6379',
      image, 'redis-server', '--save', '', '--appendonly', 'no', '--requirepass', password]);
    port = Number(run('docker', ['port', container, '6379/tcp']).match(/^127\.0\.0\.1:(\d+)$/)?.[1]);
    if (!port) throw new Error('Redis container did not bind exclusively to loopback.');
  }
  const deadline = Date.now() + 5000;
  let ready = false;
  while (Date.now() < deadline) {
    const client = createClient({ url: `redis://:${password}@127.0.0.1:${port}`,
      socket: { reconnectStrategy: false, connectTimeout: 250 } });
    client.on('error', () => {});
    try { await client.connect(); await client.ping(); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    finally { if (client.isOpen) client.destroy(); }
  }
  if (!ready) throw new Error('Isolated local Redis failed to become ready.');
  run('npm', ['run', 'build']);
  const tests = spawnSync(process.execPath, ['--test', 'tests/redis-history-store.integration.test.mjs'], {
    stdio: 'inherit', env: { ...process.env, FASTAGENT_TEST_REDIS_PORT: String(port) }, timeout: 120000,
  });
  process.exitCode = tests.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) {
    const stopped = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await stopped;
  }
  if (container) spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore', timeout: 15000 });
  if (directory) await rm(directory, { recursive: true, force: true });
}
