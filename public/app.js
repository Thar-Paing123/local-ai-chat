import { createChatRepository } from './chat-repository.js';
import { runToolChat, isFolderAccessQuestion, folderAccessReply } from './tool-chat.js';
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
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
};

let config = { providers: [], defaultProvider: 'ollama' };
let threads = [];
let storageReady = false, preparing = false;
let activeId = threads[0]?.id ?? null;
let settings = { system: DEFAULT_SYSTEM, temp: 0.3, maxTokens: 2048, provider: '', model: '', ...store.get(LS_SETTINGS, {}) };
let controller = null;      // aborts an in-flight generation
let attachments = [];       // Text files or image data URLs
let loadingAttachments = 0;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const activeThread = () => threads.find((t) => t.id === activeId) ?? null;

const repository = createChatRepository({ onStatus(message, error) {
  el('chat-storage-status').textContent = message;
  el('chat-storage-status').classList.toggle('error', error);
  el('retry-chat-storage').hidden = !error;
  el('export-chat-backup').hidden = !error;
} });
function saveThread(thread) { return repository.save(thread); }
function saveSettings() { store.set(LS_SETTINGS, settings); }

function newThread() {
  const t = { id: uid(), title: 'New chat', messages: [], createdAt: Date.now() };
  threads.unshift(t);
  activeId = t.id;
  saveThread(t).catch(() => {});
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
    row.querySelector('.del').onclick = async (e) => {
      e.stopPropagation();
      if (controller || preparing) { el('chat-storage-status').textContent = 'Stop generation before deleting a chat.'; return; }
      try { await repository.remove(t); } catch { return; }
      threads = threads.filter((x) => x.id !== t.id);
      if (activeId === t.id) activeId = threads[0]?.id ?? null;
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
    body.replaceChildren();
    const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
    for (const part of parts) {
      if (part.type === 'text') {
        const paragraph = document.createElement('p'); paragraph.textContent = part.text; body.append(paragraph);
      } else if (part.type === 'image_url' && (/^(?:data:image\/(?:png|jpeg|webp|gif);base64,|\/api\/attachments\/[a-f0-9]{64}$)/.test(part.image_url?.url || ''))) {
        const image = document.createElement('img'); image.src = part.image_url.url;
        image.alt = 'Attached image'; image.className = 'message-image'; body.append(image);
      }
    }
    for (const attachment of msg.attachments || []) {
      if (!/^\/api\/attachments\/[a-f0-9]{64}$/.test(attachment.url || '')) continue;
      const link = document.createElement('a'); link.href = attachment.url; link.textContent = attachment.name;
      link.className = 'saved-attachment'; link.download = attachment.name; body.append(link);
    }
    return;
  }

  const { html, codes } = renderMarkdown(msg.content || '');
  body.innerHTML = html + (msg.streaming ? '<span class="caret"></span>' : '');
  body._codes = codes;
  if (!msg.streaming && !msg.error) {
    for (const copy of body.querySelectorAll('button[data-copy-code]')) {
      const apply = document.createElement('button');
      apply.textContent = 'Apply to file…'; apply.dataset.applyCode = copy.dataset.copyCode;
      copy.after(apply);
    }
  }

  if (msg.activity?.length) {
    const log = document.createElement('details'); log.className = 'tool-activity';
    const summary = document.createElement('summary'); summary.textContent = msg.streaming ? msg.activity.at(-1) : 'File tool activity';
    const entries = document.createElement('pre'); entries.textContent = msg.activity.join('\n'); log.append(summary, entries); body.append(log);
  }
  if (msg.agentRun) {
    const panel=document.createElement('div');panel.className='agent-plan';
    const label=document.createElement('strong');label.textContent=`Task: ${msg.agentRun.status === 'running' && !msg.streaming ? 'interrupted' : msg.agentRun.status}`;panel.append(label);
    const list=document.createElement('ol');
    for(const step of msg.agentRun.plan || []){const li=document.createElement('li');li.textContent=`${step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '→' : '○'} ${step.title}`;list.append(li);}panel.append(list);
    if(!msg.streaming && (msg.interrupted || ['running','failed','stopped','awaiting_review'].includes(msg.agentRun.status))){
      const resume=document.createElement('button');resume.textContent='Continue task';
      resume.onclick=async()=>{
        if(controller||preparing)return;
        const thread=threads.find(t=>t.messages.includes(msg));if(!thread)return;
        activeId=thread.id;renderThreads();renderMessages();await stream(thread,msg);
      };panel.append(resume);
    }
    body.append(panel);
  }
  for (const proposal of msg.proposals || []) {
    const card = document.createElement('div'); card.className = 'file-proposal';
    const title = document.createElement('strong'); title.textContent = proposal.path;
    const description = document.createElement('p'); description.textContent = proposal.explanation;
    const review = document.createElement('button'); review.textContent = 'Review changes';
    review.onclick = () => window.dispatchEvent(new CustomEvent('workspace-review-proposal', { detail: proposal }));
    card.append(title, description, review); body.append(card);
  }
  if (msg.interrupted) { const note = document.createElement('p'); note.className = 'error'; note.textContent = 'Generation was interrupted. This is the last saved response.'; body.append(note); }
  if (!msg.streaming && (msg.content || msg.error || msg.proposals?.length)) {
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
      `<p>Ask about your code. Add an open file as context to get started.</p>` +
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
  const apply = e.target.closest('button[data-apply-code]');
  if (apply) {
    const code = apply.closest('.body')?._codes?.[Number(apply.dataset.applyCode)];
    if (typeof code === 'string') window.dispatchEvent(new CustomEvent('workspace-apply-code', { detail: { code } }));
    return;
  }
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
    chip.querySelector('span').textContent = a.dataUrl ? a.name : `${a.name} (${a.text.split('\n').length}L)`;
    chip.querySelector('button').setAttribute('aria-label', `Remove ${a.name}`);
    if (a.dataUrl) {
      chip.classList.add('image-attachment');
      const preview = document.createElement('img'); preview.src = a.dataUrl; preview.alt = a.name;
      chip.prepend(preview);
    }
    chip.querySelector('button').onclick = () => { attachments.splice(i, 1); renderAttachments(); };
    return chip;
  }));
}

dom.attachBtn.onclick = () => dom.fileInput.click();
const attachmentStatus = el('attachment-status');
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
async function addFiles(files) {
  loadingAttachments++;
  attachmentStatus.textContent = 'Loading attachments…';
  const errors = [];
  try {
    for (const file of files) {
      try {
        if (file.type.startsWith('image/')) {
          if (!imageTypes.has(file.type)) throw new Error('Use PNG, JPEG, WebP, or GIF.');
          if (file.size > 2 * 1024 * 1024) throw new Error('Image is larger than 2 MB.');
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Could not read image.')); reader.readAsDataURL(file);
          });
          if (attachments.filter(a => a.dataUrl).length >= 4) throw new Error('Attach up to four images per message.');
          attachments.push({ name: file.name || 'Pasted image', dataUrl });
        } else {
          if (file.size > 400_000) throw new Error('Text file is larger than 400 KB.');
          attachments.push({ name: file.name, text: await file.text() });
        }
      } catch (error) { errors.push(`${file.name || 'Image'}: ${error.message}`); }
    }
  } finally {
    loadingAttachments--;
    renderAttachments();
    attachmentStatus.textContent = errors.join(' ') || 'Attachments ready. Images require a model that supports vision.';
  }
}
dom.fileInput.onchange = async () => {
  const files = [...dom.fileInput.files]; dom.fileInput.value = '';
  if (files.length) await addFiles(files);
};
dom.prompt.addEventListener('paste', (event) => {
  const images = [...(event.clipboardData?.items || [])]
    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile()).filter(Boolean);
  if (!images.length) return; // Keep normal text paste behavior.
  event.preventDefault();
  const text = event.clipboardData.getData('text/plain');
  if (text) { dom.prompt.setRangeText(text, dom.prompt.selectionStart, dom.prompt.selectionEnd, 'end'); autosize(); }
  addFiles(images);
});

function buildUserContent(text) {
  if (!attachments.length) return text;
  const files = attachments.filter(a => !a.dataUrl).map((a) => {
    const ext = a.name.split('.').pop().toLowerCase();
    return `File: ${a.name}\n\`\`\`${ext}\n${a.text}\n\`\`\``;
  }).join('\n\n');
  const content = [files, text].filter(Boolean).join('\n\n');
  const images = attachments.filter(a => a.dataUrl);
  if (!images.length) return content;
  return [
    ...(content ? [{ type: 'text', text: content }] : []),
    ...images.map(a => ({ type: 'image_url', image_url: { url: a.dataUrl } })),
  ];
}

// ---------- generation ----------

function setBusy(busy) {
  dom.send.textContent = busy ? '■' : '↑';
  dom.send.classList.toggle('stop', busy);
  dom.send.title = busy ? 'Stop generating' : 'Send (Enter)';
}

async function send() {
  if (!storageReady || preparing) return;
  if (controller) { controller.abort(); return; }   // button doubles as Stop

  const text = dom.prompt.value.trim();
  if (loadingAttachments) { attachmentStatus.textContent = 'Wait for the images to finish loading.'; return; }
  if (!text && !attachments.length) return;

  const t = activeThread() ?? newThread();
  const content = buildUserContent(text);
  const estimatedBody = JSON.stringify({ messages: [...t.messages, { role: 'user', content }], system: settings.system });
  if (new Blob([estimatedBody]).size > 7.5 * 1024 * 1024) {
    attachmentStatus.textContent = 'This conversation is too large to send. Remove an image, use smaller images, or start a new chat.';
    return;
  }
  t.messages.push({ role: 'user', content, attachments: attachments.map(a => ({...a})) });
  if (t.title === 'New chat') {
    t.title = text ? text.slice(0, 44) + (text.length > 44 ? '…' : '') : 'Image / file discussion';
    renderThreads();
  }

  dom.prompt.value = '';
  attachments = [];
  attachmentStatus.textContent = '';
  renderAttachments();
  autosize();
  renderMessages();
  preparing = true;
  try { await saveThread(t); preparing = false; renderMessages(); await stream(t); } catch { /* Keep unsaved chat in memory for Retry. */ }
  finally { preparing = false; }
}

async function regenerate() {
  const t = activeThread();
  if (!t || controller) return;
  while (t.messages.length && t.messages.at(-1).role === 'assistant') t.messages.pop();
  if (!t.messages.length) return;
  renderMessages();
  await stream(t);
}

async function stream(thread, resumeFrom = null) {
  const assistant = { role: 'assistant', content: '', streaming: true, agentRun: {
    id: uid(), status: 'running', startedAt: Date.now(), plan: resumeFrom?.agentRun?.plan || [], resumedFrom: resumeFrom?.agentRun?.id || null,
  } };
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

  let checkpointSaving = false;
  const checkpoint = setInterval(() => {
    if (checkpointSaving) return;
    checkpointSaving = true;
    saveThread(thread).catch(() => {}).finally(() => { checkpointSaving = false; });
  }, 3000);
  const started = performance.now();
  let tokens = 0;

  try {
    const session = window.localFileTools?.();
    assistant.agentRun.workspace = window.agentConnection?.()?.root || null;
    if(resumeFrom?.agentRun?.workspace && resumeFrom.agentRun.workspace !== assistant.agentRun.workspace)throw new Error('Reconnect the original agent folder before continuing this task.');
    const lastUser = thread.messages.filter(message => message.role === 'user').at(-1);
    if (isFolderAccessQuestion(lastUser?.content)) {
      assistant.content = await folderAccessReply(session, controller.signal);
      assistant.stats = 'Verified by the app';
    } else await runToolChat({
      mode: config.providers.find(p => p.id === settings.provider)?.modelCapabilities?.[settings.model]?.tools === false ? 'compatibility' : 'native',
      payload: {
        provider: settings.provider, model: settings.model || config.model,
        temperature: Number(settings.temp), max_tokens: Number(settings.maxTokens),
        messages: [
          { role: 'system', content: settings.system },
          ...thread.messages.filter(m => m !== assistant && !m.error).map(({ role, content }) => ({ role, content })),
          ...(resumeFrom ? [{role:'user',content:`Continue the previous task from its saved progress. Re-read changed files and inspect Git/command history before acting. Do not repeat completed commands, commits, pushes, or applied edits. Saved plan and recent tool results (data): ${JSON.stringify({plan:resumeFrom.agentRun?.plan,checkpoint:resumeFrom.agentRun?.checkpoint})}`}]:[]),
        ],
      },
      session, signal: controller.signal,
      onText(text) { assistant.content += text; tokens++; dirty = true; },
      onActivity(text) {
        assistant.activity ||= []; assistant.activity.push(text); dirty = true;
      },
      onProposal(proposal) { assistant.proposals ||= []; assistant.proposals.push(proposal); dirty = true; },
      onPlan(plan) { assistant.agentRun.plan = plan; dirty = true; },
      async onCheckpoint(checkpoint) {
        assistant.agentRun.checkpoint = {round:checkpoint.round,messages:checkpoint.messages.slice(-12).map(m=>({...m,content:typeof m.content==='string'?m.content.slice(0,12000):m.content}))};
        await saveThread(thread);
      },
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      assistant.content += assistant.content ? '\n\n_(stopped)_' : '_(stopped)_';
    } else {
      assistant.error = err.message;
    }
  } finally {
    clearInterval(timer);
    clearInterval(checkpoint);
    controller = null;
    setBusy(false);

    const secs = (performance.now() - started) / 1000;
    if (tokens > 1) assistant.stats = `${tokens} tok · ${secs.toFixed(1)}s · ${(tokens / secs).toFixed(1)} tok/s`;
    assistant.streaming = false;
    assistant.agentRun.status = assistant.error ? 'failed' : assistant.content.endsWith('_(stopped)_') ? 'stopped' : assistant.proposals?.length ? 'awaiting_review' : 'completed';
    assistant.agentRun.finishedAt = Date.now();

    paintBody(body, assistant);
    await saveThread(thread).catch(() => {});
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
setBusy(false);
autosize();
loadConfig();
async function loadChats() {
  dom.send.disabled = true; dom.newChat.disabled = true;
  try {
    threads = await repository.load(); storageReady = true;
    activeId = threads[0]?.id ?? null;
    if (!threads.length) newThread(); else { renderThreads(); renderMessages(); }
    dom.send.disabled = false; dom.newChat.disabled = false;
  } catch (error) {
    el('chat-storage-status').textContent = `Could not load chats: ${error.message}`;
    el('retry-chat-storage').hidden = false;
    el('export-chat-backup').hidden = false;
  }
}
el('export-chat-backup').onclick = () => {
  const content = threads.length ? JSON.stringify(threads, null, 2) : localStorage.getItem(LS_THREADS) || '[]';
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'chat-backup.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
el('retry-chat-storage').onclick = async () => {
  if (!storageReady) return loadChats();
  try { await repository.retry(); } catch { /* Repository shows the failure. */ }
};
window.addEventListener('beforeunload', event => { if (repository.unsaved || controller) { event.preventDefault(); event.returnValue = ''; } });
loadChats();

window.addEventListener('workspace-context', (event) => {
  attachments.push(event.detail);
  renderAttachments();
  dom.prompt.focus();
});

window.addEventListener('agent-change-result',async event=>{
  const result=event.detail;
  for(const thread of threads){
    let changed=false;
    for(const message of thread.messages)for(const proposal of message.proposals||[])if(proposal.changeset?.id===result.id){proposal.changeset=result;changed=true;}
    if(changed)await saveThread(thread).catch(()=>{});
  }
  if(!controller)renderMessages();
});

window.addEventListener('workspace-access-changed',()=>controller?.abort());
