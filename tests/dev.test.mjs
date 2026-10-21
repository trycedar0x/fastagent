import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { readdir, symlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { initProject } from '../dist/scaffold/init.js';
import { devProject } from '../dist/dev/dev.js';
import { temporaryDirectory } from './helpers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist/cli.js');

test('dev/CLI: --json refuses an invalid project with a parseable error and no premature success', async t => {
  const cwd = await temporaryDirectory(t);
  const result = spawnSync(process.execPath, [cli, 'dev', '--json'], { cwd, encoding: 'utf8' });
  // dev is a foreground server, so --json is accepted and readiness is announced only after listening.
  // An invalid project must still fail fast with a machine-readable code.
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'DEV_INVALID_PROJECT');
  assert.deepEqual(await readdir(cwd), []);
});

test('dev: no automatic installation, clear errors for missing project/dependencies', async t => {
  const cwd = await temporaryDirectory(t);
  await assert.rejects(devProject({ cwd }), { code: 'DEV_INVALID_PROJECT' });
  const project = await initProject({ directory: 'agent', cwd });
  await assert.rejects(devProject({ directory: project.directory }), { code: 'DEV_DEPENDENCIES_MISSING' });
  assert.ok(!(await readdir(project.directory)).includes('node_modules'));
});

test('dev: install requires opt-in and all launches use argument arrays without shell', async t => {
  const cwd = await temporaryDirectory(t);
  const project = await initProject({ directory: 'agent', cwd });
  await symlink(join(root, 'node_modules'), join(project.directory, 'node_modules'), 'dir');
  const calls = [];
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter(); child.kill = () => true;
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(await devProject({ directory: project.directory, install: true }), 0);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args, ['install', '--ignore-scripts']);
  assert.equal(calls[1].command, process.execPath);
  assert.deepEqual(calls[2].args, ['--env-file-if-exists=.env', '--env-file-if-exists=.env.auth', 'dist/main.js']);
  assert.equal(calls[2].options.env.FASTAGENT_LOCAL_DEV, '1');
  assert.ok(calls.every(call => call.options.shell === false && call.options.cwd === project.directory));
});

test('dev/CLI: generated app announces readiness after listening and SIGTERM shuts child down', async t => {
  const cwd = await temporaryDirectory(t);
  const project = await initProject({ directory: 'agent', cwd });
  await symlink(join(root, 'node_modules'), join(project.directory, 'node_modules'), 'dir');
  const probe = createServer();
  // Guard the probe so a failure before its explicit close cannot leak a listening handle.
  t.after(() => new Promise(resolve => { if (probe.listening) probe.close(() => resolve()); else resolve(); }));
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const apiToken = randomBytes(32).toString('base64url');
  const child = spawn(process.execPath, [cli, 'dev', project.directory], { cwd, env: { PATH: process.env.PATH, PORT: String(port), FASTAGENT_API_TOKEN: apiToken, OPENROUTER_API_KEY: 'synthetic-not-used-for-health' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = ''; let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`readiness timeout: ${stdout} ${stderr}`)), 10000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.includes('Headless chat service ready.')) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`early exit ${code}: ${stderr}`)); });
  });
  assert.equal(stdout, 'Headless chat service ready.\n');
  assert.ok(!stdout.includes(apiToken) && !stderr.includes(apiToken));
  const health = await fetch(`http://127.0.0.1:${port}/healthz`); assert.deepEqual(await health.json(), { ok: true });
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/session`)).status, 404);
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const [code] = await exited; assert.equal(code, 0);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
});
