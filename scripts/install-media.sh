#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v uv >/dev/null || { echo 'Install uv first: https://docs.astral.sh/uv/'; exit 1; }
COMFY_REVISION=387f98aa2822f684b8597959a52a467d88cc4806
mkdir -p runtimes logs
if [[ ! -d runtimes/ComfyUI/.git ]]; then
  git clone https://github.com/Comfy-Org/ComfyUI.git runtimes/ComfyUI
  git -C runtimes/ComfyUI checkout "$COMFY_REVISION"
elif [[ "$(git -C runtimes/ComfyUI rev-parse HEAD)" != "$COMFY_REVISION" ]]; then
  echo 'Existing ComfyUI has a different revision. Keep it intact and review README.md.' >&2
  exit 1
fi
if [[ ! -x .venv-media/bin/python ]]; then uv venv --python 3.12 .venv-media; fi
uv pip install --python .venv-media/bin/python -r scripts/media-requirements.lock
.venv-media/bin/python scripts/download-media-models.py
echo 'Installed. Start ./media.sh, then open Create images & videos in the chat app.'
