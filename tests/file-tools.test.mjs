import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileTools } from '../public/file-tools.js';
import { runToolChat, folderAccessReply, isFolderAccessQuestion } from '../public/tool-chat.js';

function fixture() {
  const text = new Map([['src/main.js', 'const value = 1;\n'], ['notes.txt', 'hello\nworld']]);
  const state = { id: 'workspace-1', name: 'Project', files: text, enabled: true };
  const session = createFileTools({ getWorkspace: () => ({ ...state }), getText: async path => text.get(path) })();
  return { session, state, text };
}
const signal = () => new AbortController().signal;
test('list/read/search stay in the granted folder and proposals do not write', async () => {
  const { session, text } = fixture();
  assert.equal((await session.execute('list_files', {}, signal())).total, 2);
  await assert.rejects(session.execute('read_file', { path: '../secret' }, signal()), /relative/);
  await assert.rejects(session.execute('read_file', { path: '/etc/passwd' }, signal()), /relative/);
  await assert.rejects(session.execute('read_file', { path: 'missing' }, signal()), /not found/);
  const read = await session.execute('read_file', { path: 'src/main.js' }, signal());
  assert.match(read.content, /value = 1/);
  const found = await session.execute('search_files', { query: 'value' }, signal());
  assert.equal(found.matches[0].path, 'src/main.js');
  const result = await session.execute('propose_file_edit', { path: 'src/main.js', revision: read.revision, content: 'const value = 2;\n', explanation: 'Update value' }, signal());
  assert.equal(result.status, 'awaiting_review'); assert.equal(text.get('src/main.js'), 'const value = 1;\n');
  text.set('src/main.js', 'external edit');
  await assert.rejects(session.execute('propose_file_edit', { path: 'src/main.js', revision: read.revision, content: 'replacement', explanation: 'Update' }, signal()), /changed/);
});
test('workspace changes, cancellation, binary content and unknown tools are rejected', async () => {
  const { session, state, text } = fixture();
  await assert.rejects(session.execute('delete_file', {}, signal()), /Unknown/);
  text.set('notes.txt', '\0binary'); await assert.rejects(session.execute('read_file', { path: 'notes.txt' }, signal()), /text files/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(session.execute('list_files', {}, controller.signal), /Stopped/);
  state.id = 'different'; await assert.rejects(session.execute('list_files', {}, signal()), /Folder changed/);
});
function response(chunks) {
  const raw = chunks.map(choice => `data: ${JSON.stringify({ choices: [choice] })}\r\n\r\n`).join('') + 'data: [DONE]';
  // Split SSE across arbitrary byte boundaries, including the final unterminated line.
  const bytes = new TextEncoder().encode(raw);
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 13) c.enqueue(bytes.slice(i, i + 13)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
test('streamed tool calls run and results feed the next model request', async () => {
  const { session } = fixture(); let turn = 0, output = '', revision; const proposals = [];
  await runToolChat({ payload: { messages: [{ role: 'user', content: 'Update value' }] }, session, signal: signal(), onText: t => output += t, onActivity() {}, onProposal: p => proposals.push(p), fetcher: async (_, init) => {
    const payload = JSON.parse(init.body); assert.equal(payload.tools.length, 4);
    if (turn++ === 0) return response([
      { delta: { tool_calls: [{ index: 0, id: 'read-1', function: { name: 'read_file', arguments: '{"path":' } }] } },
      { delta: { tool_calls: [{ index: 0, function: { arguments: '"src/main.js"}' } }] }, finish_reason: 'tool_calls' },
    ]);
    if (turn === 2) {
      const result = payload.messages.at(-1); assert.equal(result.role, 'tool'); assert.equal(result.tool_call_id, 'read-1'); revision = JSON.parse(result.content).revision;
      return response([{ delta: { tool_calls: [{ index: 0, id: 'edit-1', function: { name: 'propose_file_edit', arguments: JSON.stringify({ path: 'src/main.js', revision, content: 'const value = 2;', explanation: 'Update value' }) } }] }, finish_reason: 'tool_calls' }]);
    }
    assert.equal(JSON.parse(payload.messages.at(-1).content).status, 'awaiting_review');
    return response([{ delta: { content: 'Ready for review.' }, finish_reason: 'stop' }]);
  } });
  assert.equal(turn, 3); assert.equal(output, 'Ready for review.'); assert.equal(proposals.length, 1);
});
test('truncated tool calls never execute', async () => {
  let executed = false;
  await assert.rejects(runToolChat({ payload: { messages: [] }, session: { enabled: true, instruction: '', execute(name) { if (name === 'list_files') return { files: [], total: 0 }; executed = true; } }, signal: signal(), onText() {}, onActivity() {}, onProposal() {}, fetcher: async () => response([{ delta: { tool_calls: [{ index: 0, function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: 'length' }]) }), /Incomplete/);
  assert.equal(executed, false);
});
test('revoking access during an asynchronous read prevents returning contents', async () => {
  let resolveRead;
  const state = { id: 'first', name: 'project', enabled: true, files: new Map([['file.txt', true]]) };
  const session = createFileTools({ getWorkspace: () => ({ ...state }), getText: () => new Promise(resolve => { resolveRead = resolve; }) })();
  const request = session.execute('read_file', { path: 'file.txt' }, signal());
  state.id = 'revoked'; resolveRead('private content');
  await assert.rejects(request, /Folder changed/);
});
test('ordinary chat does not advertise tools without folder access', async () => {
  const session = createFileTools({ getWorkspace: () => ({ id: 'empty', enabled: false, files: new Map() }), getText() {} })();
  let output = '';
  await runToolChat({ payload: { messages: [{role:'user',content:'hello'}] }, session, signal: signal(), onText: text => output += text, onActivity() {}, onProposal() {}, fetcher: async (_, init) => {
    assert.equal(JSON.parse(init.body).tools, undefined);
    return response([{ delta: { content: 'Hello.' }, finish_reason: 'stop' }]);
  } });
  assert.equal(output, 'Hello.');
});

test('access questions use verified state, including disabled and missing folders', async () => {
  assert.equal(isFolderAccessQuestion('can you access my folder?'), true);
  assert.equal(isFolderAccessQuestion('can you read my files?'), true);
  assert.equal(isFolderAccessQuestion('Read my files and fix the bug'), false);
  const {session} = fixture();
  const answer = await folderAccessReply(session, signal());
  assert.match(answer, /Folder connection verified/);
  assert.match(answer, /src\/main.js/);
  assert.match(await folderAccessReply({ enabled: false, available: true }, signal()), /turned off/);
  assert.match(await folderAccessReply({ enabled: false, available: false }, signal()), /No folder is connected/);
});
test('runtime access and real filenames are included in one system message', async () => {
  const {session} = fixture();
  await runToolChat({payload: { messages: [{role:'system', content:'Original preferences'}, {role:'assistant',content:'I cannot access folders'}, {role:'user',content:'Explain this project'}] }, session, signal:signal(), onText() {}, onActivity() {}, onProposal() {}, fetcher: async (_,init) => {
    const body = JSON.parse(init.body), systems = body.messages.filter(m => m.role === 'system');
    assert.equal(systems.length, 1);
    assert.match(systems[0].content, /Original preferences/);
    assert.match(systems[0].content, /src\/main.js/);
    assert.match(systems[0].content, /you CAN list/);
    return response([{delta:{content:'Project files are available.'},finish_reason:'stop'}]);
  }});
});
