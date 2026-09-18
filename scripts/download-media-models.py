"""Download pinned media weights; resume partial files and verify publisher SHA256."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
import fcntl

ROOT = Path(__file__).resolve().parent.parent
models = json.loads((ROOT / 'scripts/media-models.json').read_text())
destination = ROOT / 'models/media'
destination.mkdir(parents=True, exist_ok=True)
lock = (destination / '.download.lock').open('w')
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit('Another media download is already running.')
def remaining(model):
    path = destination / model['path']
    if not path.exists():
        path = path.with_suffix(path.suffix + '.part')
    return max(0, model['size'] - (path.stat().st_size if path.exists() else 0))
needed = sum(remaining(model) for model in models)
if shutil.disk_usage(destination).free < needed + 15 * 1024**3:
    raise SystemExit('Not enough disk space: retain 15 GiB free after downloads.')
def download(model):
    target = destination / model['path']
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + '.part')
    if not target.exists():
        print('Downloading ' + model['path'], flush=True)
        url = f"https://huggingface.co/{model['repo']}/resolve/{model['revision']}/{model['file']}"
        subprocess.run(['curl', '-fL', '--no-progress-meter', '--retry', '5', '--connect-timeout', '30',
                        '--speed-limit', '1024', '--speed-time', '120', '-C', '-',
                        '-o', str(partial), url], check=True)
    candidate = target if target.exists() else partial
    print('Verifying ' + model['path'], flush=True)
    with candidate.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if candidate.stat().st_size != model['size'] or digest != model['sha256']:
        raise SystemExit(f'Integrity check failed: {candidate}; remove this file and retry.')
    if candidate == partial:
        partial.rename(target)
    print('Verified ' + model['path'], flush=True)

with ThreadPoolExecutor(max_workers=3) as pool:
    list(pool.map(download, models))
