import { renderMarkdown, escapeHtml } from './markdown.js';

const DEFAULT_SYSTEM = `You are a senior software engineer acting as a coding assistant, running locally.

- Answer with working code first, then a short explanation of the parts that matter.
- Always put code in fenced blocks tagged with the language.
- Keep explanations tight; skip preamble and filler.
- If the request is ambiguous, state the assumption you made in one line and answer anyway.
- When you spot a bug, security issue, or edge case in the user's code, say so explicitly.`;

const LS_THREADS = 'lac.threads';
const LS_SETTINGS = 'lac.settings';

const el = (id) => document.getElementById(id);
const dom = {
  banner: el('banner'), messages: el('messages'), prompt: el('prompt'),
  send: el('send'), threads: el('thread-list'), newChat: el('new-chat'),
  status: el('status'), providerSel: el('provider'), modelSel: el('model'), system: el('system'),
  temp: el('temp'), tempVal: el('temp-val'), maxTokens: el('max-tokens'),
  backend: el('backend'), attachBtn: el('attach'), fileInput: el('file'),
  attachments: el('attachments'),
};

// ---------- persistence (best-effort; private windows can throw) ----------

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

let config = { providers: [], defaultProvider: 'ollama' };
let threads = store.get(LS_THREADS, []);
let activeId = threads[0]?.id ?? null;
let settings = { system: DEFAULT_SYSTEM, temp: 0.3, maxTokens: 2048, provider: '', model: '', ...store.get(LS_SETTINGS, {}) };
let controller = null;      // aborts an in-flight generation
let attachments = [];       // [{name, text}]

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const activeThread = () => threads.find((t) => t.id === activeId) ?? null;

function saveThreads() { store.set(LS_THREADS, threads); }
function saveSettings() { store.set(LS_SETTINGS, settings); }

function newThread() {
  const t = { id: uid(), title: 'New chat', messages: [], createdAt: Date.now() };
  threads.unshift(t);
  activeId = t.id;
  saveThreads();
  renderThreads();
  renderMessages();
  dom.prompt.focus();
  return t;
}

// ---------- sidebar ----------

function renderThreads() {
  dom.threads.replaceChildren(...threads.map((t) => {
    const row = document.createElement('div');
    row.className = `thread${t.id === activeId ? ' active' : ''}`;
    row.innerHTML = `<span class="title"></span><button class="del" title="Delete">&times;</button>`;
    row.querySelector('.title').textContent = t.title;
    row.onclick = () => { activeId = t.id; renderThreads(); renderMessages(); };
    row.querySelector('.del').onclick = (e) => {
      e.stopPropagation();
      threads = threads.filter((x) => x.id !== t.id);
      if (activeId === t.id) activeId = threads[0]?.id ?? null;
      saveThreads();
      renderThreads();
      if (!activeId) newThread(); else renderMessages();
    };
    return row;
  }));
}

// ---------- messages ----------

const SUGGESTIONS = [
  'Explain this stack trace and how to fix it',
  'Write a Python script to bulk-import .sql dumps into MySQL',
  'Refactor this function to be async and add error handling',
  'Write pytest tests for the code I paste next',
];

function messageNode(msg) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${msg.role}`;

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = msg.role === 'user' ? 'You' : 'AI';

  const body = document.createElement('div');
  body.className = 'body';

  wrap.append(who, body);
  paintBody(body, msg);
  return wrap;
}

function paintBody(body, msg) {
  if (msg.role === 'user') {
    body.innerHTML = '<p></p>';
    body.firstChild.textContent = msg.content;
    return;
  }

  const { html, codes } = renderMarkdown(msg.content || '');
  body.innerHTML = html + (msg.streaming ? '<span class="caret"></span>' : '');
  body._codes = codes;

  if (!msg.streaming && (msg.content || msg.error)) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    if (msg.error) {
      const e = document.createElement('span');
      e.className = 'error';
      e.textContent = `⚠ ${msg.error}`;
      meta.append(e);
    }
    if (msg.stats) {
      const s = document.createElement('span');
      s.textContent = msg.stats;
      meta.append(s);
    }
    const copy = document.createElement('button');
    copy.textContent = 'copy reply';
    copy.onclick = () => copyText(msg.content, copy, 'copy reply');
    meta.append(copy);

    const regen = document.createElement('button');
    regen.textContent = 'regenerate';
    regen.onclick = () => regenerate();
    meta.append(regen);

    body.append(meta);
  }
}

function renderMessages() {
  const t = activeThread();
  dom.messages.replaceChildren();

  if (!t || !t.messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML =
      `<h1>Local code assistant</h1>` +
      `<p>Running fully on your machine — nothing leaves this Mac.</p>` +
      `<div class="chips"></div>`;
    const chips = empty.querySelector('.chips');
    for (const s of SUGGESTIONS) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = s;
      b.onclick = () => { dom.prompt.value = s; autosize(); dom.prompt.focus(); };
      chips.append(b);
    }
    dom.messages.append(empty);
    return;
  }

  for (const m of t.messages) dom.messages.append(messageNode(m));
  scrollToBottom();
}

function scrollToBottom(force = false) {
  const m = dom.messages;
  const near = m.scrollHeight - m.scrollTop - m.clientHeight < 140;
  if (force || near) m.scrollTop = m.scrollHeight;
}

async function copyText(text, btn, revert) {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'copied';
  } catch {
    btn.textContent = 'copy failed';
  }
  setTimeout(() => { btn.textContent = revert; }, 1200);
}

// code-block copy buttons, via delegation so streaming re-renders keep working
dom.messages.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-copy-code]');
  if (!btn) return;
  const body = btn.closest('.body');
  const code = body?._codes?.[Number(btn.dataset.copyCode)];
  if (code != null) copyText(code, btn, 'copy');
});

// ---------- attachments (file context for the assistant) ----------

function renderAttachments() {
  dom.attachments.replaceChildren(...attachments.map((a, i) => {
    const chip = document.createElement('span');
    chip.className = 'attachment';
    chip.innerHTML = `<span></span><button title="Remove">&times;</button>`;
    chip.querySelector('span').textContent = `${a.name} (${a.text.split('\n').length}L)`;
    chip.querySelector('button').onclick = () => { attachments.splice(i, 1); renderAttachments(); };
    return chip;
  }));
}

dom.attachBtn.onclick = () => dom.fileInput.click();
dom.fileInput.onchange = async () => {
  for (const file of dom.fileInput.files) {
    if (file.size > 400_000) {
      alert(`${file.name} is larger than 400 KB — paste the relevant part instead.`);
      continue;
    }
    attachments.push({ name: file.name, text: await file.text() });
  }
  dom.fileInput.value = '';
  renderAttachments();
};

function buildUserContent(text) {
  if (!attachments.length) return text;
  const files = attachments.map((a) => {
    const ext = a.name.split('.').pop().toLowerCase();
    return `File: ${a.name}\n\`\`\`${ext}\n${a.text}\n\`\`\``;
  }).join('\n\n');
  return `${files}\n\n${text}`;
}

// ---------- generation ----------

function setBusy(busy) {
  dom.send.textContent = busy ? '■' : '↑';
  dom.send.classList.toggle('stop', busy);
  dom.send.title = busy ? 'Stop generating' : 'Send (Enter)';
}

async function send() {
  if (controller) { controller.abort(); return; }   // button doubles as Stop

  const text = dom.prompt.value.trim();
  if (!text) return;

  const t = activeThread() ?? newThread();
  t.messages.push({ role: 'user', content: buildUserContent(text) });
  if (t.title === 'New chat') {
    t.title = text.slice(0, 44) + (text.length > 44 ? '…' : '');
    renderThreads();
  }

  dom.prompt.value = '';
  attachments = [];
  renderAttachments();
  autosize();
  renderMessages();
  await stream(t);
}

async function regenerate() {
  const t = activeThread();
  if (!t || controller) return;
  while (t.messages.length && t.messages.at(-1).role === 'assistant') t.messages.pop();
  if (!t.messages.length) return;
  renderMessages();
  await stream(t);
}

async function stream(thread) {
  const assistant = { role: 'assistant', content: '', streaming: true };
  thread.messages.push(assistant);

  const node = messageNode(assistant);
  dom.messages.append(node);
  const body = node.querySelector('.body');
  scrollToBottom(true);

  controller = new AbortController();
  setBusy(true);

  // repaint on a frame timer — markdown re-render per token would thrash the DOM
  let dirty = false;
  const timer = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    paintBody(body, assistant);
    scrollToBottom();
  }, 60);

  const started = performance.now();
  let tokens = 0;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        provider: settings.provider,
        model: settings.model || config.model,
        temperature: Number(settings.temp),
        max_tokens: Number(settings.maxTokens),
        messages: [
          { role: 'system', content: settings.system },
          ...thread.messages
            .filter((m) => m !== assistant && !m.error)
            .map(({ role, content }) => ({ role, content })),
        ],
      }),
    });

    if (!res.ok || res.headers.get('content-type')?.includes('application/json')) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.error ?? `request failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n');
      buffer = events.pop() ?? '';   // keep the partial line

      for (const line of events) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;

        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        if (parsed.error) throw new Error(parsed.error.message ?? String(parsed.error));

        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          assistant.content += delta;
          tokens++;
          dirty = true;
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      assistant.content += assistant.content ? '\n\n_(stopped)_' : '_(stopped)_';
    } else {
      assistant.error = err.message;
    }
  } finally {
    clearInterval(timer);
    controller = null;
    setBusy(false);

    const secs = (performance.now() - started) / 1000;
    if (tokens > 1) assistant.stats = `${tokens} tok · ${secs.toFixed(1)}s · ${(tokens / secs).toFixed(1)} tok/s`;
    assistant.streaming = false;

    paintBody(body, assistant);
    saveThreads();
    scrollToBottom();
  }
}

// ---------- composer ----------

function autosize() {
  dom.prompt.style.height = 'auto';
  dom.prompt.style.height = `${Math.min(dom.prompt.scrollHeight, 240)}px`;
}

dom.prompt.addEventListener('input', autosize);
dom.prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
dom.send.onclick = send;
dom.newChat.onclick = () => newThread();

// ---------- settings ----------

function bindSettings() {
  dom.system.value = settings.system;
  dom.temp.value = settings.temp;
  dom.tempVal.textContent = Number(settings.temp).toFixed(2);
  dom.maxTokens.value = settings.maxTokens;

  dom.system.oninput = () => { settings.system = dom.system.value; saveSettings(); };
  dom.temp.oninput = () => {
    settings.temp = Number(dom.temp.value);
    dom.tempVal.textContent = settings.temp.toFixed(2);
    saveSettings();
  };
  dom.maxTokens.onchange = () => { settings.maxTokens = Number(dom.maxTokens.value) || 2048; saveSettings(); };
  dom.modelSel.onchange = () => { settings.model = dom.modelSel.value; saveSettings(); };
  dom.providerSel.onchange = () => {
    settings.provider = dom.providerSel.value;
    settings.model = '';
    saveSettings();
    renderProviderSettings();
  };
}

function renderProviderSettings() {
  const provider = config.providers.find((item) => item.id === settings.provider) ?? config.providers[0];
  if (!provider) return;
  const options = provider.models.length ? provider.models : [provider.model].filter(Boolean);
  dom.modelSel.replaceChildren(...options.map((model) => {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model.length > 34 ? `…${model.slice(-33)}` : model;
    return option;
  }));
  if (settings.model && options.includes(settings.model)) dom.modelSel.value = settings.model;
  else { settings.model = options[0] ?? provider.model; saveSettings(); }
  dom.backend.textContent = `${provider.label}: ${provider.baseUrl}`;
  dom.status.className = `dot ${provider.online ? 'online' : 'offline'}`;
  dom.status.title = provider.online ? `${provider.label} online` : `${provider.label} unavailable or not configured`;
  dom.banner.hidden = provider.online;
  if (!provider.online) dom.banner.textContent = provider.id === 'ollama'
    ? `Ollama is unavailable at ${provider.baseUrl}.`
    : `${provider.label} is not configured or unavailable. Set its API key before starting the server.`;
}

async function loadConfig() {
  try {
    config = await (await fetch('/api/config')).json();
  } catch {
    config = { providers: [], defaultProvider: 'ollama' };
  }

  const providers = config.providers ?? [];
  dom.providerSel.replaceChildren(...providers.map((provider) => {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.label;
    return option;
  }));
  if (!settings.provider || !providers.some((provider) => provider.id === settings.provider)) {
    settings.provider = config.defaultProvider ?? providers[0]?.id ?? '';
    saveSettings();
  }
  dom.providerSel.value = settings.provider;
  renderProviderSettings();
}

// ---------- boot ----------

bindSettings();
if (!threads.length) newThread(); else { renderThreads(); renderMessages(); }
setBusy(false);
autosize();
loadConfig();
dom.prompt.focus();
