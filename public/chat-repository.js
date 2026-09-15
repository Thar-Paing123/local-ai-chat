export function createChatRepository({ fetcher = fetch, storage = localStorage, onStatus = () => {} } = {}) {
  const versions = new Map(), pending = new Map();
  let queue = Promise.resolve(), active = 0, lastError = '';
  async function request(path, method = 'GET', body) {
    const response = await fetcher(path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Storage request failed (${response.status}).`);
    return data;
  }
  function enqueue(operation) {
    active++; onStatus('Saving chat…', false);
    const task = queue.catch(() => {}).then(operation);
    queue = task;
    return task.then(result => { active--; if (!active) onStatus(pending.size ? `Chat not saved: ${lastError || 'Use Retry to save pending changes.'}` : 'Chats saved on this computer', pending.size > 0); return result; }, error => { active--; lastError = error.message; onStatus(`Chat not saved: ${error.message}`, true); throw error; });
  }
  return {
    async load() {
      onStatus('Loading chats…', false);
      let raw = null, marker = null;
      try { raw = storage.getItem('lac.threads'); marker = storage.getItem('lac.sqlite-imported.v1'); } catch {}
      const fingerprint = raw ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map(byte => byte.toString(16).padStart(2, '0')).join('') : null;
      if (raw && marker !== fingerprint) {
        const legacy = JSON.parse(raw);
        if (!Array.isArray(legacy)) throw new Error('Old browser history is invalid. It has been left untouched.');
        if (legacy.length) await request('/api/threads/import', 'POST', { threads: legacy });
        // Keep the original browser history untouched as a migration backup.
        // A small digest avoids doubling image-heavy localStorage usage.
        try { storage.setItem('lac.sqlite-imported.v1', fingerprint); } catch {}
      }
      const result = await request('/api/threads');
      if (!Array.isArray(result.threads)) throw new Error('Invalid chat storage response.');
      for (const thread of result.threads) versions.set(thread.id, thread.version);
      onStatus('Chats saved on this computer', false);
      return result.threads;
    },
    save(thread) {
      const snapshot = JSON.parse(JSON.stringify(thread)); pending.set(thread.id, snapshot);
      return enqueue(async () => {
        const result = await request(`/api/threads/${encodeURIComponent(snapshot.id)}`, 'PUT', { thread: snapshot, version: versions.get(snapshot.id) || 0 });
        versions.set(snapshot.id, result.thread.version); thread.version = result.thread.version;
        // Replace large inline images with server references only if a message is unchanged.
        result.thread.messages.forEach((saved, i) => {
          if (thread.messages[i] && JSON.stringify(thread.messages[i].content) === JSON.stringify(snapshot.messages[i].content)) thread.messages[i].content = saved.content;
          if (thread.messages[i] && JSON.stringify(thread.messages[i].attachments) === JSON.stringify(snapshot.messages[i].attachments)) thread.messages[i].attachments = saved.attachments;
        });
        if (pending.get(snapshot.id) === snapshot) pending.delete(snapshot.id);
        return result.thread;
      });
    },
    remove(thread) {
      return enqueue(async () => {
        await request(`/api/threads/${encodeURIComponent(thread.id)}`, 'DELETE', { version: versions.get(thread.id) || 0 });
        versions.delete(thread.id); pending.delete(thread.id);
      });
    },
    async retry() { for (const thread of [...pending.values()]) await this.save(thread); },
    get unsaved() { return active > 0 || pending.size > 0; },
  };
}
