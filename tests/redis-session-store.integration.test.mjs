import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createClient } from 'redis';
import { initProject } from '../dist/scaffold/init.js';

// Only scripts/test-redis.mjs supplies this port, for an isolated server with synthetic credentials.
// Normal npm test skips this suite: transport doubles are not a Redis/Lua evaluator.
const port = process.env.FASTAGENT_TEST_REDIS_PORT;
const root = fileURLToPath(new URL('..', import.meta.url));
const hash = () => randomBytes(32).toString('hex');
const session = (authenticated = false, lifetime = authenticated ? 3600000 : 300000) => ({
  csrf: randomBytes(32).toString('base64url'), authenticated, expires: Date.now() + lifetime,
});

test('redis-session-store: real Lua index consistency, expiry, capacity and auth', {
  skip: !port && 'Run npm run test:redis with installed redis-server or a running Docker daemon and cached Redis image.',
}, async t => {
  assert.match(port, /^\d+$/);
  const url = `redis://:fastagent-local-integration-only@127.0.0.1:${port}`;
  const admin = createClient({ url, socket: { reconnectStrategy: false } });
  admin.on('error', () => {});
  t.after(() => { if (admin.isOpen) admin.destroy(); });
  await admin.connect();
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'fastagent-redis-integration-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = (await initProject({ directory: 'agent', cwd: parent })).directory;
  await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const built = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc')], { cwd: directory, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const { createRedisSessionStore } = await import(pathToFileURL(join(directory, 'dist/redis-session-store.js')));
  const { createAuth } = await import(pathToFileURL(join(directory, 'dist/auth.js')));
  const { authenticatedCapacity, anonymousCapacity } = await import(pathToFileURL(join(directory, 'dist/session-store.js')));
  const fixture = async () => {
    const namespace = `test-${randomBytes(12).toString('hex')}`;
    const prefix = `fastagent:{${namespace}}:sessions:`;
    const store = await createRedisSessionStore(url, namespace, true);
    t.after(() => store.close());
    const other = await createRedisSessionStore(url, namespace, true);
    t.after(() => other.close());
    const issue = async (authenticated = false, lifetime) => {
      let id = hash();
      await store.issue(id, session());
      if (authenticated) {
        const replacement = hash();
        const old = await store.get(id);
        assert.equal(await store.rotate(id, old.csrf, replacement, session(true, lifetime)), true);
        id = replacement;
      }
      return { id, value: await store.get(id) };
    };
    return { store, other, issue, prefix, key: id => prefix + id,
      authenticated: prefix + 'authenticated', anonymous: prefix + 'anonymous' };
  };

  await t.test('independent lost authenticated/anonymous indexes invalidate only their own records', async () => {
    for (const kind of ['authenticated', 'anonymous']) {
      const f = await fixture();
      const active = await f.issue(true);
      const anonymous = await f.issue();
      await admin.del(f[kind]);
      const lost = kind === 'authenticated' ? active : anonymous;
      const retained = kind === 'authenticated' ? anonymous : active;
      assert.ok(await admin.get(f.key(lost.id)), 'record survives independent index deletion');
      assert.equal(await f.other.get(lost.id), undefined);
      assert.equal(await admin.get(f.key(lost.id)), null, 'orphan is deleted, not re-indexed');
      assert.deepEqual(await f.other.get(retained.id), retained.value);
      await f.issue(kind === 'authenticated');
      assert.equal(await f.store.get(lost.id), undefined, 'recreated index cannot resurrect old cookie');
    }
  });

  await t.test('orphan, wrong index, duplicate membership and mismatched score all fail closed', async () => {
    const f = await fixture();
    for (const op of ['get', 'rotate', 'revoke']) {
      for (const corruption of ['orphan', 'wrong-index', 'both-indexes', 'score']) {
        const old = await f.issue(true);
        if (corruption === 'orphan' || corruption === 'wrong-index') await admin.zRem(f.authenticated, f.key(old.id));
        if (corruption === 'wrong-index' || corruption === 'both-indexes') {
          await admin.zAdd(f.anonymous, { score: old.value.expires, value: f.key(old.id) });
        }
        if (corruption === 'score') await admin.zAdd(f.authenticated, { score: old.value.expires + 1, value: f.key(old.id) });
        const result = op === 'get' ? await f.store.get(old.id) : op === 'rotate'
          ? await f.store.rotate(old.id, old.value.csrf, hash(), session(true))
          : await f.store.revoke(old.id, old.value.csrf);
        assert.equal(result, op === 'get' ? undefined : false, `${op}: ${corruption}`);
        assert.equal(await admin.get(f.key(old.id)), null);
        assert.equal(await admin.zScore(f.authenticated, f.key(old.id)), null);
        assert.equal(await admin.zScore(f.anonymous, f.key(old.id)), null);
      }
    }
  });

  await t.test('get -> index loss -> rotate/revoke revalidates both session kinds atomically', async () => {
    const f = await fixture();
    for (const authenticated of [false, true]) {
      for (const op of ['rotate', 'revoke']) {
        const old = await f.issue(authenticated);
        assert.ok(await f.store.get(old.id));
        await admin.del(authenticated ? f.authenticated : f.anonymous);
        const replacement = hash();
        const result = op === 'rotate'
          ? await f.other.rotate(old.id, old.value.csrf, replacement, session(true))
          : await f.other.revoke(old.id, old.value.csrf);
        assert.equal(result, false);
        assert.equal(await admin.get(f.key(old.id)), null);
        assert.equal(await f.store.get(replacement), undefined);
      }
    }
  });

  await t.test('Redis TIME expiry boundaries and client clock skew cannot extend sessions or shorten index TTL', async () => {
    const f = await fixture();
    // Keep the record TTL alive while serialized expiry and score are at/before Redis TIME.
    for (const op of ['get', 'rotate', 'revoke']) {
      for (const offset of [0, -1]) {
        const id = hash();
        const value = session();
        await admin.eval(`
          local time = redis.call('TIME')
          local expires = time[1] * 1000 + math.floor(time[2] / 1000) + tonumber(ARGV[2])
          local value = cjson.decode(ARGV[1]); value.expires = expires
          redis.call('SET', KEYS[1], cjson.encode(value), 'PX', 60000)
          redis.call('ZADD', KEYS[2], expires, KEYS[1])
        `, { keys: [f.key(id), f.anonymous], arguments: [JSON.stringify(value), String(offset)] });
        const result = op === 'get' ? await f.store.get(id) : op === 'rotate'
          ? await f.store.rotate(id, value.csrf, hash(), session(true))
          : await f.store.revoke(id, value.csrf);
        assert.equal(result, op === 'get' ? undefined : false, `${op}: expiry <= Redis TIME (${offset})`);
        assert.equal(await admin.get(f.key(id)), null);
      }
    }
    const skewed = hash();
    await f.store.issue(skewed, session(false, 86400000));
    const normalized = await f.store.get(skewed);
    assert.ok(normalized);
    assert.ok(await admin.pTTL(f.key(skewed)) <= 300000, 'Redis caps fast client clock at anonymous lifetime');
    assert.equal(await admin.zScore(f.anonymous, f.key(skewed)), normalized.expires);
    const expired = hash();
    await f.store.issue(expired, session(false, -1));
    assert.equal(await f.store.get(expired), undefined, 'expired client deadline is not extended');
    const long = await f.issue(true);
    const short = await f.issue(true, 10000);
    assert.ok(await admin.pTTL(f.authenticated) > 3500000, 'short write must preserve long index deadline');
    assert.ok(await admin.pTTL(f.authenticated) >= await admin.pTTL(f.key(long.id)) - 50);
    assert.ok(await f.store.get(short.id));
    // Serialized deadline must agree even if the score alone still looks live.
    await admin.set(f.key(long.id), JSON.stringify({ ...long.value, expires: long.value.expires - 1 }), { PX: 60000 });
    assert.equal(await f.store.get(long.id), undefined);
  });

  await t.test('anonymous and authenticated capacities remain independent; full auth permits own rotation', async () => {
    const f = await fixture();
    const active = [];
    for (let i = 0; i < authenticatedCapacity; i++) active.push(await f.issue(true));
    const oldest = await f.issue();
    // ZSET members with tied deadlines sort by hash; give the oldest an earlier deadline.
    await new Promise(resolve => setTimeout(resolve, 5));
    let latest;
    for (let i = 0; i < anonymousCapacity; i++) latest = await f.issue();
    assert.equal(await f.store.get(oldest.id), undefined);
    assert.ok(await f.store.get(active[0].id));
    assert.equal(await admin.zCard(f.anonymous), anonymousCapacity);
    assert.equal(await admin.zCard(f.authenticated), authenticatedCapacity);
    assert.equal(await f.other.rotate(latest.id, latest.value.csrf, hash(), session(true)), false);
    assert.ok(await f.store.get(latest.id), 'capacity failure preserves pre-login record');
    const replacement = hash();
    assert.equal(await f.other.rotate(active[0].id, active[0].value.csrf, replacement, session(true)), true);
    assert.equal(await f.store.get(active[0].id), undefined);
    assert.equal(await admin.zCard(f.authenticated), authenticatedCapacity);
    assert.equal(await f.other.revoke(replacement, (await f.store.get(replacement)).csrf), true);
    assert.equal(await f.store.rotate(latest.id, latest.value.csrf, hash(), session(true)), true);
    // Reclaimed capacity cannot leave old authenticated orphans usable.
    await admin.del(f.authenticated);
    await f.issue(true);
    assert.equal(await f.other.get(active[1].id), undefined);
    assert.equal(await f.other.rotate(active[2].id, active[2].value.csrf, hash(), session(true)), false);
    assert.equal(await admin.zCard(f.authenticated), 1);
  });

  await t.test('real auth login, cross-instance authorization/logout and index loss during scrypt fail closed', async () => {
    const f = await fixture();
    const password = 'integration-test-only-password';
    const salt = randomBytes(16);
    const passwordHash = `scrypt-v1$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
    const auth = createAuth(passwordHash, false, f.store);
    const other = createAuth(passwordHash, false, f.other);
    let cookie;
    const req = { headers: {}, socket: { remoteAddress: 'test-peer' } };
    const res = { setHeader(name, value) { if (name === 'Set-Cookie') cookie = value.split(';')[0]; } };
    const update = value => { req.headers.cookie = cookie; req.headers['x-csrf-token'] = value.csrf; };
    update(await auth.session(req, res));
    const original = { headers: { ...req.headers }, socket: req.socket };
    update(await auth.login(req, res, password));
    assert.equal(await other.authorize(req), true);
    assert.equal(await other.authorize(original), false);
    assert.equal(await other.logout(req, res), true);
    assert.equal(await auth.authorize(req), false);
    for (const authenticated of [false, true]) {
      req.headers = {};
      update(await auth.session(req, res));
      if (authenticated) update(await auth.login(req, res, password));
      const id = createHash('sha256').update(cookie.split('=')[1]).digest('hex');
      const before = cookie;
      const racing = createAuth(passwordHash, false, {
        ...f.store,
        async rotate(...args) {
          // Runs after get/password verification, immediately before the CAS Lua command.
          await admin.del(authenticated ? f.authenticated : f.anonymous);
          return f.other.rotate(...args);
        },
      });
      assert.equal(await racing.login(req, res, password), undefined);
      assert.equal(cookie, before, 'rejected rotation sets no replacement cookie');
      assert.equal(await admin.get(f.key(id)), null);
      assert.equal(await other.authorize(req), false);
    }
  });
});
