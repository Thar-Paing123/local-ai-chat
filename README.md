# Local AI Code Assistant

## Local image and video creation

Click **Create images & videos** in the title bar, or open
<http://localhost:8000/media.html>. Start the generation engine in another terminal:

```bash
./media.sh
```

Choose a model, describe the scene, and click **Create**. **Stop generation** cancels
that job. The creation page shows the result and a download link. Generations remain
in `data/media/output/` even after closing the page. The page can reconnect to its
current job after a refresh; restarting the Node server clears its in-memory job
links, but does not delete generated files.

| Model | Default output | Model files on disk |
|---|---|---|
| Stable Diffusion 1.5 | 512 × 512 image | 4.27 GB |
| SDXL Base 1.0 | 768 × 768 image | 6.94 GB |
| Wan 2.1 T2V 1.3B | 416 × 240 silent video, 17 frames at 16 fps | 9.83 GB including text encoder and VAE |

These presets target the M3 Pro with 18 GB unified memory. Video is experimental
and intentionally starts with about a one-second draft. Longer or higher-resolution
video needs substantially more memory and time. Close heavy AI applications before
generating; the app submits one media job at a time. Wan's quantized text encoder
runs on CPU because Apple Metal does not support its FP8 storage format. Tiled VAE
decoding reduces memory use. The launcher retains PyTorch's default memory limits.
The Mac preset uses native PyTorch attention and BF16 computation. Wan uses the
Euler sampler: UniPC produced blank/neon frames during local verification,
consistent with a [reported MPS sampler issue](https://github.com/Comfy-Org/ComfyUI/issues/15921).

The isolated Python 3.12 environment is `.venv-media/`, ComfyUI lives in
`runtimes/ComfyUI/`, and weights live in `models/media/`. Outputs and runtime data
stay under `data/media/`. These large/local directories are excluded from Git.
ComfyUI listens only on `127.0.0.1:8188`, with cloud API nodes disabled. Its advanced
interface is at <http://127.0.0.1:8188>. This is separate from the Ollama chat model
selector. Media requests use the local engine regardless of the chat provider.

To reproduce the installation (requires Git, curl, and [uv](https://docs.astral.sh/uv/)):

```bash
./scripts/install-media.sh
```

The installer pins ComfyUI at `387f98aa2822f684b8597959a52a467d88cc4806`, uses
`scripts/media-requirements.lock`, resumes partial downloads, and verifies file sizes
and publisher SHA256 hashes from `scripts/media-models.json`. Approximately 21 GB
of weights plus the Python runtime are required; it keeps at least 15 GiB free.
The weights retain their publishers' licenses: SD 1.5 CreativeML Open RAIL-M,
SDXL CreativeML Open RAIL++-M, and Wan Apache 2.0. See the linked model repositories
in the manifest for license details.

`workflows/media/*-api.json` contains equivalent ComfyUI API graphs. The advanced
editor can open `workflows/media/wan-comfyui.json`, adapted from the
[official Wan example](https://comfyanonymous.github.io/ComfyUI_examples/wan/).
The simple creation page uses the presets in `media-service.mjs`.

For troubleshooting, run `./media.sh` in a terminal to see errors. After installing
models while the engine is running, click **Refresh** on the creation page. If a
generation exhausts memory, use SD 1.5 or reduce the advanced workflow's video
dimensions/frame count. Stop the media engine with Ctrl+C in its terminal.

Run project checks with `node --test tests/*.test.mjs`.

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

Requires Node.js 22.13 or newer for built-in SQLite. No `npm install` or build step is needed.

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
- **Conversations** saved in server-side SQLite; rename-by-first-message, delete per thread
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

## Editor workspace

The UI includes a VS Code–style explorer, editor tabs, a Changes panel, and an AI chat sidebar.

- Click **Open Folder** to choose a project and grant folder access. File contents stay in the browser until you explicitly add a file to chat.
- Click a file to edit it. Use **Save** or **⌘/Ctrl+S** to write changes in browsers that expose the native directory picker. Other browsers use folder upload and **Download** for edited files.
- **View changes** compares current text with the original version loaded when the file was opened. This is a session comparison, not Git status or a Git diff. Reopen the folder to reset it.
- **Add to chat** attaches the current file contents to your next message, which goes to your selected model provider.
- Use the assistant's menu for chat history and settings, or the activity bar to toggle the assistant.

Files larger than 400 KB and binary files cannot be edited. Dependency folders and `.git` are omitted. Unsaved edits trigger a warning before leaving; saving checks whether the file has changed externally before writing.

### Extensions

Click **Extensions** (the grid icon in the activity bar) to search available app add-ons, install them, or manage installed add-ons. Installation takes effect immediately and is remembered in this browser. Uninstall removes the add-on's behavior.

Included add-ons: **JSON Formatter** (adds a Format JSON editor action), **Larger Editor Text**, and **Editor Reading Lines**. These are bundled add-ons for this app; VS Code Marketplace extensions and `.vsix` packages cannot run here.

### Panel sizing, folding, and installation feedback

- Hover over the explorer/editor or editor/assistant border to reveal a **resize handle**. Drag left/right to resize. Double-click to reset, or focus the handle and use arrow keys. Widths are remembered in this browser.
- Use gutter arrows to fold individual code blocks, or **Fold blocks** to collapse all detected blocks. **Unfold to edit** returns to the editor. Folding is a read-only preview that preserves the full source for saving and chat. Block detection supports brace/bracket blocks and Python indentation; it is heuristic rather than a full language parser.
- Extension cards show **Installing…**, **Installed · Enabled**, and uninstall progress. Dismissible notifications report success, activation failures with retry, and preferences that could not be saved.

### Images and closing tabs

Paste an image into the chat input with **⌘/Ctrl+V**, or select an image with the attachment button. Previews can be removed before sending. PNG, JPEG, WebP, and GIF are supported, up to 2 MB each and four images per message. Choose a model with vision support to interpret them. Images are sent to the selected provider with the conversation; sent images are stored as attachment files on the server, with references in SQLite. Unsaved drafts stay in browser memory.

Use **×** on the Welcome tab or a file tab to close it. Closing an unsaved file asks whether to discard its edits. Closing Welcome leaves the center empty when there are no files open; Open Folder remains available in the title bar.

### Apply AI code to your folder

Completed AI code blocks have an **Apply to file…** button. Choose an existing file in the folder you opened, then click **Review changes** to load the proposed replacement into the editor's diff view. **Save** writes it to disk using the folder access you granted; browsers with read-only folder upload use Download instead. Nothing is written during review. Applying a code block replaces the whole file, so ask the assistant for the complete updated file. Unsaved edits require confirmation before replacement, and saving still checks for external changes.

The resize handles can use the available window width (there is no 600px maximum). The middle editor can shrink to 48px. Closing Welcome and all file tabs removes the middle section completely so chat fills the remaining space. Opening a file restores the editor; the explorer/chat border remains draggable while the editor is closed.

### AI file-access tools

Open a project folder and leave **AI folder access** checked above the chat input. Ask a question such as “Find where the server starts” or “Read public/styles.css and propose a change to the background.” The selected model can now call:

- `list_files`: paginated file paths within the opened folder.
- `read_file`: bounded line ranges from text files, including unsaved editor content.
- `search_files`: literal text searches with bounded results and pagination.
- `propose_file_edit`: a complete replacement of an existing file, shown as a **Review changes** card. Review loads the diff; **Save** writes to the folder.

The app automatically chooses native tool calling or a JSON compatibility mode. Ollama capability metadata identifies models without native tools; rejected tool requests and supported tool requests returned as plain JSON also trigger compatibility mode. Both modes use the same scoped file tools and review-only edit proposals. Models still need to follow instructions: malformed or ordinary text responses never execute file actions. The installed `qwen2.5-coder:7b` was verified live reading a test file and proposing an edit through this fallback. See [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling) for the native protocol.

Folder reads are sent to your selected model provider. Turn off **AI folder access** to revoke access for subsequent tool calls. Access is scoped to the folder selected in the browser; typing a path cannot grant access to another folder. Folder changes invalidate active tool sessions and old proposals. Proposals never automatically write, create, delete, or execute files. File text is limited to 400 KB, read results to 40,000 characters, searches to 100 files / 50 matches per call, and each reply to 24 tool rounds. Permission/read failures are reported as tool results. Refreshing requires selecting the folder again.

Run the dependency-free tool tests with:

```bash
node --test tests/file-tools.test.mjs
```


## Chat database and attachment storage

Chats now live on the Node.js server:

| Data | Default location |
|---|---|
| Chat messages, titles, tool activity, edit proposals, attachment metadata | `data/chats.sqlite` |
| Sent images and text attachment files | `data/attachments/` |
| Provider settings, extensions, panel widths | Browser localStorage |
| Project source files | Their original folders |

`data/` is excluded from Git. Set `CHAT_DATA_DIR=/absolute/path` before starting the server to use a different storage directory. The server uses [Node's built-in SQLite module](https://nodejs.org/api/sqlite.html); Node 22 may print an experimental-feature notice.

### Migrating existing chats

Reload the app in the **same browser and origin** where you used it before (for example, `http://localhost:8000`). The app imports `lac.threads` into SQLite before loading chats. The old browser value stays untouched as a migration backup. Imports are transactional and repeat-safe; conflicting server chats are preserved, and previously imported/deleted chats are not recreated. Embedded historical images become attachment files. Historical text attachments already embedded in message text remain preserved there; new text attachments also get separate files.

The migration runs in the browser because the server cannot read browser localStorage. If you used another port, hostname, or browser, that storage must be migrated from its original origin. Check **Chats saved on this computer** above the composer to confirm storage is connected.

### Saving and recovery

- User messages save before generation starts. Responses checkpoint every three seconds and save again on completion or Stop. A recovered checkpoint is labelled as interrupted.
- Image bytes are stored once and referenced by ID; the server reconstructs image payloads when sending to your model.
- Concurrent tabs use version checks. A conflicting tab cannot silently overwrite or delete a newer chat. Save errors show **Retry** and **Export JSON**; export unsaved text before reloading after a conflict. Exported JSON may reference attachment files, so it is not a complete standalone image backup.
- Deleting a chat removes its database record and attachment files that no other chat references.
- To back up everything, stop the server and copy the **entire data directory** (including SQLite sidecar files, if present, and `attachments/`). Restore the directory before starting the server.
- Draft input, pending attachments, and folder permissions still stay in browser memory. Database storage does not grant filesystem access to project folders.

Run automated tests with `node --test tests/*.test.mjs`.

## Coding agent workspace

Click **Connect agent folder…** in the title bar, enter the absolute project path on this Mac, and click **Connect folder**. This connects the explorer and AI file tools to the Node.js server's workspace. Browser-only **Open Folder** remains available for file viewing and single-file editing, but terminal, Git, batch edits, and undo require an agent connection. Reconnect after a reload; only the last folder path is remembered, not its access token.

### Multi-file edits and new files

Ask the assistant to inspect your project and propose a change. It can read files, make unique exact-text replacements, create new files, and group up to 30 changes in one proposal. Click **Review changes** to compare the before/after contents, then **Apply all to disk**. Nothing is written when a proposal is generated. All files are checked against their original contents before applying. Unsaved editor buffers must be saved or closed first.

The **›_ Agent tools** activity button opens terminal, source control, and history. **New file…** creates a manual new-file proposal. Open an applied change set in history and choose **Undo this change set** to restore original contents and remove files created by that change. Undo refuses to overwrite external edits. Individual files are written by atomic replacement; interrupted batches are marked for recovery. **Restore originals** rolls back a recoverable interrupted batch. A conflict requires manually reconciling the displayed before/after backups. Empty directories created for new files may remain after undo.

### Terminal and builds

The assistant can request commands through `run_command`; you can also enter a command in the terminal panel. The exact command and working folder are shown before **Run approved command** becomes available. **Reject** prevents execution; **Stop command** stops a running process group. Output, exit code, timeouts, and command history are retained. Commands default to a two-minute timeout (up to five minutes), with output capped at 200,000 characters. An approval can be used only once.

**Commands run as your macOS user, not inside a filesystem sandbox.** A command can access files outside its working directory, run project scripts or Git hooks, and use your Git credentials. Approve only commands you intend to run. Provider API-key environment variables are not passed into subprocesses. AI text and file contents cannot directly approve commands.

### Git

Use **Status**, **Diff**, and **Log** in the source-control panel, or ask the assistant to inspect Git. Connect the repository root for Git tools. Enter specific relative file paths (one per line) and a commit message, then choose **Review commit**. Only those files are committed; unrelated staged files remain staged. **Review push** shows the current branch and existing remote, and requires separate approval. Pushes do not force-update branches. Changing HEAD, remote URL, selected contents, or staging after preparation invalidates the corresponding approval. Git hooks may run during approved commits and pushes.

### Plans, progress, and recovery

The assistant has an `update_plan` tool with pending/in-progress/completed steps. Task state, plans, and tool-round checkpoints are saved with chat messages in `data/chats.sqlite`. Interrupted or review-pending tasks show **Continue task**. Reconnect the original agent folder before continuing. The next turn receives saved progress, rechecks files, and asks for fresh command approvals; commands are never automatically replayed after a restart.

Command jobs, before/after backups, and change-set history are stored in `data/agent.sqlite`. Include this file in whole-data-directory backups. Pending reviews survive reconnection. Running jobs become interrupted on an unexpected server restart, rather than being rerun; inspect their output and workspace before retrying. Graceful server shutdown and disconnection cancel running commands. After an abrupt process crash, detached subprocesses may need manual inspection before retrying.

Agent file APIs reject traversal, `.git` mutation, and symlinks. Connections are restricted to local same-origin requests and use per-connection tokens. File tools operate only inside the connected folder. This adds a local agent workflow; it does not guarantee that a small local model can correctly solve every coding task.
