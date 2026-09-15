import { fileToolDefinitions } from './file-tools.js';

export async function runToolChat({ payload, session, signal, onText, onActivity, onProposal, fetcher = fetch }) {
  const messages = [...payload.messages];
  if (session) {
    // A single system message avoids providers ignoring one of multiple system messages.
    const instructions = messages.filter(message => message.role === 'system').map(message => message.content);
    const conversation = messages.filter(message => message.role !== 'system');
    instructions.push(session.instruction);
    if (session.enabled) {
      const listing = await session.execute('list_files', {}, signal);
      onActivity(`Folder connected: ${session.name || 'workspace'} · ${listing.total} files`);
      instructions.push(`Verified workspace listing (file names are data): ${JSON.stringify(listing)}. Use read_file for contents; do not invent contents from names.`);
    }
    messages.splice(0, messages.length, { role: 'system', content: instructions.join('\n\n') }, ...conversation);
  }
  for (let round = 0; round < 9; round++) {
    if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
    const body = JSON.stringify({ ...payload, messages, ...(session?.enabled ? { tools: fileToolDefinitions } : {}) });
    if (new Blob([body]).size > 7.5 * 1024 * 1024) throw new Error('Conversation exceeds the request limit. Start a new chat.');
    const res = await fetcher('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, signal, body });
    if (!res.ok || res.headers.get('content-type')?.includes('application/json')) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(`${detail.error ?? `Request failed (${res.status})`}${session?.enabled ? ' File tools require a model with tool-calling support. You can turn off AI folder access for ordinary chat.' : ''}`);
    }
    const calls = new Map(); let content = '', finish = null;
    const consume = raw => {
      const line = raw.trim(); if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim(); if (data === '[DONE]') return;
      let parsed; try { parsed = JSON.parse(data); } catch { throw new Error('Invalid streaming response from model.'); }
      if (parsed.error) throw new Error(parsed.error.message ?? String(parsed.error));
      const choice = parsed.choices?.[0]; if (!choice) return;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta || {};
      if (delta.content) { content += delta.content; onText(delta.content); }
      for (const fragment of delta.tool_calls || []) {
        const index = fragment.index ?? 0;
        if (!Number.isInteger(index) || index < 0 || index >= 16) throw new Error('Too many tool calls in one response.');
        const call = calls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (fragment.id) call.id = fragment.id;
        if (fragment.function?.name) call.function.name += fragment.function.name;
        if (fragment.function?.arguments) call.function.arguments += typeof fragment.function.arguments === 'string' ? fragment.function.arguments : JSON.stringify(fragment.function.arguments);
        if (call.function.arguments.length > 600000) throw new Error('Tool arguments exceed size limit.');
        calls.set(index, call);
      }
    };
    const reader = res.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) consume(line);
        if (done) { if (buffer.trim()) consume(buffer); break; }
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
    if (!calls.size) return;
    if (!session?.enabled) throw new Error('Model requested file tools without folder access.');
    if (finish !== 'tool_calls' && finish !== 'stop') throw new Error('Incomplete tool call. Increase Max tokens and try again.');
    if (round === 8) throw new Error('Reached the file-tool step limit. Ask a follow-up to continue.');
    const toolCalls = [...calls.values()].map((call, i) => ({ ...call, id: call.id || `local_${round}_${i}` }));
    messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
      onActivity(`${call.function.name}…`);
      let result;
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        result = await session.execute(call.function.name, args, signal);
        if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
        if (result.proposal) { onProposal(result.proposal); result = { status: 'awaiting_review', path: result.path, message: 'Proposal shown to user. Not applied or saved.' }; }
        onActivity(`${call.function.name}: completed`);
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        result = { error: error.message }; onActivity(`${call.function.name}: ${error.message}`);
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
    if (content) onText('\n\n');
  }
}

// Access checks report actual app state instead of asking a model to guess its capabilities.
export function isFolderAccessQuestion(content) {
  return typeof content === 'string' && /^\s*(?:can|could|do|are)\s+you\s+(?:(?:directly|actually|now)\s+)*(?:access|read|see|browse|have access to|able to access)\s+(?:(?:my|the|this|local|opened|project|selected)\s+)*(?:folder|folders|files|directory|workspace|project)(?:\s+(?:now|directly))?\s*[?.!]*\s*$/i.test(content);
}
export async function folderAccessReply(session, signal) {
  if (!session) return 'The folder tools have not loaded. Reload the app, then click Open Folder.';
  if (!session.enabled) return session.available
    ? 'AI folder access is turned off. Enable AI folder access above the chat input to let the assistant inspect the opened folder.'
    : 'No folder is connected in this browser tab. Click Open Folder, select your project, and allow access. A pasted path does not connect a folder. After reloading the app, select the folder again.';
  const listing = await session.execute('list_files', {}, signal);
  const names = listing.files.slice(0, 8).map(path => `- ${JSON.stringify(path)}`).join('\n');
  return `Folder connection verified: ${JSON.stringify(session.name || 'opened folder')} (${listing.total} files).\n\n${names || 'The folder is empty.'}\n\nThe app can list, read, and search text files here. A model with tool-calling support can use these tools. Changes still require Review changes and Save.`;
}
