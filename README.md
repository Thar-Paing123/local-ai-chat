# Local AI Code Assistant

A browser chat UI for coding help, served by your own Ollama or vLLM instance. Nothing
leaves the machine — no API keys, no network calls, works offline.

```
browser  →  node server.mjs (:5173)  →  Ollama (:11434)  →  selected local model
```

## Run it

```bash
ollama list              # see all installed models
node server.mjs          # → http://localhost:8000
```

That's the whole thing: no `npm install`, no build step, no dependencies.

## Optional cloud providers

Cloud models cannot be downloaded locally. They run on the provider's servers
and require provider API keys; usage may be billed and is not unlimited free
chat. Keep keys in your shell environment or a local `.env` file that is never
committed. Start from [`.env.example`](/Users/paingatvct/TSS/local-ai-chat/.env.example).

Supported provider key names:

| Provider | Environment variable |
|---|---|
| OpenAI / ChatGPT API | `OPENAI_API_KEY` |
| xAI / Grok API | `XAI_API_KEY` |
| Anthropic / Claude API | `ANTHROPIC_API_KEY` |
| Google / Gemini API | `GEMINI_API_KEY` |

For example, set a key in the current terminal before starting the app:

```bash
export OPENAI_API_KEY='your-key'
node server.mjs
```

For xAI/Grok, export a replacement key and use the launcher:

```bash
export XAI_API_KEY='your-key'
./xai-chat.sh
```

Gemini can be selected in Settings when started with a Gemini key:

```bash
export GEMINI_API_KEY='your-key'
node server.mjs
```

Do not paste API keys into browser JavaScript, chat messages, screenshots, or
source files. Provider access is separate from a ChatGPT web subscription.

### Use the installed Ollama models

The default backend is Ollama, and the Model selector lists its installed models:

```bash
node server.mjs
```

You can also choose a model at launch:

```bash
./ollama-chat.sh deepseek-r1:7b
```

### Use vLLM

vLLM is installed separately and currently serves the MLX Qwen model on port
8001. It does not automatically serve the Ollama models; those use Ollama's
runtime. To switch the chat UI to vLLM:

```bash
LLM_BASE_URL=http://127.0.0.1:8001/v1 \
LLM_API_KEY=local \
LLM_MODEL=mlx-community/Qwen2.5-7B-Instruct-4bit \
node server.mjs
```

Check or restart vLLM with:

```bash
./vllm-ctl.sh status
./vllm-ctl.sh restart
```

## Your setup, as detected

| | |
|---|---|
| Models | 8 Ollama models, selectable in the UI |
| Runtime | Ollama |
| Endpoint | `http://127.0.0.1:11434/v1`, API key `ollama` |
| Managed by | launchd job `com.line-translator.vllm` (KeepAlive → `kill` respawns it) |
| Throughput | ~17 tok/s generation |

Port 8000 is **not** free — `com.line-translator.api` (your Odoo
line-translation service) owns it. Don't start anything there.

## Pointing at a different backend

The browser only talks to `server.mjs`, so the backend is one env var. Any
OpenAI-compatible server works:

```bash
# vLLM elsewhere (e.g. a Linux/NVIDIA box on your LAN)
LLM_BASE_URL=http://192.168.1.50:8000/v1 LLM_API_KEY=… LLM_MODEL=qwen2.5-coder node server.mjs

# mlx_lm.server        (~/.venv-vllm-metal/bin/mlx_lm.server --port 8080)
LLM_BASE_URL=http://127.0.0.1:8080/v1 node server.mjs

# Ollama
LLM_BASE_URL=http://127.0.0.1:11434/v1 LLM_MODEL=qwen2.5-coder:7b node server.mjs
```

| var | default |
|---|---|
| `PORT` | `8000` |
| `LLM_BASE_URL` | `http://127.0.0.1:11434/v1` |
| `LLM_MODEL` | `qwen2.5-coder:7b` |
| `LLM_API_KEY` | `ollama` |

## Model storage

Installed model data is consolidated under `models/`:

- `models/ollama/` — Ollama models
- `models/huggingface/` — vLLM/MLX Hugging Face cache

Compatibility symlinks remain at the standard `~/.ollama/models` and
`~/.cache/huggingface` paths, so both runtimes continue to work.

## Features

- **Streaming** replies, token by token, with a `tok/s` readout per message
- **Markdown + syntax highlighting** for python, js/ts, sql, go, rust, bash, java, c — with per-block copy buttons
- **Attach files** (📎) to send code as context — they're inlined as fenced blocks
- **Conversations** saved in `localStorage`; rename-by-first-message, delete per thread
- **Editable system prompt**, temperature, and max tokens in the sidebar
- **Stop** mid-generation (the send button becomes ■) — this aborts upstream too, so the GPU stops working on it
- **Regenerate** the last reply
- Offline-capable: zero CDN or npm dependencies, dark/light via `prefers-color-scheme`

## The wedged-server failure mode

This bit the setup already: the instance found running had been up **8 days**
with `/v1/models` answering normally while generation hung forever — two
separate requests timed out past 120 s, and a `launchctl` restart fixed it
instantly. Likely the Metal context was lost across a sleep/wake while the HTTP
layer stayed alive.

Note what does **not** diagnose this: process memory. MLX keeps the weights in
Metal buffers, so a perfectly healthy engine core reports only ~30 MB RSS. A
`/health` or `/v1/models` ping doesn't catch it either — both answer from config
without touching the engine.

The only reliable check is a real completion, which is what
`./vllm-ctl.sh status` sends:

```
launchd job : pid 71677  (up 03:39)
engine core : present
http api    : responding on http://127.0.0.1:8001/v1
generation  : OK (0.6s to first token)
```

If it says `WEDGED`, fix it with:

```bash
./vllm-ctl.sh restart    # launchctl kickstart -k; plain kill just respawns the bad state
```

Because of `KeepAlive`, `kill <pid>` is never the right move — launchd
immediately restarts the job, which is what made the earlier debugging
confusing.

## Layout

```
server.mjs          static host + streaming proxy (no deps)
vllm-ctl.sh         status / restart / logs for the launchd job
public/index.html   markup
public/app.js       chat state, SSE streaming, threads, settings
public/markdown.js  dependency-free markdown renderer + highlighter
public/styles.css   theming
logs/               app.log, vllm.log
```

## Notes and limits

- 7B-4bit is solid for explanations, refactors, and small functions. For heavier
  code work, `Qwen2.5-Coder-7B-Instruct-4bit` is the better model at the same
  size — `mlx_lm.convert` or grab the MLX build from HF, then set `LLM_MODEL`.
- Context is capped by the server (32768 here). Long threads plus large
  attachments will hit it; start a new chat to reset.
- 18 GB RAM means one 7B model at a time. Running two vLLM instances made
  generation crawl until one was killed.
- Rendered model output is escaped before any markup is applied, so a reply
  containing HTML can't inject into the page.
