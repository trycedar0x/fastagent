import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sendChat, validateChatUrl } from '../dist/chat/client.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const token = 'b'.repeat(43);
const conversationId = 'c'.repeat(43);

test('chat client: an already-aborted signal never dispatches a request', async () => {
  let dispatched = 0;
  const fetchImpl = async () => { dispatched++; return new Response('', { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }); };
  await assert.rejects(
    sendChat({ url: 'https://chat.example', token, message: 'Hi', signal: AbortSignal.abort(), fetchImpl }),
    (error) => error.code === 'CHAT_CANCELLED' && !String(error).includes(token));
  assert.equal(dispatched, 0, 'a cancelled request must never reach the network');
});

test('chat client: accepts HTTPS and explicit localhost, refuses credentials, paths and other HTTP', () => {
  assert.equal(validateChatUrl('https://chat.example').origin, 'https://chat.example');
  assert.equal(validateChatUrl('http://127.0.0.1:3000').hostname, '127.0.0.1');
  assert.equal(validateChatUrl('http://localhost:3000').hostname, 'localhost');
  for (const url of ['http://chat.example', 'https://user:secret@chat.example', 'https://chat.example/path', 'https://chat.example/?q=1', 'http://[::1]:3000']) {
    assert.throws(() => validateChatUrl(url), (error) => error.code === 'CHAT_URL_INVALID' && !String(error).includes('secret'));
  }
});

test('chat client: sends bearer only to the validated origin and does not follow redirects', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url: String(url), init };
    assert.equal(init.redirect, 'error');
    return new Response([
      JSON.stringify({ type: 'conversation', conversationId }),
      JSON.stringify({ type: 'delta', text: 'Hello' }),
      JSON.stringify({ type: 'done' }),
      '',
    ].join('\n'), { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
  };
  const result = await sendChat({ url: 'https://chat.example', token, message: 'Hi', conversationId, fetchImpl });
  assert.deepEqual(result, { conversationId, text: 'Hello' });
  assert.equal(seen.url, 'https://chat.example/api/chat');
  assert.equal(seen.init.headers.Authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(seen.init.body), { message: 'Hi', conversationId });
  await assert.rejects(sendChat({ url: 'https://chat.example', token, message: 'Hi', fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }) }), (error) => error.code === 'CHAT_FAILED' && !String(error).includes(token));
});

test('chat client: allowlists output-limit codes but never trusts error text or arbitrary codes', async () => {
  for (const code of ['OUTPUT_TOKEN_LIMIT', 'synthetic-sensitive-code', undefined]) {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return new Response([
        { type: 'conversation', conversationId },
        { type: 'delta', text: 'partial' },
        { type: 'error', code, error: 'synthetic-sensitive-provider-detail' },
      ].map(frame => JSON.stringify(frame)).join('\n'), { headers: { 'Content-Type': 'application/x-ndjson' } });
    };
    await assert.rejects(sendChat({ url: 'https://chat.example', token, message: 'Hi', fetchImpl }), error => {
      assert.equal(error.code, code === 'OUTPUT_TOKEN_LIMIT' ? code : 'CHAT_FAILED');
      assert.ok(!error.message.includes('synthetic-sensitive'));
      if (code === 'OUTPUT_TOKEN_LIMIT') assert.match(error.message, /maxOutputTokens/);
      return true;
    });
    assert.equal(calls, 1, 'must not automatically retry');
  }
});

test('chat CLI: token comes only from the explicit env file, not arguments or the shell', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fastagent-chat-'));
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.end(`${JSON.stringify({ type: 'conversation', conversationId })}\n${JSON.stringify({ type: 'delta', text: 'pong' })}\n${JSON.stringify({ type: 'done' })}\n`);
  });
  // A failing assertion must report, never leave the listening handle keeping the process alive.
  t.after(() => new Promise((resolve) => { if (server.listening) server.close(() => resolve()); else resolve(); }));
  try {
    await writeFile(join(directory, '.env.auth'), `FASTAGENT_API_TOKEN=${token}\n`);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    // spawn, not spawnSync: the stub server runs in this process, so the event loop must stay free to answer it.
    const run = (args, extra = {}) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd: directory, env: { PATH: process.env.PATH, FASTAGENT_API_TOKEN: 'shell-token-must-not-be-used', ...extra },
      });
      let stdout = ''; let stderr = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      child.once('error', reject);
      child.once('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
      child.stdin.end();
    });
    const ok = await run(['chat', '--url', `http://127.0.0.1:${port}`, '--env-file', '.env.auth', '--message', 'ping', '--json']);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.deepEqual(JSON.parse(ok.stdout), { ok: true, command: 'chat', conversationId, text: 'pong' });
    assert.ok(!ok.stdout.includes(token));
    const inherited = await run(['chat', '--url', `http://127.0.0.1:${port}`, '--env-file', '.env.missing', '--message', 'ping', '--json']);
    assert.notEqual(inherited.status, 0);
    assert.ok(!inherited.stdout.includes('shell-token-must-not-be-used'));
    assert.ok(!inherited.stderr.includes('shell-token-must-not-be-used'));
    const argument = await run(['chat', '--url', `http://127.0.0.1:${port}`, '--token', token, '--message', 'ping', '--json']);
    assert.equal(argument.status, 2);
    assert.ok(!argument.stdout.includes(token));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
