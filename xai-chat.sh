#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${XAI_API_KEY:-}" ]]; then
  echo "XAI_API_KEY is not set. Export a replacement key before starting." >&2
  exit 1
fi

PORT="${PORT:-8000}"
MODEL="${LLM_MODEL:-grok-3-mini}"

echo "Starting local-ai-chat with xAI model: $MODEL"
LLM_PROVIDER=grok \
XAI_API_KEY="$XAI_API_KEY" \
LLM_MODEL="$MODEL" \
PORT="$PORT" \
node server.mjs