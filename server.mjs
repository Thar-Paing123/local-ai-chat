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

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 8000);
const legacyBaseUrl = (process.env.LLM_BASE_URL ?? 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
const legacyModel = process.env.LLM_MODEL ?? 'qwen2.5-coder:7b';
const legacyApiKey = process.env.LLM_API_KEY ?? 'ollama';
const backends = {
  ollama: { label: 'Ollama', baseUrl: (process.env.OLLAMA_BASE_URL ?? legacyBaseUrl).replace(/\/$/, ''), apiKey: process.env.OLLAMA_API_KEY ?? legacyApiKey, model: process.env.OLLAMA_MODEL ?? legacyModel },
  grok: { label: 'Grok (xAI)', baseUrl: (process.env.XAI_BASE_URL ?? 'https://api.x.ai/v1').replace(/\/$/, ''), apiKey: process.env.XAI_API_KEY ?? '', model: process.env.XAI_MODEL ?? 'grok-3-mini' },
  gemini: { label: 'Gemini', baseUrl: (process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, ''), apiKey: process.env.GEMINI_API_KEY ?? '', model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash' },
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

  const provider = payload.provider ?? 'ollama';
  const backend = backends[provider] ?? backends.ollama;
  delete payload.provider;
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

  if (pathname === '/api/chat' && req.method === 'POST') return proxyChat(req, res);

  if (pathname === '/api/config') {
    const providers = await Promise.all(Object.entries(backends).map(async ([id, backend]) => {
      let models = [];
      let online = false;
      if (backend.apiKey) {
        try {
          const r = await upstream('/models', { method: 'GET' }, id);
          if (r.ok) {
            models = (await r.json()).data?.map((model) => model.id)
              .filter((model) => !/(?:embed|embedding)/i.test(model)) ?? [];
            online = true;
          }
        } catch {
          // backend unavailable
        }
      }
      if (!models.length && backend.apiKey) models = [backend.model];
      return { id, label: backend.label, baseUrl: backend.baseUrl, model: backend.model, models, online };
    }));
    return json(res, 200, { providers, defaultProvider: process.env.LLM_PROVIDER ?? 'ollama' });
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  json(res, 405, { error: 'method not allowed' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`local-ai-chat  →  http://localhost:${PORT}`);
  console.log(`backends       →  ${Object.values(backends).map(({ label, baseUrl }) => `${label}: ${baseUrl}`).join(' | ')}`);
});
