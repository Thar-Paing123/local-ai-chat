#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
MEDIA_ROOT="$PWD"
if [[ ! -x .venv-media/bin/python || ! -f runtimes/ComfyUI/main.py ]]; then
  echo 'Media runtime is missing. See README.md for installation instructions.' >&2
  exit 1
fi
mkdir -p data/media/output data/media/input data/media/user data/media/temp
export PYTORCH_ENABLE_MPS_FALLBACK=1
exec .venv-media/bin/python runtimes/ComfyUI/main.py \
  --listen 127.0.0.1 --port 8188 --disable-auto-launch --disable-api-nodes \
  --extra-model-paths-config "$MEDIA_ROOT/media-model-paths.yaml" \
  --output-directory "$MEDIA_ROOT/data/media/output" \
  --input-directory "$MEDIA_ROOT/data/media/input" \
  --user-directory "$MEDIA_ROOT/data/media/user" \
  --temp-directory "$MEDIA_ROOT/data/media/temp" \
  --lowvram --reserve-vram 4 --cache-none --use-pytorch-cross-attention \
  --bf16-unet --bf16-text-enc --preview-method none "$@"
