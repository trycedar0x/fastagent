const element = id => document.getElementById(id);
const status = message => { element('status').textContent = message; };
let csrf = '';
let messages = [];
let controller;
const post = (path, body, signal) => fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body), signal });
function showSession(session) {
  csrf = session.csrf;
  element('login').hidden = session.authenticated;
  element('chat').hidden = !session.authenticated;
}
async function session() {
  const response = await fetch('/api/session', { credentials: 'same-origin' });
  if (!response.ok) throw new Error();
  showSession(await response.json());
}
function line(role, content) {
  const node = document.createElement('p');
  node.textContent = `${role}: ${content}`;
  element('messages').append(node);
  return node;
}
element('login').addEventListener('submit', async event => {
  event.preventDefault();
  const password = element('password').value;
  element('password').value = '';
  try {
    const response = await post('/api/login', { password });
    if (!response.ok) throw new Error();
    showSession(await response.json()); status('Logged in.');
  } catch { status('Authentication failed. Wait before retrying.'); }
});
element('logout').addEventListener('click', async () => {
  controller?.abort();
  try {
    const response = await post('/api/logout', {});
    if (!response.ok) throw new Error();
    messages = []; element('messages').replaceChildren(); await session(); status('Logged out.');
  } catch { status('Request failed.'); }
});
element('stop').addEventListener('click', () => controller?.abort());
element('send').addEventListener('submit', async event => {
  event.preventDefault();
  if (controller) return;
  const content = element('prompt').value.trim();
  if (!content) return;
  // Match the server limits; keep only bounded recent conversation context.
  messages = messages.slice(-18);
  while (messages.reduce((n, m) => n + m.content.length, content.length) > 16000) messages.shift();
  messages.push({ role: 'user', content });
  line('You', content); element('prompt').value = '';
  const output = line('Agent', '');
  let text = ''; let done = false;
  controller = new AbortController(); element('submit').disabled = true;
  try {
    const response = await post('/api/chat', { messages }, controller.signal);
    if (!response.ok || !response.body) throw new Error();
    const reader = response.body.getReader();
    const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (frame.type === 'error') throw new Error();
        if (frame.type === 'done') done = true;
        if (frame.type === 'delta') { text += frame.text; output.textContent = `Agent: ${text}`; }
      }
      if (chunk.done) break;
    }
    if (!done) throw new Error();
    if (text) messages.push({ role: 'assistant', content: text.slice(0, 4000) });
    status('');
  } catch {
    controller.abort();
    messages.pop(); status('Chat failed or stopped. Your session may have expired; reload to log in.');
  } finally { controller = undefined; element('submit').disabled = false; }
});
session().catch(() => status('Unable to start a protected session.'));
