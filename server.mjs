// Local AI code assistant — static host + streaming proxy to an OpenAI-compatible server.
//
// The browser only ever talks to this process, so the page stays same-origin
// (no CORS) and the backend can be swapped without touching frontend code:
//
//   LLM_BASE_URL=http://127.0.0.1:11434/v1  Ollama (default here)
//   LLM_BASE_URL=http://127.0.0.1:8001/v1   vLLM + vllm-metal
//   LLM_BASE_URL=http://127.0.0.1:8080/v1   mlx_lm.server
//   LLM_BASE_URL=http://127.0.0.1:11434/v1  Ollama
//
// The default uses Ollama so every installed local model is available in the UI.
// The vLLM backend remains available by setting LLM_BASE_URL and LLM_MODEL.
//
// Usage: node server.mjs   →   http://localhost:5173

import { createAgentService } from './agent-service.mjs';
import { createMediaService } from './media-service.mjs';
import { createChatStorage } from './chat-storage.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const chatStorage = createChatStorage(process.env.CHAT_DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url)));

const agentService = createAgentService(process.env.CHAT_DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url)));

const PORT = Number(process.env.PORT ?? 8000);
const mediaService = createMediaService();
const legacyBaseUrl = (process.env.LLM_BASE_URL ?? 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
const legacyModel = process.env.LLM_MODEL ?? 'qwen2.5-coder:7b';
const legacyApiKey = process.env.LLM_API_KEY ?? 'ollama';
const backends = {
  ollama: { label: 'Ollama', baseUrl: (process.env.OLLAMA_BASE_URL ?? legacyBaseUrl).replace(/\/$/, ''), apiKey: process.env.OLLAMA_API_KEY ?? legacyApiKey, model: process.env.OLLAMA_MODEL ?? legacyModel },
  grok: { label: 'Grok (xAI)', baseUrl: (process.env.XAI_BASE_URL ?? 'https://api.x.ai/v1').replace(/\/$/, ''), apiKey: process.env.XAI_API_KEY ?? '', model: process.env.XAI_MODEL ?? 'grok-3-mini' },
  gemini: { label: 'Gemini', baseUrl: (process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, ''), apiKey: process.env.GEMINI_API_KEY ?? '', model: process.env.GEMINI_MODEL ?? 'gemini-3.1-pro-preview' },
};

const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req, limitBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function upstream(path, init, provider = 'ollama') {
  const backend = backends[provider] ?? backends.ollama;
  return fetch(`${backend.baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${backend.apiKey}`, ...init?.headers },
  });
}

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const rel = normalize(urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''));
  if (rel.startsWith('..')) return json(res, 403, { error: 'forbidden' });

  try {
    const file = await readFile(join(PUBLIC_DIR, rel));
    res.writeHead(200, {
      'content-type': MIME[extname(rel)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(file);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

// Streams the upstream SSE response straight through to the browser. Cancelling
// the browser request aborts generation upstream so the GPU stops working on it.
async function proxyChat(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    return json(res, 400, { error: `bad request: ${err.message}` });
  }

  try {
    if (!Array.isArray(payload.messages)) throw new Error('messages must be an array');
    payload.messages = chatStorage.hydrate(payload.messages);
    if (Buffer.byteLength(JSON.stringify(payload)) > 8 * 1024 * 1024) throw new Error('Conversation images exceed the request limit. Start a new chat or use smaller images.');
  } catch (error) { return json(res, error.status || 400, { error: error.message }); }
  const provider = payload.provider ?? 'ollama';
  const backend = backends[provider] ?? backends.ollama;
  delete payload.provider;
  // Migrate retired model IDs retained in browser settings.
  if (provider === 'gemini' && ['gemini-3-pro-preview', 'models/gemini-3-pro-preview'].includes(payload.model)) {
    payload.model = 'gemini-3.1-pro-preview';
  }
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  let upstreamRes;
  try {
    upstreamRes = await upstream('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: backend.model, ...payload, stream: true }),
      signal: controller.signal,
    }, provider);
  } catch (err) {
    if (controller.signal.aborted) return;
    return json(res, 502, { error: `cannot reach ${backend.label} at ${backend.baseUrl} — ${err.message}` });
  }

  if (!upstreamRes.ok) {
    const detail = await upstreamRes.text().catch(() => '');
    return json(res, upstreamRes.status, { error: detail || `upstream ${upstreamRes.status}` });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  try {
    for await (const chunk of upstreamRes.body) {
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
    }
  } catch {
    // client hung up or upstream died mid-stream; nothing useful to add
  } finally {
    res.end();
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/api/')) {
    const host = req.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) || (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Local same-origin requests only.' });
  }
  if (pathname.startsWith('/api/media/')) {
    try {
      if (req.method === 'GET' && pathname === '/api/media/status') return json(res, 200, await mediaService.status());
      if (req.method === 'POST' && pathname === '/api/media/generate') {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'Use application/json.' });
        let input;
        try { input = JSON.parse(await readBody(req, 16384)); } catch { return json(res, 400, { error: 'Invalid generation request.' }); }
        return json(res, 202, await mediaService.generate(input));
      }
      const cancel = pathname.match(/^\/api\/media\/jobs\/([a-zA-Z0-9-]+)\/cancel$/);
      if (req.method === 'POST' && cancel) return json(res, 200, await mediaService.cancel(cancel[1]));
      const match = pathname.match(/^\/api\/media\/jobs\/([a-zA-Z0-9-]+)(?:\/outputs\/(\d+))?$/);
      if (req.method === 'GET' && match) {
        if (match[2] === undefined) return json(res, 200, await mediaService.job(match[1]));
        const output = await mediaService.output(match[1], Number(match[2]));
        res.writeHead(200, { 'content-type': output.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'private, max-age=3600' });
        for await (const chunk of output.body) {
          if (!res.write(chunk)) await new Promise(resolve => res.once('drain', resolve));
        }
        return res.end();
      }
      return json(res, 404, { error: 'Media route not found.' });
    } catch (error) {
      if (res.headersSent) return res.destroy();
      return json(res, error.status || 500, { error: error.message });
    }
  }
  if (pathname.startsWith('/api/agent/')) {
    try {
      if (req.method !== 'GET' && !req.headers['content-type']?.startsWith('application/json')) return json(res,415,{error:'Use application/json.'});
      const input = req.method === 'POST' ? JSON.parse(await readBody(req,16*1024*1024)) : {};
      const token = req.headers['x-workspace-token'];
      const query = new URL(req.url,'http://localhost').searchParams;
      const route = pathname.slice('/api/agent/'.length);
      let result;
      if(route==='connect' && req.method==='POST') result=agentService.connect(input.path);
      else if(route==='disconnect' && req.method==='POST') result=agentService.disconnect(token);
      else if(route==='files' && req.method==='GET') result=agentService.list(token);
      else if(route==='file' && req.method==='GET') result=agentService.read(token,query.get('path'));
      else if(route==='changes' && req.method==='GET') result=agentService.changeHistory(token);
      else if(route==='changes' && req.method==='POST') result=agentService.prepareChanges(token,input.changes,input.explanation);
      else if(route==='apply' && req.method==='POST') result=agentService.apply(token,input.id);
      else if(route==='undo' && req.method==='POST') result=agentService.undo(token,input.id);
      else if(route==='reject' && req.method==='POST') result=agentService.reject(token,input.id);
      else if(route==='recover' && req.method==='POST') result=agentService.recover(token,input.id);
      else if(route==='git' && req.method==='POST') result=await agentService.gitInfo(token,input.kind);
      else if(route==='jobs' && req.method==='GET') result=agentService.jobs(token);
      else if(route==='jobs' && req.method==='POST') result=await agentService.prepareJob(token,input);
      else if(route==='job' && req.method==='GET') result=agentService.job(token,query.get('id'));
      else if(route==='approve-job' && req.method==='POST') result=await agentService.approveJob(token,input.id);
      else if(route==='cancel-job' && req.method==='POST') result=agentService.cancelJob(token,input.id);
      else return json(res,404,{error:'Unknown agent operation.'});
      return json(res,200,result);
    }catch(error){return json(res,error.status || 400,{error:error.message});}
  }
  if (pathname === '/api/threads' || pathname.startsWith('/api/threads/') || pathname.startsWith('/api/attachments/')) {
    try {
      if (['POST', 'PUT', 'DELETE'].includes(req.method) && !req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'Use application/json.' });
      if (pathname === '/api/threads' && req.method === 'GET') return json(res, 200, { threads: chatStorage.list() });
      if (pathname === '/api/threads/import' && req.method === 'POST') {
        const input = JSON.parse(await readBody(req, 64 * 1024 * 1024));
        return json(res, 200, { ids: chatStorage.import(input.threads) });
      }
      const thread = /^\/api\/threads\/([\w-]{1,100})$/.exec(pathname);
      if (thread && req.method === 'PUT') {
        const input = JSON.parse(await readBody(req, 64 * 1024 * 1024));
        if (input.thread?.id !== thread[1]) return json(res, 400, { error: 'Thread ID mismatch.' });
        return json(res, 200, { thread: chatStorage.save(input.thread, input.version) });
      }
      if (thread && req.method === 'DELETE') {
        const input = JSON.parse(await readBody(req)); chatStorage.delete(thread[1], input.version);
        return json(res, 200, { deleted: true });
      }
      const attachment = /^\/api\/attachments\/([a-f0-9]{64})$/.exec(pathname);
      if (attachment && (req.method === 'GET' || req.method === 'HEAD')) {
        const item = chatStorage.getAttachment(attachment[1]);
        res.writeHead(200, { 'content-type': item.mime, 'content-length': item.size, 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin', 'content-disposition': item.mime.startsWith('image/') ? 'inline' : 'attachment' });
        return res.end(req.method === 'HEAD' ? undefined : item.bytes);
      }
      return json(res, 404, { error: 'Not found.' });
    } catch (error) { return json(res, error.status || (error instanceof SyntaxError ? 400 : 500), { error: error.message }); }
  }

  if (pathname === '/api/chat' && req.method === 'POST') return proxyChat(req, res);

  if (pathname === '/api/config') {
    const providers = await Promise.all(Object.entries(backends).map(async ([id, backend]) => {
      let models = [];
      let online = false;
      let modelCapabilities = {};
      if (backend.apiKey) {
        try {
          const r = await upstream('/models', { method: 'GET', signal: AbortSignal.timeout(5000) }, id);
          if (r.ok) {
            models = (await r.json()).data?.map((model) => model.id)
              .filter((model) => !/(?:embed|embedding)/i.test(model)) ?? [];
            online = true;
          }
        } catch {
          // backend unavailable
        }
      }
      if (id === 'ollama' && online) {
        try {
          const response = await fetch(`${backend.baseUrl.replace(/\/v1$/, '')}/api/tags`, { signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${backend.apiKey}` } });
          if (response.ok) {
            for (const model of (await response.json()).models || []) {
              if (Array.isArray(model.capabilities)) modelCapabilities[model.name] = { tools: model.capabilities.includes('tools') };
            }
          }
        } catch { /* Unknown capabilities: try native tools, then compatibility mode. */ }
      }
      if (!models.length && backend.apiKey) models = [backend.model];
      return { id, label: backend.label, baseUrl: backend.baseUrl, model: backend.model, models, online, modelCapabilities };
    }));
    return json(res, 200, { providers, defaultProvider: process.env.LLM_PROVIDER ?? 'ollama' });
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  json(res, 405, { error: 'method not allowed' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`local-ai-chat  →  http://localhost:${server.address().port}`);
  console.log(`backends       →  ${Object.values(backends).map(({ label, baseUrl }) => `${label}: ${baseUrl}`).join(' | ')}`);
});

process.on('SIGTERM', async () => { await agentService.close(); server.close(() => { chatStorage.close(); process.exit(0); }); });
