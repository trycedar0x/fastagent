import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createClient } from 'redis';
import { initProject } from '../dist/scaffold/init.js';

const port = process.env.FASTAGENT_TEST_REDIS_PORT;
const root = fileURLToPath(new URL('..', import.meta.url));
const id = () => randomBytes(32).toString('base64url');
const messages = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }];

test('redis-history-store: real Lua lease ownership, shared clients, single commit, TTL and capacity', {
  skip: !port && 'Run npm run test:redis with installed redis-server or a running Docker daemon and cached Redis image.',
}, async (t) => {
  assert.match(port, /^\d+$/);
  const url = `redis://:fastagent-local-integration-only@127.0.0.1:${port}`;
  const admin = createClient({ url, socket: { reconnectStrategy: false } });
  admin.on('error', () => {});
  t.after(() => { if (admin.isOpen) admin.destroy(); });
  await admin.connect();
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'fastagent-redis-history-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = (await initProject({ directory: 'agent', cwd: parent })).directory;
  await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const built = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc')], { cwd: directory, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const { createRedisHistoryStore } = await import(pathToFileURL(join(directory, 'dist/redis-history-store.js')));
  const history = await import(pathToFileURL(join(directory, 'dist/history-store.js')));
  const namespace = `test-${randomBytes(8).toString('hex')}`;
  const store = await createRedisHistoryStore(url, namespace, true);
  t.after(() => store.close());
  const conversationId = id();
  const owner = id();
  const other = id();
  assert.equal(await store.get(conversationId), undefined);
  assert.deepEqual(await store.acquire(conversationId, owner, true), []);
  await assert.rejects(store.acquire(conversationId, other, true), history.HistoryConflict);
  await assert.rejects(store.delete(conversationId), history.HistoryConflict);
  assert.equal(await store.commit(conversationId, other, messages), false);
  assert.equal(await store.commit(conversationId, owner, messages), true);
  assert.deepEqual(await store.get(conversationId), messages);
  // A peer client on the same namespace must observe committed history, and a committed lease must not
  // allow a second commit for the same turn.
  const peer = await createRedisHistoryStore(url, namespace, true);
  t.after(() => peer.close());
  assert.deepEqual(await peer.get(conversationId), messages, 'a second client sees committed history');
  assert.equal(await store.commit(conversationId, owner, messages), false, 'a committed turn cannot commit twice');
  const prefix = `fastagent:{${namespace}}:history:`;
  const ttl = await admin.pTTL(prefix + conversationId);
  assert.ok(ttl > history.historyLifetime - 60_000);
  await store.release(conversationId, owner);
  assert.equal(await store.delete(conversationId), true);
  assert.equal(await store.get(conversationId), undefined);
  assert.equal(await store.delete(conversationId), false);
  // Capacity counts both committed conversations and live reservations in the index.
  const capacityStore = await createRedisHistoryStore(url, `cap-${randomBytes(4).toString('hex')}`, true);
  t.after(() => capacityStore.close());
  for (let index = 0; index < history.historyCapacity; index++) await capacityStore.acquire(id(), id(), true);
  await assert.rejects(capacityStore.acquire(id(), id(), true), history.HistoryCapacityExceeded);
});
