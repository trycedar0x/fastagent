import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfig, parseConfig, serializeConfig, validateConfig } from '../dist/config/config.js';

const valid = () => createConfig('weather-agent');

test('config: strict versioned YAML round-trip and configurable model metadata', () => {
  const config = { ...valid(), model: 'openrouter/~deepseek/deepseek-flash-latest' };
  assert.deepEqual(parseConfig(serializeConfig(config)), config);
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.deployment.access, 'token');
  assert.equal(valid().model, 'openrouter/deepseek/deepseek-v4.1-flash');
  const legacy = { schemaVersion: 1, name: 'weather-agent', framework: 'openai', model: 'openai/gpt-4o-mini', deployment: { access: 'protected' } };
  assert.deepEqual(parseConfig(serializeConfig(legacy)), legacy);
  assert.equal(parseConfig(serializeConfig(legacy)).deployment.access, 'protected');
});

test('config: rejects unsupported versions, frameworks, names, models and secret fields', () => {
  const invalid = [
    null, [], {},
    { ...valid(), schemaVersion: 2 },
    { ...valid(), framework: 'other' },
    { ...valid(), framework: 'ai-sdk' },
    { ...valid(), name: 'Uppercase' },
    { ...valid(), name: '-leading' },
    { ...valid(), name: 'trailing-' },
    { ...valid(), name: 'a'.repeat(64) },
    { ...valid(), model: '' },
    { ...valid(), model: '   ' },
    { ...valid(), model: 'a'.repeat(201) },
    { ...valid(), model: 'openrouter/https://evil.example/model' },
    { ...valid(), deployment: { access: 'token', note: 'rewrite' } },
    { ...valid(), model: 'model\0secret' },
    { ...valid(), deployment: { access: 'public' } },
    { schemaVersion: 1, name: 'weather-agent', framework: 'openai', model: 'openai/gpt-4o-mini', deployment: { access: 'protected', token: 'test-only-secret' } },
    { ...valid(), apiKey: 'test-only-secret' },
  ];
  for (const value of invalid) {
    assert.throws(() => validateConfig(value), (error) => {
      assert.equal(error.code, 'CONFIG_INVALID');
      assert.ok(!error.message.includes('test-only-secret'));
      return true;
    });
  }
});

test('config: invalid YAML, duplicate keys and aliases fail without leaking input', () => {
  for (const yaml of ['name: [test-only-secret', 'name: first\nname: second\n', 'x: &x [1]\ny: *x\n']) {
    assert.throws(() => parseConfig(yaml), (error) => {
      assert.equal(error.code, 'CONFIG_INVALID');
      assert.ok(!error.message.includes('test-only-secret'));
      return true;
    });
  }
});

test('config: name boundaries and explicit unsupported-framework error', () => {
  for (const name of ['a', '0', 'a-b', 'a'.repeat(63)]) assert.equal(createConfig(name).name, name);
  assert.throws(() => createConfig('valid', 'other'), { code: 'UNSUPPORTED_FRAMEWORK' });
  assert.throws(() => createConfig('bad/name'), { code: 'INVALID_NAME' });
});
