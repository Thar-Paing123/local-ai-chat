import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createMediaService } from '../media-service.mjs';

test('media service submits local workflows, recovers results, and limits queue access', async t => {
  let queue = { queue_running: [], queue_pending: [] };
  let history = {};
  let submitted;
  let viewQuery;
  let cancelled;
  const backend = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/queue') return res.end(JSON.stringify(queue));
    if (url.pathname === '/prompt') {
      let body = ''; for await (const chunk of req) body += chunk;
      submitted = JSON.parse(body);
      return res.end(JSON.stringify({ prompt_id: 'job-1' }));
    }
    if (url.pathname === '/history/job-1') return res.end(JSON.stringify(history));
    if (url.pathname === '/api/jobs/job-1/cancel') { cancelled = true; return res.end('{"cancelled":true}'); }
    if (url.pathname === '/view') { viewQuery = url.searchParams; res.setHeader('content-type', 'image/png'); return res.end('image-bytes'); }
    if (url.pathname === '/object_info') return res.end(JSON.stringify({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['v1-5-pruned-emaonly.safetensors']] } } } }));
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => backend.close(resolve)));
  const service = createMediaService(`http://127.0.0.1:${backend.address().port}`);
  await assert.rejects(service.generate({ model: 'unknown', prompt: 'test' }), { status: 400 });
  await assert.rejects(service.generate({ model: 'sd15', prompt: ' ' }), { status: 400 });
  await assert.rejects(service.job('other-job'), { status: 404 });
  const status = await service.status();
  assert.equal(status.models.find(model => model.id === 'sd15').ready, true);
  assert.equal(status.models.find(model => model.id === 'wan').ready, false);
  const job = await service.generate({ model: 'sd15', prompt: 'A blue bird' });
  assert.equal(submitted.prompt['2'].inputs.text, 'A blue bird');
  assert.equal(submitted.prompt['7'].class_type, 'SaveImage');
  queue.queue_running = [[0, job.id]];
  assert.equal((await service.job(job.id)).status, 'running');
  await assert.rejects(service.generate({ model: 'sdxl', prompt: 'A lake' }), { status: 409 });
  queue.queue_running = [];
  history = { 'job-1': { status: { completed: true }, outputs: { '7': { images: [{ filename: 'bird.png', subfolder: 'images', type: 'output' }] } } } };
  const completed = await service.job(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.outputs[0].url, '/api/media/jobs/job-1/outputs/0');
  assert.equal(await (await service.output(job.id, 0)).text(), 'image-bytes');
  assert.equal(viewQuery.get('filename'), 'bird.png');
  await assert.rejects(service.output(job.id, 1), { status: 404 });
  await service.generate({ model: 'wan', prompt: 'Waves moving gently' });
  assert.equal(submitted.prompt['8'].inputs.device, 'cpu');
  assert.equal(submitted.prompt['5'].inputs.sampler_name, 'euler');
  assert.equal(submitted.prompt['7'].class_type, 'SaveWEBM');
  history = { 'job-1': { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'Out of memory' }]] } } };
  assert.equal((await service.job(job.id)).error, 'Out of memory');
  history = {};
  await service.generate({ model: 'sd15', prompt: 'A blue bird' });
  assert.equal((await service.cancel(job.id)).status, 'cancelled');
  assert.equal(cancelled, true);
  await assert.rejects(service.cancel('other-job'), { status: 404 });
});
