const $ = id => document.getElementById(id);
let models = [];
let busy = false;
let pollTimer;
let currentId;
async function api(path, body) {
  const response = await fetch(`/api/media/${path}`, { signal: AbortSignal.timeout(20000), ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Media request failed.');
  return result;
}
function updateControls() {
  const model = models.find(item => item.id === $('media-model').value);
  $('generate').disabled = busy || !model?.ready;
  $('media-model').disabled = busy || !models.length;
  $('cancel').hidden = !currentId || !busy;
  $('model-note').textContent = model ? model.kind === 'video' ? 'Short video draft · 416 × 240 · 17 frames, about 1 second. Experimental on this Mac.' : `${model.width} × ${model.height} image · 20 steps` : '';
}
async function refresh() {
  $('refresh').disabled = true;
  try {
    const result = await api('status');
    $('engine-status').textContent = result.online ? 'Media engine online' : 'Media engine offline';
    $('engine-help').hidden = result.online;
    const selected = $('media-model').value;
    models = result.models;
    $('media-model').replaceChildren(...models.map(model => {
      const option = new Option(model.label + (model.ready ? '' : ' — not installed yet'), model.id);
      option.disabled = !model.ready;
      return option;
    }));
    $('media-model').value = models.find(m => m.id === selected && m.ready)?.id || models.find(m => m.ready)?.id || '';
    if (!models.length) $('media-model').append(new Option('Start the media engine to see models', ''));
    updateControls();
  } catch (error) {
    $('engine-status').textContent = error.message;
    $('engine-help').hidden = false;
    models = [];
    updateControls();
  } finally { $('refresh').disabled = false; }
}
async function poll(id) {
  clearTimeout(pollTimer);
  try {
    const job = await api(`jobs/${id}`);
    if (id !== currentId) return;
    if (job.status === 'failed' || job.status === 'cancelled') {
      currentId = null;
      sessionStorage.removeItem('media-job');
      throw new Error(job.error || (job.status === 'cancelled' ? 'Generation stopped.' : 'Generation failed.'));
    }
    if (job.status === 'completed') {
      $('generation-status').textContent = 'Your creation is ready.';
      $('results').replaceChildren();
      for (const output of job.outputs) {
        const media = document.createElement(output.kind === 'video' ? 'video' : 'img');
        media.src = output.url;
        if (output.kind === 'video') { media.controls = true; media.loop = true; media.playsInline = true; }
        else media.alt = 'Generated image';
        const link = document.createElement('a');
        link.href = output.url;
        link.download = output.filename;
        link.textContent = `Download ${output.kind}`;
        $('results').append(media, link);
      }
      busy = false;
      currentId = null;
      sessionStorage.removeItem('media-job');
      updateControls();
      return;
    }
    $('generation-status').textContent = job.status === 'running' ? 'Creating… First generation also loads model weights. You can leave this page and come back.' : 'Queued — waiting for the media engine…';
    pollTimer = setTimeout(() => poll(id), 3000);
  } catch (error) {
    if (currentId && id !== currentId) return;
    $('generation-status').textContent = error.message;
    busy = false;
    updateControls();
    // Keep the job ID so Refresh can recover from a temporary connection failure.
  }
}
$('create-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  clearTimeout(pollTimer);
  currentId = null;
  busy = true;
  updateControls();
  $('generation-status').textContent = 'Submitting your creation…';
  try {
    const { id } = await api('generate', { model: $('media-model').value, prompt: $('media-prompt').value });
    currentId = id;
    updateControls();
    sessionStorage.setItem('media-job', id);
    $('results').replaceChildren();
    await poll(id);
  } catch (error) {
    $('generation-status').textContent = error.message;
    busy = false;
    updateControls();
  }
});
$('media-model').addEventListener('change', updateControls);
$('cancel').addEventListener('click', async () => {
  if (!currentId) return;
  $('cancel').disabled = true;
  try { await api(`jobs/${currentId}/cancel`, {}); await poll(currentId); }
  catch (error) { $('generation-status').textContent = error.message; }
  finally { $('cancel').disabled = false; }
});
$('refresh').addEventListener('click', async () => { await refresh(); if (currentId) { busy = true; updateControls(); await poll(currentId); } });
await refresh();
currentId = sessionStorage.getItem('media-job');
if (currentId) { busy = true; updateControls(); await poll(currentId); }
