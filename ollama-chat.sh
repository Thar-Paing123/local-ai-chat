#!/usr/bin/env bash
set -euo pipefail

MODEL="${LLM_MODEL:-${1:-qwen2.5-coder:7b}}"
PORT="${PORT:-8000}"

if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null; then
  echo "Ollama is not running. Start Ollama, then run this script again." >&2
  exit 1
fi

echo "Starting local-ai-chat with Ollama model: $MODEL"
LLM_BASE_URL=http://127.0.0.1:11434/v1 \
LLM_API_KEY=ollama \
LLM_MODEL="$MODEL" \
PORT="$PORT" \
node server.mjs
