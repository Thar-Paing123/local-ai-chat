import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const imagePattern = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/;
const referencePattern = /^\/api\/attachments\/([a-f0-9]{64})$/;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const hash = value => createHash('sha256').update(value).digest('hex');
export function createChatStorage(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const attachmentDirectory = join(directory, 'attachments');
  mkdirSync(attachmentDirectory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'chats.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS thread_attachments(thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE, attachment_id TEXT REFERENCES attachments(id), PRIMARY KEY(thread_id, attachment_id));
    CREATE TABLE IF NOT EXISTS imports(fingerprint TEXT PRIMARY KEY, thread_id TEXT NOT NULL);
    PRAGMA user_version=1;`);
  let createdFiles = [];
  const transaction = operation => {
    createdFiles = [];
    db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); for (const path of createdFiles) { try { unlinkSync(path); } catch {} } throw error; }
  };
  function attachment(bytes, mime, name = 'attachment') {
    const limit = mime.startsWith('image/') ? 2 * 1024 * 1024 : 400000;
    if (bytes.length > limit) fail('Attachment exceeds size limit.');
    const id = hash(Buffer.concat([Buffer.from(mime), bytes]));
    const target = join(attachmentDirectory, id);
    if (!existsSync(target)) {
      const temp = `${target}.${randomUUID()}.tmp`;
      try { writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' }); renameSync(temp, target); createdFiles.push(target); }
      finally { if (existsSync(temp)) unlinkSync(temp); }
    }
    db.prepare('INSERT OR IGNORE INTO attachments VALUES (?, ?, ?)').run(id, mime, bytes.length);
    return { id, name: String(name).slice(0, 500), mime, size: bytes.length, url: `/api/attachments/${id}` };
  }
  function existing(url, name) {
    const match = referencePattern.exec(url || '');
    if (!match) fail('Invalid attachment reference.');
    const row = db.prepare('SELECT * FROM attachments WHERE id=?').get(match[1]);
    if (!row || !existsSync(join(attachmentDirectory, row.id))) fail('Attachment is missing.', 404);
    return { ...row, name: String(name || 'Attached image').slice(0, 500), url };
  }
  function image(url, name) {
    const match = imagePattern.exec(url || '');
    if (!match) {
      const item = existing(url, name);
      if (!item.mime.startsWith('image/')) fail('Expected an image attachment.');
      return item;
    }
    if (match[2].length % 4 !== 0) fail('Invalid base64 image.');
    return attachment(Buffer.from(match[2], 'base64'), match[1], name || 'Attached image');
  }
  function normalize(input) {
    if (!input || typeof input.id !== 'string' || !/^[\w-]{1,100}$/.test(input.id)) fail('Invalid thread ID.');
    if (typeof input.title !== 'string' || input.title.length > 2000 || !Array.isArray(input.messages) || input.messages.length > 10000) fail('Invalid thread.');
    const refs = new Set();
    const messages = input.messages.map(message => {
      if (!message || !['user', 'assistant'].includes(message.role)) fail('Invalid message role.');
      const copy = { ...message, streaming: false };
      if (message.streaming) copy.interrupted = true;
      if (typeof message.content === 'string') copy.content = message.content;
      else if (Array.isArray(message.content)) copy.content = message.content.map(part => {
        if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
        if (part.type === 'image_url') { const item = image(part.image_url?.url); refs.add(item.id); return { type: 'image_url', image_url: { url: item.url } }; }
        fail('Invalid message content.');
      }); else fail('Invalid message content.');
      if (message.attachments) {
        if (!Array.isArray(message.attachments)) fail('Invalid attachments.');
        copy.attachments = message.attachments.map(a => {
          let item;
          if (typeof a.dataUrl === 'string') item = image(a.dataUrl, a.name);
          else if (typeof a.text === 'string') item = attachment(Buffer.from(a.text), 'text/plain; charset=utf-8', a.name);
          else item = existing(a.url, a.name);
          refs.add(item.id); return item;
        });
      }
      return copy;
    });
    return { thread: { id: input.id, title: input.title, createdAt: Number.isSafeInteger(input.createdAt) ? input.createdAt : Date.now(), messages }, refs };
  }
  function readRow(row) { return { ...JSON.parse(row.payload), version: row.version }; }
  function put(input, expected) {
    const current = db.prepare('SELECT version FROM threads WHERE id=?').get(input?.id);
    if ((current?.version || 0) !== expected) fail('Chat changed in another tab. Reload before saving to avoid overwriting it.', 409);
    const { thread, refs } = normalize(input), version = expected + 1;
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at, version=excluded.version, payload=excluded.payload')
      .run(thread.id, thread.title, thread.createdAt, Date.now(), version, JSON.stringify(thread));
    db.prepare('DELETE FROM thread_attachments WHERE thread_id=?').run(thread.id);
    for (const id of refs) db.prepare('INSERT INTO thread_attachments VALUES (?, ?)').run(thread.id, id);
    return { ...thread, version };
  }
  return {
    list() { return db.prepare('SELECT * FROM threads ORDER BY created_at DESC, id').all().map(readRow); },
    save(input, version) { if (!Number.isInteger(version) || version < 0) fail('Invalid version.'); return transaction(() => put(input, version)); },
    import(threads) {
      if (!Array.isArray(threads) || threads.length > 5000) fail('Invalid import.');
      return transaction(() => threads.map(original => {
        const fingerprint = hash(JSON.stringify(original));
        const prior = db.prepare('SELECT thread_id FROM imports WHERE fingerprint=?').get(fingerprint);
        if (prior) return prior.thread_id;
        const thread = { ...original };
        if (db.prepare('SELECT id FROM threads WHERE id=?').get(thread.id)) thread.id = randomUUID();
        const saved = put(thread, 0);
        db.prepare('INSERT INTO imports VALUES (?, ?)').run(fingerprint, saved.id);
        return saved.id;
      }));
    },
    delete(id, version) {
      transaction(() => {
        const row = db.prepare('SELECT version FROM threads WHERE id=?').get(id);
        if (!row) return;
        if (row.version !== version) fail('Chat changed in another tab. Reload before deleting it.', 409);
        db.prepare('DELETE FROM threads WHERE id=?').run(id);
      });
      // Referenced attachments are shared across chats; remove only unreferenced ones.
      for (const item of db.prepare('SELECT id FROM attachments WHERE id NOT IN (SELECT attachment_id FROM thread_attachments)').all()) {
        try { unlinkSync(join(attachmentDirectory, item.id)); } catch (error) { if (error.code !== 'ENOENT') continue; }
        db.prepare('DELETE FROM attachments WHERE id=?').run(item.id);
      }
    },
    getAttachment(id) {
      if (!/^[a-f0-9]{64}$/.test(id)) fail('Invalid attachment ID.');
      const row = db.prepare('SELECT * FROM attachments WHERE id=?').get(id);
      if (!row) fail('Attachment not found.', 404);
      return { ...row, bytes: readFileSync(join(attachmentDirectory, id)) };
    },
    hydrate(messages) {
      return messages.map(message => ({ ...message, content: Array.isArray(message.content) ? message.content.map(part => {
        if (part.type !== 'image_url' || !referencePattern.test(part.image_url?.url || '')) return part;
        const item = this.getAttachment(referencePattern.exec(part.image_url.url)[1]);
        if (!item.mime.startsWith('image/')) fail('Expected an image.');
        return { type: 'image_url', image_url: { url: `data:${item.mime};base64,${item.bytes.toString('base64')}` } };
      }) : message.content }));
    },
    close() { db.close(); },
  };
}
