import { randomInt } from 'node:crypto';

export const MEDIA_MODELS = {
  sd15: { label: 'Stable Diffusion 1.5', kind: 'image', file: 'v1-5-pruned-emaonly.safetensors', width: 512, height: 512 },
  sdxl: { label: 'SDXL Base', kind: 'image', file: 'sd_xl_base_1.0.safetensors', width: 768, height: 768 },
  wan: { label: 'Wan 2.1 1.3B', kind: 'video', file: 'wan2.1_t2v_1.3B_fp16.safetensors', width: 416, height: 240 },
};

export function mediaWorkflow(model, prompt, seed = randomInt(2 ** 48 - 1)) {
  const spec = Object.hasOwn(MEDIA_MODELS, model) ? MEDIA_MODELS[model] : null;
  if (!spec) throw new Error('Choose a supported model.');
  const node = (class_type, inputs) => ({ class_type, inputs });
  const graph = {
    '2': node('CLIPTextEncode', { text: prompt, clip: ['1', 1] }),
    '3': node('CLIPTextEncode', { text: 'blurry, low quality, distorted, watermark, text', clip: ['1', 1] }),
    '4': node('EmptyLatentImage', { width: spec.width, height: spec.height, batch_size: 1 }),
    '5': node('KSampler', { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 }),
    '6': node('VAEDecodeTiled', { samples: ['5', 0], vae: ['1', 2], tile_size: 256, overlap: 64, temporal_size: 16, temporal_overlap: 4 }),
    '7': node('SaveImage', { images: ['6', 0], filename_prefix: `images/${model}` }),
    '1': node('CheckpointLoaderSimple', { ckpt_name: spec.file }),
  };
  if (model === 'wan') {
    graph['1'] = node('UNETLoader', { unet_name: spec.file, weight_dtype: 'default' });
    graph['8'] = node('CLIPLoader', { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'cpu' });
    graph['9'] = node('VAELoader', { vae_name: 'wan_2.1_vae.safetensors' });
    graph['10'] = node('ModelSamplingSD3', { model: ['1', 0], shift: 8 });
    graph['2'].inputs.clip = graph['3'].inputs.clip = ['8', 0];
    graph['4'] = node('EmptyHunyuanLatentVideo', { width: spec.width, height: spec.height, length: 17, batch_size: 1 });
    // UniPC can diverge on Apple's MPS backend; use Euler for this Mac preset.
    Object.assign(graph['5'].inputs, { model: ['10', 0], steps: 20, cfg: 6, sampler_name: 'euler', scheduler: 'simple' });
    graph['6'].inputs.vae = ['9', 0];
    graph['7'] = node('SaveWEBM', { images: ['6', 0], filename_prefix: 'videos/wan', codec: 'vp9', fps: 16, crf: 28 });
  }
  return graph;
}

export function createMediaService(base = 'http://127.0.0.1:8188') {
  const jobs = new Map();
  let submitting = false;
  async function upstream(path, body) {
    let response;
    try {
      response = await fetch(base + path, { signal: AbortSignal.timeout(15000), ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    } catch { throw Object.assign(new Error('Media engine is offline. Run ./media.sh in the project folder.'), { status: 503 }); }
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw Object.assign(new Error(error.error?.message || `Media engine returned ${response.status}.`), { status: 502 });
    }
    return response;
  }
  async function state(id) {
    const job = jobs.get(id);
    if (!job) throw Object.assign(new Error('Generation not found. Files remain in data/media/output after a server restart.'), { status: 404 });
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    const history = await (await upstream(`/history/${encodeURIComponent(id)}`)).json();
    const result = history[id];
    if (result) {
      const failure = result.status?.messages?.find(([type]) => type === 'execution_error' || type === 'execution_interrupted');
      if (failure || result.status?.status_str === 'error') {
        job.status = 'failed';
        job.error = failure?.[1]?.exception_message || 'Generation stopped or failed. Check logs/media.log.';
      } else if (result.status?.completed) {
        job.files = Object.values(result.outputs || {}).flatMap(value => [...(value.images || []), ...(value.videos || []), ...(value.gifs || [])])
          .filter(file => file.type === 'output' && /\.(png|webm|mp4)$/i.test(file.filename));
        job.status = job.files.length ? 'completed' : 'failed';
        if (!job.files.length) job.error = 'The engine finished without a supported output file.';
      }
    }
    if (job.status === 'queued' || job.status === 'running') {
      const queue = await (await upstream('/queue')).json();
      job.status = queue.queue_running?.some(item => item[1] === id) ? 'running' : 'queued';
    }
    return job;
  }
  return {
    async status() {
      try {
        const info = await (await upstream('/object_info')).json();
        const checkpoints = info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
        const diffusion = info.UNETLoader?.input?.required?.unet_name?.[0] || [];
        const encoders = info.CLIPLoader?.input?.required?.clip_name?.[0] || [];
        const vaes = info.VAELoader?.input?.required?.vae_name?.[0] || [];
        return { online: true, models: Object.entries(MEDIA_MODELS).map(([id, model]) => ({ id, ...model, ready: id === 'wan' ? diffusion.includes(model.file) && encoders.includes('umt5_xxl_fp8_e4m3fn_scaled.safetensors') && vaes.includes('wan_2.1_vae.safetensors') : checkpoints.includes(model.file) })) };
      } catch (error) { return { online: false, error: error.message, models: [] }; }
    },
    async generate(input = {}) {
      const { model, prompt } = input || {};
      if (!Object.hasOwn(MEDIA_MODELS, model) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2000) throw Object.assign(new Error('Choose a model and enter a prompt of 1–2000 characters.'), { status: 400 });
      if (submitting) throw Object.assign(new Error('A generation is being submitted. Try again shortly.'), { status: 409 });
      submitting = true;
      try {
        const queue = await (await upstream('/queue')).json();
        if (queue.queue_running?.length || queue.queue_pending?.length) throw Object.assign(new Error('The media engine is busy. Wait for the current generation to finish.'), { status: 409 });
        const { prompt_id } = await (await upstream('/prompt', { prompt: mediaWorkflow(model, prompt.trim()) })).json();
        if (!prompt_id) throw new Error('The engine did not return a generation ID.');
        jobs.set(prompt_id, { id: prompt_id, model, status: 'queued', files: [] });
        if (jobs.size > 100) jobs.delete(jobs.keys().next().value);
        return { id: prompt_id };
      } finally { submitting = false; }
    },
    async job(id) {
      const job = await state(id);
      return { id, model: job.model, status: job.status, error: job.error, outputs: job.files.map((file, index) => ({ url: `/api/media/jobs/${id}/outputs/${index}`, kind: /\.(webm|mp4)$/i.test(file.filename) ? 'video' : 'image', filename: file.filename })) };
    },
    async cancel(id) {
      const job = await state(id);
      if (['completed', 'failed', 'cancelled'].includes(job.status)) return { status: job.status };
      // This pinned ComfyUI version cancels one job atomically.
      const result = await (await upstream(`/api/jobs/${encodeURIComponent(id)}/cancel`, {})).json();
      if (result.cancelled) job.status = 'cancelled';
      return { status: (await state(id)).status };
    },
    async output(id, index) {
      const job = await state(id);
      const file = job.files[index];
      if (!file) throw Object.assign(new Error('Output not found.'), { status: 404 });
      return upstream('/view?' + new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: 'output' }));
    },
  };
}
