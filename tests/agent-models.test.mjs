import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { before, after } from 'node:test';
import { initProject } from '../dist/scaffold/init.js';

const root = fileURLToPath(new URL('..', import.meta.url));
let parent, agent, tools;
before(async () => {
  parent = await realpath(await mkdtemp(join(tmpdir(), 'fastagent-agent-models-')));
  const { directory } = await initProject({ directory: 'agent', cwd: parent });
  await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  for (const args of [['--noEmit'], []]) {
    const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), ...args], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  agent = await import(pathToFileURL(join(directory, 'dist/agent.js')));
  ({ tools } = await import(pathToFileURL(join(directory, 'dist/tools.js'))));
});
after(async () => { if (parent) await rm(parent, { recursive: true, force: true }); });

const chunk = (delta, finish_reason = null) => ({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason }] });
const sse = (chunks, done = true) => new Response(chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''), { headers: { 'Content-Type': 'text/event-stream' } });
const call = (changes = {}) => ({ messages: [{ role: 'user', content: 'Hi' }], maxOutputTokens: 321, abortSignal: new AbortController().signal, tools: Object.values(tools), ...changes });
const collect = async (model, invocation = call()) => { const parts = []; for await (const part of model.stream(invocation)) parts.push(part); return parts; };
function modelFor(chunks, identifier = 'openrouter/deepseek/deepseek-v4.1-flash') {
  return agent.createModel(identifier, 'synthetic-test-key', { fetch: async () => sse(chunks) });
}
function byteStream(text, stride = 1, hooks = {}) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      hooks.pull?.();
      if (offset === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + stride)); offset = Math.min(offset + stride, bytes.length);
    },
    cancel() { hooks.cancel?.(); },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('agent/model references: fixed provider URL and correct key metadata, no arbitrary providers', () => {
  assert.deepEqual(agent.resolveModelReference('openrouter/vendor/arbitrary-model:free'), {
    provider: 'openrouter', model: 'vendor/arbitrary-model:free', apiKeyEnv: 'OPENROUTER_API_KEY', baseURL: 'https://openrouter.ai/api/v1',
  });
  assert.equal(agent.modelName('openai/gpt-4o-mini'), 'gpt-4o-mini');
  assert.equal(agent.selectModelApiKey('openrouter/vendor/model', { OPENAI_API_KEY: 'direct', OPENROUTER_API_KEY: 'router' }), 'router');
  assert.equal(agent.selectModelApiKey('openai/gpt-4o-mini', { OPENAI_API_KEY: 'direct', OPENROUTER_API_KEY: 'router' }), 'direct');
  assert.equal(agent.selectModelApiKey('openrouter/vendor/model', { OPENAI_API_KEY: 'direct' }), undefined);
  assert.equal(agent.createModel('openrouter/vendor/model', ' '), undefined);
  assert.equal(agent.resolveModelReference('openrouter/~deepseek/deepseek-flash-latest').model, '~deepseek/deepseek-flash-latest');
  assert.equal(agent.resolveModelReference('openrouter/~deepseek/deepseek-flash-latest').baseURL, 'https://openrouter.ai/api/v1');
  assert.notEqual(agent.resolveModelReference('openrouter/~deepseek/deepseek-flash-latest').model, 'deepseek/deepseek-v4.1-flash');
  for (const reference of ['other/synthetic-secret', 'openrouter/model', 'openrouter/vendor/model/extra', 'openrouter/../model', 'openrouter/vendor/model?key=synthetic-secret', 'openai/vendor/model']) {
    assert.throws(() => agent.createModel(reference, undefined), (error) => /Unsupported model provider/.test(error.message) && !error.message.includes('synthetic-secret'));
  }
});

test('agent/OpenRouter SDK HTTP: fixed path, bearer header, max_tokens and tool-capable provider routing', async () => {
  let request;
  const model = agent.createModel('openrouter/vendor/model', 'synthetic-test-key', { fetch: async (url, init) => {
    request = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
    return sse([chunk({ content: 'hello' }), chunk({}, 'stop')]);
  } });
  assert.deepEqual(await collect(model), [{ type: 'text-delta', text: 'hello' }]);
  assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(request.headers.get('authorization'), 'Bearer synthetic-test-key');
  assert.equal(request.body.model, 'vendor/model'); assert.equal(request.body.max_tokens, 321);
  assert.equal(request.body.max_completion_tokens, undefined); assert.deepEqual(request.body.provider, { require_parameters: true });
  assert.equal(request.body.tools[0].type, 'function'); assert.equal(request.body.stream, true);
});

test('agent/direct OpenAI SDK HTTP: original path and completion token parameter; no router parameters', async () => {
  let request;
  const model = agent.createModel('openai/gpt-4o-mini', 'synthetic-test-key', { fetch: async (url, init) => {
    request = { url: String(url), body: JSON.parse(init.body) }; return sse([chunk({ content: 'OK' }), chunk({}, 'stop')]);
  } });
  assert.deepEqual(await collect(model), [{ type: 'text-delta', text: 'OK' }]);
  assert.equal(request.url, 'https://api.openai.com/v1/chat/completions'); assert.equal(request.body.model, 'gpt-4o-mini');
  assert.equal(request.body.max_completion_tokens, 321); assert.equal(request.body.max_tokens, undefined); assert.equal(request.body.provider, undefined);
  let body;
  const router = agent.createModel('openrouter/vendor/model', 'synthetic-test-key', { fetch: async (_url, init) => { body = JSON.parse(init.body); return sse([chunk({}, 'stop')]); } });
  await collect(router, call({ tools: [] })); assert.equal(body.tools, undefined); assert.equal(body.provider, undefined);
});

test('agent/OpenRouter SDK stream: fragmented tool calls and tool history use official API format', async () => {
  const tool = Object.values(tools)[0];
  const parts = await collect(modelFor([
    chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: tool.name, arguments: '{' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }), chunk({}, 'tool_calls'),
  ]));
  assert.deepEqual(parts, [{ type: 'tool-call', toolCallId: 'call_1', toolName: tool.name, input: '{}' }]);
  let body;
  const model = agent.createModel('openrouter/vendor/model', 'synthetic-test-key', { fetch: async (_url, init) => { body = JSON.parse(init.body); return sse([chunk({}, 'stop')]); } });
  await collect(model, call({ messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: tool.name, input: '{}' }] }, { role: 'tool', toolCallId: 'call_1', content: '{}' }] }));
  assert.equal(body.messages[0].tool_calls[0].function.name, tool.name); assert.equal(body.messages[1].tool_call_id, 'call_1');
});

test('agent/SDK errors: failed finishes, in-stream errors and missing completion are sanitized failures', async (t) => {
  const logs = [];
  for (const method of ['error', 'warn', 'log', 'info', 'debug']) t.mock.method(console, method, (...args) => logs.push(args));
  for (const chunks of [
    [chunk({ content: 'partial' }), chunk({}, 'length')], [chunk({}, 'content_filter')],
    [chunk({}, 'error')], [chunk({ content: 'partial' }), { error: { message: 'synthetic-secret', code: 500 } }],
    [chunk({ content: 'partial' })], [], [chunk({}, 'tool_calls')],
    [chunk({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }), chunk({}, 'tool_calls')],
    [chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'test', arguments: '{}' } }] }), chunk({}, 'stop')],
  ]) {
    const parts = await collect(modelFor(chunks)); assert.deepEqual(parts.at(-1), { type: 'error' });
    assert.ok(!JSON.stringify(parts).includes('synthetic-secret'));
  }
  let requests = 0;
  const model = agent.createModel('openrouter/vendor/model', 'synthetic-test-key', { fetch: async () => { requests++; return new Response(JSON.stringify({ error: { message: 'synthetic-secret' } }), { status: 503, headers: { 'Content-Type': 'application/json' } }); } });
  assert.deepEqual(await collect(model), [{ type: 'error' }]); assert.equal(requests, 1);
  const truncated = agent.createModel('openrouter/vendor/model', 'synthetic-test-key', { fetch: async () => new Response('data: {broken-synthetic-secret}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) });
  assert.deepEqual(await collect(truncated), [{ type: 'error' }]); assert.deepEqual(logs, []);
});

test('agent/SDK completion: empty, whitespace-only and reasoning-only replies fail; visible text succeeds', async () => {
  for (const identifier of ['openrouter/deepseek/deepseek-v4.1-flash', 'openai/gpt-4o-mini']) {
    for (const delta of [
      {}, { content: '' }, { content: ' \t\n' },
      { reasoning: 'internal-canary', reasoning_content: 'internal-canary', reasoning_details: [{ text: 'internal-canary' }] },
      { content: ' \t', reasoning: 'internal-canary' },
    ]) {
      const parts = await collect(modelFor([chunk(delta), chunk({}, 'stop')], identifier));
      assert.deepEqual(parts.at(-1), { type: 'error' });
      assert.ok(!JSON.stringify(parts).includes('internal-canary'));
    }
    const parts = await collect(modelFor([
      chunk({ reasoning: 'internal-canary' }), chunk({ content: ' ' }),
      chunk({ content: 'Visible answer', reasoning_content: 'internal-canary' }), chunk({}, 'stop'),
    ], identifier));
    assert.deepEqual(parts, [{ type: 'text-delta', text: ' ' }, { type: 'text-delta', text: 'Visible answer' }]);
  }
});

test('agent/SDK reasoning: tool-only turns stay valid; internal reasoning never enters reply or history', async () => {
  const tool = Object.values(tools)[0];
  const requests = [];
  const model = agent.createModel('openrouter/deepseek/deepseek-v4.1-flash', 'synthetic-test-key', { fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return requests.length === 1 ? sse([
      chunk({ reasoning: 'internal-canary', reasoning_details: [{ text: 'internal-canary' }] }),
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: tool.name, arguments: '{"value":0,"from":"C"}' } }] }),
      chunk({}, 'tool_calls'),
    ]) : sse([chunk({ content: '32 F', reasoning_content: 'internal-canary' }), chunk({}, 'stop')]);
  } });
  const parts = [];
  for await (const part of agent.streamAgent(model, [{ role: 'user', content: 'Convert 0 C' }], new AbortController().signal)) parts.push(part);
  assert.deepEqual(parts, [{ type: 'text-delta', text: '32 F' }]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-1).role, 'tool');
  assert.ok(!JSON.stringify(requests).includes('internal-canary'));
  for (const toolCalls of [
    [{ index: 0, function: { arguments: '{' } }],
    [{ index: 0, id: 'call_1', function: { arguments: '{}' } }],
    [{ index: 0, function: { name: tool.name, arguments: '{}' } }],
  ]) {
    assert.deepEqual(await collect(modelFor([chunk({ reasoning: 'internal-canary', tool_calls: toolCalls }), chunk({}, 'tool_calls')])), [{ type: 'error' }]);
  }
  for (const input of ['{', '', '{"value":0,']) {
    const malformed = modelFor([
      chunk({ reasoning: 'internal-canary', tool_calls: [{ index: 0, id: 'call_1', function: { name: tool.name, arguments: input } }] }),
      chunk({}, 'tool_calls'),
    ]);
    const failedParts = [];
    for await (const part of agent.streamAgent(malformed, [{ role: 'user', content: 'Hi' }], new AbortController().signal)) failedParts.push(part);
    assert.deepEqual(failedParts, [{ type: 'tool-error' }]);
  }
});

test('agent/SDK cancellation: pre-abort skips request, cancellation after delta aborts stream', async () => {
  const controller = new AbortController(); controller.abort();
  let requests = 0;
  const model = agent.createModel('openrouter/vendor/model', 'synthetic-test-key', { fetch: async () => { requests++; return sse([chunk({}, 'stop')]); } });
  assert.deepEqual(await collect(model, call({ abortSignal: controller.signal })), [{ type: 'abort' }]); assert.equal(requests, 0);
  const mid = new AbortController(); const parts = [];
  for await (const part of modelFor([chunk({ content: 'partial' }), chunk({}, 'stop')]).stream(call({ abortSignal: mid.signal }))) { parts.push(part); if (part.type === 'text-delta') mid.abort(); }
  assert.deepEqual(parts, [{ type: 'text-delta', text: 'partial' }, { type: 'abort' }]);
  const waiting = new AbortController();
  const aborted = agent.createModel('openrouter/vendor/model', 'synthetic-test-key', { fetch: async () => { waiting.abort(); const error = new Error('synthetic-secret'); error.name = 'AbortError'; throw error; } });
  assert.deepEqual(await collect(aborted, call({ abortSignal: waiting.signal })), [{ type: 'abort' }]);
});

test('agent/streamAgent: the complete request stays within the approved context bounds', async () => {
  const calls = [];
  const model = { calls, async *stream(call) { calls.push(call); yield { type: 'text-delta', text: 'x' }; } };
  const size = messages => messages.reduce((total, message) =>
    total + message.content.length + (message.toolCalls ?? []).reduce((n, call) => n + call.input.length, 0), 0);

  // A long slice is trimmed to fit the bound rather than sent whole. Turns are uniquely identified and
  // the slice ends with the current user message, so preserving it is actually provable.
  const longSlice = Array.from({ length: 41 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'turn-' + index }));
  const parts = [];
  for await (const part of agent.streamAgent(model, longSlice, new AbortController().signal)) parts.push(part);
  assert.deepEqual(parts, [{ type: 'text-delta', text: 'x' }]);
  assert.equal(calls.length, 1);
  const request = calls[0].messages;
  assert.equal(request[0].role, 'system', 'the system prompt counts against the bound');
  assert.equal(request.at(-1).content, 'turn-40', 'the current user message is preserved');
  assert.ok(request.every(message => message.content !== 'turn-0'), 'the oldest whole turn is dropped first');
  assert.ok(request.length <= 20, 'request is bounded to 20 messages, saw ' + request.length);
  assert.ok(size(request) <= 16000, 'request is bounded to 16000 characters, saw ' + size(request));

  // Characters, not just message count, drive trimming: a pair too large to keep is dropped while the
  // current user message survives, because the character budget is what the bound protects.
  const charHeavy = [
    { role: 'user', content: 'a'.repeat(9000) },
    { role: 'assistant', content: 'b'.repeat(9000) },
    { role: 'user', content: 'current-question' },
  ];
  const trimmed = [];
  for await (const part of agent.streamAgent(model, charHeavy, new AbortController().signal)) trimmed.push(part);
  assert.deepEqual(trimmed, [{ type: 'text-delta', text: 'x' }]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].messages.map(message => message.content), [calls[1].messages[0].content, 'current-question']);
  assert.ok(size(calls[1].messages) <= 16000);

  // A request that cannot fit even after trimming fails without a model call.
  const failed = [];
  for await (const part of agent.streamAgent(model, [{ role: 'user', content: 'z'.repeat(20000) }], new AbortController().signal)) failed.push(part);
  assert.deepEqual(failed, [{ type: 'error' }]);
  assert.equal(calls.length, 2, 'the provider must never receive an oversized context');
});

test('agent/streamAgent: bounded tool steps end in failure instead of false success', async () => {
  const tool = Object.values(tools)[0];
  let steps = 0;
  const model = { async *stream() { steps++; yield { type: 'tool-call', toolCallId: `call-${steps}`, toolName: tool.name, input: JSON.stringify({ value: 0, from: 'C' }) }; } };
  const parts = [];
  for await (const part of agent.streamAgent(model, [{ role: 'user', content: 'Hi' }], new AbortController().signal)) parts.push(part);
  assert.equal(steps, 3); assert.deepEqual(parts, [{ type: 'tool-error' }]);
});

test('agent/SDK event guard: split thread events, CR/LF and EOF reject without logging sensitive payload', async (t) => {
  const logs = [];
  for (const method of ['error', 'warn', 'log', 'info', 'debug']) t.mock.method(console, method, (...args) => logs.push(args));
  for (const newline of ['\n', '\r', '\r\n']) {
    for (const text of [
      `event: thread.run${newline}data: {sensitive-canary}${newline}${newline}`,
      `data: {sensitive-canary}${newline}event:thread.message${newline}${newline}`,
      `\uFEFFevent: thread.run${newline}data: {sensitive-canary}${newline}${newline}`,
      'event: thread.run',
    ]) {
      let canceled = false;
      const model = agent.createModel('openrouter/vendor/model', 'synthetic-test-key', { fetch: async () => byteStream(text, 1, { cancel() { canceled = true; } }) });
      assert.deepEqual(await collect(model), [{ type: 'error' }]);
      if (text.includes('data:')) assert.equal(canceled, true);
    }
  }
  assert.deepEqual(logs, []);
});

test('agent/SDK event guard: normal SSE supports split Unicode, comments and CR/LF boundaries', async () => {
  for (const newline of ['\n', '\r', '\r\n']) {
    const text = [': comment', '', `data: ${JSON.stringify(chunk({ content: '世界' }))}`, '', `data: ${JSON.stringify(chunk({}, 'stop'))}`, '', 'data: [DONE]', '', ''].join(newline);
    const model = agent.createModel('openrouter/vendor/model', 'synthetic-test-key', { fetch: async () => byteStream(text) });
    assert.deepEqual(await collect(model), [{ type: 'text-delta', text: '世界' }]);
  }
});

test('agent/SDK event guard: partial lines are bounded and cancellation stops pending body reads', async () => {
  let canceled = false;
  const oversized = agent.createModel('openrouter/vendor/model', 'synthetic-test-key', { fetch: async () => byteStream(`data: ${'x'.repeat(200000)}`, 8192, { cancel() { canceled = true; } }) });
  assert.deepEqual(await collect(oversized), [{ type: 'error' }]); assert.equal(canceled, true);
  const abort = new AbortController();
  let fetched;
  const ready = new Promise((resolve) => { fetched = resolve; });
  const blocked = agent.createModel('openrouter/vendor/model', 'synthetic-test-key', { fetch: async () => {
    fetched();
    return new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  canceled = false;
  const collecting = collect(blocked, call({ abortSignal: abort.signal }));
  await ready; await new Promise(resolve => setImmediate(resolve)); abort.abort();
  assert.deepEqual(await collecting, [{ type: 'abort' }]); assert.equal(canceled, true);
});

test('agent/SDK event guard: early consumer return cancels rather than eagerly buffering stream', async () => {
  let pulls = 0, canceled = false;
  const text = `data: ${JSON.stringify(chunk({ content: 'first' }))}\n\n` + ': comment\n'.repeat(10000);
  const model = agent.createModel('openrouter/vendor/model', 'synthetic-test-key', { fetch: async () => byteStream(text, 512, { pull() { pulls++; }, cancel() { canceled = true; } }) });
  const iterator = model.stream(call())[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, { type: 'text-delta', text: 'first' });
  await iterator.return();
  assert.equal(canceled, true); assert.ok(pulls < 10);
});
