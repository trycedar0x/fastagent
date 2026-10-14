import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openaiTemplate } from '../dist/scaffold/render.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('package: executable and all template assets survive npm packing', () => {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const [packed] = JSON.parse(result.stdout);
  assert.equal(packed.name, '@0xtryeva/fastagent');
  const paths = packed.files.map((file) => file.path);
  for (const path of ['dist/cli.js', 'package.json', 'LICENSE', 'docs/diagrams/workflow.svg',
    'templates/openai/.dockerignore',
    'templates/openai/.env.example', 'templates/openai/gitignore.template',
    'templates/openai/AGENTS.md', 'templates/openai/README.md',
    ...openaiTemplate.files.filter(path => path !== '.gitignore').map(path => `templates/openai/${path}`)]) {
    assert.ok(paths.includes(path), `${path} is packaged`);
  }
  assert.ok(!paths.some((path) => path.startsWith('node_modules/') || path === '.env' || path === '.npmrc'));
  assert.ok(packed.files.find((file) => file.path === 'dist/cli.js').mode & 0o111);
});
