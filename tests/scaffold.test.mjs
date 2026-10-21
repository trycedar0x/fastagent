import assert from 'node:assert/strict';
import fsPromises, { lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { createConfig, parseConfig } from '../dist/config/config.js';
import { initProject } from '../dist/scaffold/init.js';
import { openaiTemplate, renderProject } from '../dist/scaffold/render.js';
import { temporaryDirectory } from './helpers.mjs';

const renderedFiles = [...openaiTemplate.files, 'fastagent.yaml', 'package.json'].sort();
// init generates .env.auth at write time; it is intentionally not a render manifest entry.
const expectedFiles = [...renderedFiles, '.env.auth'].sort();
const expectedRootFiles = [...new Set(expectedFiles.map(path => path.split('/')[0]))].sort();

test('scaffold: deterministic rendering and template metadata boundary', async () => {
  const first = await renderProject(createConfig('weather-agent'));
  assert.deepEqual(first, await renderProject(createConfig('weather-agent')));
  assert.deepEqual(first.map((file) => file.path).sort(), renderedFiles);
  assert.equal(openaiTemplate.framework, 'openai');
  assert.equal(openaiTemplate.stage, 'runnable');
  const changed = await renderProject(createConfig('different-agent'));
  assert.deepEqual(first.filter((file) => !['package.json', 'fastagent.yaml'].includes(file.path)),
    changed.filter((file) => !['package.json', 'fastagent.yaml'].includes(file.path)));
});

test('scaffold: explicit name, standalone runnable metadata and nested runtime assets', async (t) => {
  const cwd = await temporaryDirectory(t);
  const result = await initProject({ directory: './Different Folder', name: 'weather-agent', framework: 'openai', cwd });
  assert.equal(result.directory, join(cwd, 'Different Folder'));
  assert.equal(result.name, 'weather-agent');
  assert.equal(result.scaffoldStage, 'runnable');
  assert.deepEqual((await readdir(result.directory)).sort(), expectedRootFiles);
  assert.deepEqual(result.files.slice().sort(), expectedFiles);
  const config = parseConfig(await readFile(join(result.directory, 'fastagent.yaml'), 'utf8'));
  assert.equal(config.name, 'weather-agent');
  const metadata = JSON.parse(await readFile(join(result.directory, 'package.json'), 'utf8'));
  assert.equal(metadata.name, config.name);
  assert.equal(metadata.type, 'module');
  assert.equal(metadata.engines.node, '>=22');
  assert.equal(metadata.private, true);
  assert.equal(metadata.scripts.build, 'tsc');
  assert.equal(metadata.dependencies.openai, '^6.9.0');
  assert.equal(metadata.dependencies.ai, undefined);
  assert.equal(metadata.dependencies['@ai-sdk/openai'], undefined);
  assert.equal(metadata.dependencies.redis, '^6.3.0');
  for (const path of expectedFiles) assert.equal((await lstat(join(result.directory, path))).isFile(), true);
  const readme = await readFile(join(result.directory, 'README.md'), 'utf8');
  assert.match(readme, /runnable Node.js 22/);
  assert.match(readme, /not a cloud deployment integration/);
  assert.ok(readme.includes('Omitting `--conversation` starts a new conversation on every call.'));
  assert.ok(readme.includes('`conversation: <id>`'));
  assert.ok(readme.includes('`conversationId` field with `--json`'));
  assert.ok(readme.includes('--conversation "<id-from-first-response>" --message'));
  assert.ok(readme.includes('Local development and ephemeral production history are lost on restart'));
  assert.equal((readme.match(/node \/path\/to\/fastagent\/dist\/cli\.js dev/g) ?? []).length, 1);
  assert.ok(readme.includes('Existing inherited environment variables take precedence'));
  assert.ok(readme.includes('The CLI `chat` client reads its bearer token only from the explicit'));
  assert.ok(readme.includes("If that value differs from the client's file, chat authentication fails."));
  assert.ok(readme.includes('Replace the sample temperature-conversion instructions'));
  assert.ok(readme.includes('maxOutputTokens: 8192'));
});

test('scaffold: init generates an ignored owner-only bearer token that is never overwritten', async (t) => {
  const cwd = await temporaryDirectory(t);
  const result = await initProject({ directory: 'agent', cwd });
  const authPath = join(result.directory, '.env.auth');
  const content = await readFile(authPath, 'utf8');
  const match = /^FASTAGENT_API_TOKEN=([A-Za-z0-9_-]{43})\n$/.exec(content);
  assert.ok(match, 'auth file holds one base64url token');
  assert.equal(Buffer.from(match[1], 'base64url').length, 32);
  assert.equal((await lstat(authPath)).mode & 0o777, 0o600);
  assert.ok(result.files.includes('.env.auth'));
  assert.ok((await readFile(join(result.directory, '.gitignore'), 'utf8')).split('\n').includes('.env.*'));
  assert.ok((await readFile(join(result.directory, '.dockerignore'), 'utf8')).includes('.env.*'));
  // The token must never appear in the structured result.
  assert.ok(!JSON.stringify(result).includes(match[1]));
  // A repeat init refuses the existing directory and leaves the generated token untouched.
  await assert.rejects(initProject({ directory: 'agent', cwd }), { code: 'DESTINATION_EXISTS' });
  assert.equal(await readFile(authPath, 'utf8'), content);
});

test('scaffold: blank environment placeholders and local/container secret exclusions', async (t) => {
  const cwd = await temporaryDirectory(t);
  const result = await initProject({ directory: 'agent', cwd });
  const example = await readFile(join(result.directory, '.env.example'), 'utf8');
  assert.deepEqual(example.split('\n').filter((line) => line && !line.startsWith('#')), ['OPENROUTER_API_KEY=', 'FASTAGENT_API_TOKEN=', 'APP_ORIGIN=', 'REDIS_URL=']);
  for (const file of ['.gitignore', '.dockerignore']) {
    const lines = (await readFile(join(result.directory, file), 'utf8')).split('\n');
    for (const pattern of ['.env', '.env.*', '!.env.example', '*.pem', '*.key', 'credentials*.json']) {
      assert.ok(lines.includes(pattern), `${file} excludes ${pattern}`);
    }
  }
  assert.ok((await readFile(join(result.directory, '.dockerignore'), 'utf8')).includes('**/.env.*'));
  for (const path of result.files) assert.ok(!(await readFile(join(result.directory, path), 'utf8')).includes('test-only-secret'));
});

test('scaffold: refuses existing empty/nonempty directories and files without mutation', async (t) => {
  const cwd = await temporaryDirectory(t);
  await mkdir(join(cwd, 'empty'));
  await mkdir(join(cwd, 'full'));
  await writeFile(join(cwd, 'full', 'sentinel'), 'keep me');
  await writeFile(join(cwd, 'file'), 'keep file');
  for (const directory of ['empty', 'full', 'file']) {
    await assert.rejects(initProject({ directory, cwd }), { code: 'DESTINATION_EXISTS' });
  }
  assert.deepEqual(await readdir(join(cwd, 'empty')), []);
  assert.deepEqual(await readdir(join(cwd, 'full')), ['sentinel']);
  assert.equal(await readFile(join(cwd, 'full', 'sentinel'), 'utf8'), 'keep me');
  assert.equal(await readFile(join(cwd, 'file'), 'utf8'), 'keep file');
});

test('scaffold: refuses destination symlinks, dangling symlinks and symlink ancestors', async (t) => {
  const cwd = await temporaryDirectory(t);
  const external = await temporaryDirectory(t);
  await writeFile(join(external, 'sentinel'), 'external remains');
  await symlink(external, join(cwd, 'link'), 'dir');
  await symlink(join(cwd, 'nonexistent'), join(cwd, 'dangling'), 'dir');
  for (const directory of ['link', 'dangling']) {
    await assert.rejects(initProject({ directory, cwd }), { code: 'DESTINATION_EXISTS' });
    assert.equal((await lstat(join(cwd, directory))).isSymbolicLink(), true);
  }
  await assert.rejects(initProject({ directory: 'link/new-agent', cwd }), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await readdir(external), ['sentinel']);
  assert.equal(await readFile(join(external, 'sentinel'), 'utf8'), 'external remains');
});

test('scaffold: invalid paths, missing parents and invalid inputs create nothing', async (t) => {
  const cwd = await temporaryDirectory(t);
  for (const directory of ['', '  ', '../outside', 'sub/../outside', 'bad\0path', 'bad\\path', '/']) {
    await assert.rejects(initProject({ directory, name: 'agent', cwd }), { code: 'UNSAFE_PATH' });
  }
  await assert.rejects(initProject({ directory: 'missing/agent', cwd }), { code: 'PARENT_NOT_FOUND' });
  await assert.rejects(initProject({ directory: 'agent', framework: 'other', cwd }), { code: 'UNSUPPORTED_FRAMEWORK' });
  await assert.rejects(initProject({ directory: 'Uppercase', cwd }), { code: 'INVALID_NAME' });
  assert.deepEqual(await readdir(cwd), []);
});

test('scaffold: init repeat is non-overwriting and default name is basename', async (t) => {
  const cwd = await temporaryDirectory(t);
  const result = await initProject({ directory: 'my-agent', cwd });
  assert.equal(result.name, 'my-agent');
  await writeFile(join(result.directory, 'fastagent.yaml'), 'user edit');
  await assert.rejects(initProject({ directory: 'my-agent', cwd }), { code: 'DESTINATION_EXISTS' });
  assert.equal(await readFile(join(result.directory, 'fastagent.yaml'), 'utf8'), 'user edit');
});

test('scaffold: failure in nested output cleans only known files and created empty directories', async (t) => {
  const cwd = await temporaryDirectory(t);
  const original = fsPromises.writeFile;
  t.mock.method(fsPromises, 'writeFile', async (path, content, options) => {
    if (String(path).endsWith('/src/server.ts')) throw new Error('injected write failure');
    return original(path, content, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(initProject({ directory: 'agent', cwd }), { code: 'SCAFFOLD_FAILED' });
  assert.deepEqual(await readdir(cwd), []);
});

test('scaffold: failed nested output preserves unrelated files instead of recursive cleanup', async (t) => {
  const cwd = await temporaryDirectory(t);
  const original = fsPromises.writeFile;
  t.mock.method(fsPromises, 'writeFile', async (path, content, options) => {
    if (String(path).endsWith('/src/server.ts')) {
      await original(join(cwd, 'agent', 'src', 'sentinel'), 'keep this file');
      throw new Error('injected write failure');
    }
    return original(path, content, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(initProject({ directory: 'agent', cwd }), { code: 'SCAFFOLD_FAILED' });
  assert.deepEqual(await readdir(join(cwd, 'agent')), ['src']);
  assert.deepEqual(await readdir(join(cwd, 'agent', 'src')), ['sentinel']);
  assert.equal(await readFile(join(cwd, 'agent', 'src', 'sentinel'), 'utf8'), 'keep this file');
});

test('scaffold: injected nested-parent symlink is refused and cleanup never follows it', async (t) => {
  const cwd = await temporaryDirectory(t);
  const external = await temporaryDirectory(t);
  await writeFile(join(external, 'agent.ts'), 'external file must survive');
  const original = fsPromises.writeFile;
  t.mock.method(fsPromises, 'writeFile', async (path, content, options) => {
    if (String(path).endsWith('/src/main.ts')) {
      await original(path, content, options);
      await rename(join(cwd, 'agent', 'src'), join(cwd, 'agent', 'saved-src'));
      await symlink(external, join(cwd, 'agent', 'src'), 'dir');
      return;
    }
    return original(path, content, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(initProject({ directory: 'agent', cwd }), { code: 'SCAFFOLD_FAILED' });
  assert.equal(await readFile(join(external, 'agent.ts'), 'utf8'), 'external file must survive');
  assert.deepEqual(await readdir(external), ['agent.ts']);
  assert.equal((await lstat(join(cwd, 'agent', 'src'))).isSymbolicLink(), true);
});
