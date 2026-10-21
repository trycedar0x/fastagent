import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { temporaryDirectory } from './helpers.mjs';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function cli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

function jsonResult(result, expectedStatus) {
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  return JSON.parse(result.stdout);
}

test('CLI: version and help work in text and JSON modes', async () => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(cli(['--version']).stdout, `${metadata.version}\n`);
  assert.deepEqual(jsonResult(cli(['--version', '--json']), 0), { ok: true, command: 'version', version: metadata.version });
  for (const args of [[], ['--help'], ['-h'], ['init', '--help']]) {
    const result = cli(args);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /fastagent init <directory>/);
    assert.ok(result.stdout.includes('fastagent dev [directory] [--install] [--json]'));
    assert.match(result.stdout, /init and dev are implemented/);
  }
  assert.equal(jsonResult(cli(['--help', '--json']), 0).command, 'help');
});

test('CLI: JSON init result and safe repeat failure', async (t) => {
  const cwd = await temporaryDirectory(t);
  const created = jsonResult(cli(['init', 'my-agent', '--name', 'explicit-name', '--framework', 'openai', '--json'], cwd), 0);
  assert.equal(created.ok, true);
  assert.equal(created.command, 'init');
  assert.equal(created.name, 'explicit-name');
  assert.equal(created.framework, 'openai');
  assert.equal(created.scaffoldStage, 'runnable');
  assert.ok(created.files.includes('fastagent.yaml'));
  const repeated = jsonResult(cli(['init', 'my-agent', '--json'], cwd), 1);
  assert.equal(repeated.ok, false);
  assert.equal(repeated.error.code, 'DESTINATION_EXISTS');
});

test('CLI: JSON errors, argument failures and unsupported frameworks are honest and sanitized', async (t) => {
  const cwd = await temporaryDirectory(t);
  const cases = [
    [['init', '--json'], 'INVALID_ARGUMENTS', 2],
    [['init', 'agent', 'extra', '--json'], 'INVALID_ARGUMENTS', 2],
    [['deploy', '--json'], 'INVALID_ARGUMENTS', 2],
    [['--json'], 'UNKNOWN_COMMAND', 2],
    [['init', 'agent', '--framework', 'test-only-secret', '--json'], 'UNSUPPORTED_FRAMEWORK', 2],
    [['init', 'agent', '--name', 'test-only-secret!', '--json'], 'INVALID_NAME', 2],
    [['init', 'agent', '--unknown=test-only-secret', '--json'], 'INVALID_ARGUMENTS', 2],
    [['init', 'agent', '--name', '--json'], 'INVALID_ARGUMENTS', 2],
    [['init', '../agent', '--json'], 'UNSAFE_PATH', 2],
    [['init', 'missing/agent', '--json'], 'PARENT_NOT_FOUND', 1],
  ];
  for (const [args, code, status] of cases) {
    const result = cli(args, cwd);
    const error = jsonResult(result, status);
    assert.equal(error.ok, false);
    assert.equal(error.error.code, code);
    assert.ok(!result.stdout.includes('test-only-secret'));
  }
  assert.deepEqual(await readdir(cwd), []);
});

test('CLI: init writes an ignored token but never prints it', async (t) => {
  const cwd = await temporaryDirectory(t);
  const result = cli(['init', 'agent', '--json'], cwd);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const token = (await readFile(join(cwd, 'agent', '.env.auth'), 'utf8')).trim().slice('FASTAGENT_API_TOKEN='.length);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!result.stdout.includes(token));
  assert.ok(!result.stderr.includes(token));
});

test('CLI: chat never reads stdin implicitly and fails fast when no message is given', async (t) => {
  const cwd = await temporaryDirectory(t);
  await writeFile(join(cwd, '.env.auth'), `FASTAGENT_API_TOKEN=${'a'.repeat(43)}\n`);
  // stdin is an open pipe that is never closed: an implicit read would block forever.
  const child = spawn(process.execPath, [cliPath, 'chat', '--url', 'https://example.invalid', '--env-file', '.env.auth', '--json'], {
    cwd, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const started = Date.now();
  const closed = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('chat hung waiting on stdin')), 5000);
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.ok(Date.now() - started < 5000, 'chat must not wait on stdin');
  assert.equal(closed.code, 2, stdout + stderr); assert.equal(closed.signal, null); assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).error.code, 'INVALID_ARGUMENTS');
  // Explicit --stdin (closed immediately) reads the pipe and reports an input error instead of hanging.
  const explicit = spawnSync(process.execPath, [cliPath, 'chat', '--url', 'https://example.invalid', '--env-file', '.env.auth', '--stdin', '--json'], { cwd, encoding: 'utf8', input: '', timeout: 5000 });
  assert.equal(explicit.status, 2, explicit.stdout + explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).error.code, 'CHAT_INPUT_INVALID');
});

test('CLI: text init identifies runnable runtime and text errors use stderr', async (t) => {
  const cwd = await temporaryDirectory(t);
  const result = cli(['init', 'agent'], cwd);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Generated an ignored .env.auth with a random bearer token/);
  const failure = cli(['init', 'agent'], cwd);
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, '');
  assert.match(failure.stderr, /DESTINATION_EXISTS/);
});
