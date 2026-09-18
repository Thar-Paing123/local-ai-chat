import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync, lstatSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, join, relative, dirname, basename, isAbsolute, sep } from 'node:path';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const ignored = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.DS_Store']);
const digest = text => createHash('sha256').update(text ?? '<missing>').digest('hex');
export function createAgentService(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'agent.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, root TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS changesets(id TEXT PRIMARY KEY, root TEXT NOT NULL, payload TEXT NOT NULL);`);
  const sessions = new Map(), processes = new Map(), locks = new Set();
  const save = (table, item) => db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`).run(item.id, item.root, JSON.stringify(item));
  const all = (table, root) => db.prepare(`SELECT payload FROM ${table} WHERE root=? ORDER BY rowid DESC LIMIT 100`).all(root).map(row => JSON.parse(row.payload));
  for (const row of db.prepare('SELECT payload FROM jobs').all()) {
    const job = JSON.parse(row.payload);
    if (job.status === 'running') { job.status = 'interrupted'; job.output += '\nServer restarted. Execution outcome is unknown; inspect the workspace before retrying.'; save('jobs', job); }
  }
  for (const row of db.prepare('SELECT payload FROM changesets').all()) {
    const item = JSON.parse(row.payload);
    if (['applying', 'undoing'].includes(item.status)) { item.status = 'needs_recovery'; save('changesets', item); }
  }
  function workspace(token) {
    const session = sessions.get(token);
    if (!session) fail('Connect an agent folder first. Connection expired or was revoked.', 403);
    if (realpathSync(session.root) !== session.root) fail('Workspace root changed. Reconnect.', 409);
    return session;
  }
  function target(root, name, allowMissing = false) {
    if (typeof name !== 'string' || !name || name.includes('\0') || name.includes('\\') || isAbsolute(name) || name.split('/').some(p => !p || p === '.' || p === '..' || p === '.git')) fail('Use a relative file path inside the project; .git is protected.');
    const path = resolve(root, name), rel = relative(root, path);
    if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('Path escapes the workspace.');
    let part = root;
    for (const component of name.split('/')) {
      part = join(part, component);
      try { if (lstatSync(part).isSymbolicLink()) fail('Symlinks are not allowed for agent file operations.'); }
      catch (error) { if (error.code !== 'ENOENT' || !allowMissing) throw error; }
    }
    return path;
  }
  function text(root, name, missing = false) {
    const file = target(root, name, missing);
    if (!existsSync(file)) { if (missing) return null; fail('File not found.', 404); }
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 400000) fail('Only text files up to 400 KB are supported.');
    const value = readFileSync(file, 'utf8'); if (value.includes('\0')) fail('Binary files are not supported.');
    return value;
  }
  function write(root, name, value) {
    const file = target(root, name, true);
    if (value === null) { if (existsSync(file)) unlinkSync(file); return; }
    mkdirSync(dirname(file), { recursive: true }); target(root, name, true);
    const temp = join(dirname(file), `.agent-${randomUUID()}.tmp`);
    try { writeFileSync(temp, value, { mode: existsSync(file) ? lstatSync(file).mode : 0o644, flag: 'wx' }); renameSync(temp, file); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  function list(root) {
    const files = []; let truncated = false;
    function walk(dir, prefix = '') {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
        if (files.length >= 15000) { truncated = true; return; }
        const name = prefix + entry.name;
        if (entry.isDirectory()) walk(join(dir, entry.name), `${name}/`);
        else if (entry.isFile()) files.push(name);
      }
    }
    walk(root); return { files: files.sort(), truncated };
  }
  function get(table, id, root) {
    const row = db.prepare(`SELECT payload FROM ${table} WHERE id=? AND root=?`).get(id, root);
    if (!row) fail('Item not found in this workspace.', 404); return JSON.parse(row.payload);
  }
  function validateChanges(root, changes) {
    if (!Array.isArray(changes) || !changes.length || changes.length > 30) fail('Provide between 1 and 30 file changes.');
    const seen = new Set();
    return changes.map(change => {
      if (seen.has(change.path)) fail('A file can appear only once per change set.'); seen.add(change.path);
      if (typeof change.after !== 'string' || Buffer.byteLength(change.after) > 400000 || change.after.includes('\0')) fail('Replacement must be text up to 400 KB.');
      const before = text(root, change.path, true);
      if (change.before !== before) fail(`File changed: ${change.path}. Read it again before proposing edits.`, 409);
      return { path: change.path, before, after: change.after };
    });
  }
  function transform(item, undo = false) {
    if (locks.has(item.root)) fail('Workspace has another write or command in progress.', 409);
    const changes = undo ? item.changes.map(c => ({ ...c, before: c.after, after: c.before })) : item.changes;
    for (const change of changes) if (text(item.root, change.path, true) !== change.before) fail(`Conflict in ${change.path}. Nothing was written.`, 409);
    locks.add(item.root); const written = [];
    item.status = undo ? 'undoing' : 'applying'; save('changesets', item);
    try {
      for (const change of changes) {
        if (text(item.root, change.path, true) !== change.before) fail(`File changed during write: ${change.path}`, 409);
        write(item.root, change.path, change.after); written.push(change);
      }
      item.status = undo ? 'reverted' : 'applied'; item.updatedAt = Date.now(); save('changesets', item);
    } catch (error) {
      let conflict = false;
      for (const change of written.reverse()) {
        try { if (text(item.root, change.path, true) !== change.after) { conflict = true; continue; } write(item.root, change.path, change.before); } catch { conflict = true; }
      }
      item.status = conflict ? 'needs_recovery' : undo ? 'applied' : 'pending'; item.error = error.message; save('changesets', item); throw error;
    } finally { locks.delete(item.root); }
    return item;
  }
  function executionEnv() {
    const env = { PATH: process.env.PATH || '/opt/homebrew/bin:/usr/bin:/bin', LANG: process.env.LANG || 'en_US.UTF-8', GIT_TERMINAL_PROMPT: '0' };
    for (const name of ['HOME', 'USER', 'TMPDIR', 'SSH_AUTH_SOCK']) if (process.env[name]) env[name] = process.env[name];
    return env;
  }
  function start(job, executable, args) {
    if (get('jobs',job.id,job.root).status !== 'pending') fail('This command was already handled.',409);
    if (locks.has(job.root)) fail('Another command or write is running in this workspace.', 409);
    locks.add(job.root); job.status = 'running'; job.startedAt = Date.now(); save('jobs', job);
    let child;
    try { child = spawn(executable, args, { cwd: job.root, env: executionEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { locks.delete(job.root); job.status = 'failed'; job.output = error.message; save('jobs', job); throw error; }
    const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} };
    const force = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { job.timedOut = true; stop(); setTimeout(force, 500).unref(); }, job.timeoutMs || 120000);
    let lastSave = 0;
    const append = chunk => { const value=chunk.toString(); if(job.output.length+value.length>200000)job.truncated=true; if (job.output.length < 200000) job.output += value.slice(0, 200000 - job.output.length); if (Date.now() - lastSave > 200) { save('jobs', job); lastSave = Date.now(); } };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('error', error => append(`\n${error.message}`));
    const completion = new Promise(resolve => child.on('close', (code, signal) => {
      clearTimeout(timer); processes.delete(job.id); locks.delete(job.root);
      job.exitCode = code; job.signal = signal; job.finishedAt = Date.now();
      job.status = job.cancelled ? 'cancelled' : job.timedOut ? 'timed_out' : code === 0 ? 'completed' : 'failed'; save('jobs', job); resolve(job);
    }));
    processes.set(job.id, { stop: () => { job.cancelled = true; stop(); setTimeout(force, 500).unref(); }, completion });
    return job;
  }
  async function git(root, args) {
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], { cwd: root, env: executionEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      child.stdout.on('data', data => { stdout += data; if (stdout.length > 200000) child.kill('SIGKILL'); }); child.stderr.on('data', data => { stderr += data; if(stderr.length>200000)child.kill('SIGKILL'); });
      child.on('error', reject); child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(stderr.slice(0, 2000) || 'Git operation failed or output limit exceeded.')); });
    });
  }
  async function commitFingerprint(root, paths) {
    return JSON.stringify({status:await git(root,['status','--porcelain=v1']), index:await git(root,['ls-files','--stage','--',...paths]), contents:paths.map(path=>({path,hash:digest(text(root,path,true))}))});
  }
  const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
  return {
    connect(path) {
      if (typeof path !== 'string' || !isAbsolute(path)) fail('Enter the absolute project folder path.');
      const root = realpathSync(path); if (!lstatSync(root).isDirectory()) fail('Select a directory.');
      const token = randomUUID(); sessions.set(token, { root }); return { token, root, name: basename(root), ...list(root) };
    },
    disconnect(token) { const session = workspace(token); for (const job of all('jobs', session.root)) if (job.status === 'running') processes.get(job.id)?.stop(); sessions.delete(token); return { disconnected: true }; },
    list(token) { return list(workspace(token).root); },
    read(token, path) { const root = workspace(token).root, content = text(root, path); return { path, content, revision: digest(content) }; },
    prepareChanges(token, changes, explanation = '') {
      const root = workspace(token).root;
      const item = { id: randomUUID(), root, explanation: String(explanation).slice(0,2000), changes: validateChanges(root, changes), status: 'pending', createdAt: Date.now() }; save('changesets', item); return item;
    },
    changeHistory(token) { return all('changesets', workspace(token).root); },
    apply(token, id) { const root = workspace(token).root, item = get('changesets', id, root); if (item.status !== 'pending') fail('Only pending changes can be applied.',409); return transform(item); },
    undo(token, id) { const root = workspace(token).root, item = get('changesets', id, root); if (item.status !== 'applied') fail('Only applied changes can be undone.',409); return transform(item,true); },
    reject(token,id) { const item=get('changesets',id,workspace(token).root); if(item.status!=='pending')fail('Only pending changes can be rejected.'); item.status='rejected';save('changesets',item);return item; },
    recover(token,id) {
      const item=get('changesets',id,workspace(token).root); if(item.status!=='needs_recovery')fail('Change set does not need recovery.');
      if (locks.has(item.root)) fail('Workspace is busy.',409);
      for(const c of item.changes){const current=text(item.root,c.path,true);if(current!==c.before&&current!==c.after)fail(`External change in ${c.path}; restore manually from the displayed backup.`,409);}
      for(const c of item.changes)if(text(item.root,c.path,true)===c.after)write(item.root,c.path,c.before);
      item.status='reverted';save('changesets',item);return item;
    },
    async gitInfo(token, kind='status') {
      const root=workspace(token).root;
      const top=(await git(root,['rev-parse','--show-toplevel'])).trim(); if(realpathSync(top)!==root)fail('Connect the Git repository root to use Git tools.');
      if(kind==='diff')return {output:await git(root,['diff','--no-ext-diff','--no-textconv','HEAD','--'])};
      if(kind==='log')return {output:await git(root,['log','-8','--oneline'])};
      return {branch:(await git(root,['branch','--show-current'])).trim(),output:await git(root,['status','--short']),remotes:await git(root,['remote'])};
    },
    async prepareJob(token, input) {
      const root=workspace(token).root;
      const job={id:randomUUID(),root,kind:input.kind||'command',status:'pending',output:'',createdAt:Date.now(),timeoutMs:Math.min(300000,Math.max(1000,Number(input.timeoutMs)||120000))};
      if(job.kind==='command'){
        if(typeof input.command!=='string'||!input.command.trim()||input.command.length>10000)fail('Enter a command up to 10,000 characters.');
        job.command=input.command; job.reason=String(input.reason||'').slice(0,2000);
      }else if(job.kind==='commit'){
        await this.gitInfo(token);
        if(!Array.isArray(input.paths)||!input.paths.length||input.paths.length>100)fail('Select specific files to commit.');
        job.paths=[...new Set(input.paths)];for(const path of job.paths)target(root,path,true);
        if(typeof input.message!=='string'||!input.message.trim()||input.message.length>2000)fail('Enter a commit message.');
        job.message=input.message; job.command=`git add -- ${job.paths.map(quote).join(' ')}\ngit commit --only -m ${quote(job.message)} -- ${job.paths.map(quote).join(' ')}`;
        job.fingerprint=await commitFingerprint(root,job.paths);
        job.preview=await git(root,['diff','--no-ext-diff','--no-textconv','--',...job.paths]);
        job.preview += '\nSelected file contents:\n'+job.paths.map(path=>`${path}:\n${(text(root,path,true) ?? '(deleted)').slice(0,12000)}`).join('\n').slice(0,100000);
      }else if(job.kind==='push'){
        const info=await this.gitInfo(token);if(!info.branch)fail('Cannot push detached HEAD.');
        job.remote=typeof input.remote==='string'?input.remote:'origin';
        if(!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(job.remote)||!info.remotes.split('\n').includes(job.remote))fail('Choose an existing remote.');
        job.branch=info.branch;job.head=(await git(root,['rev-parse','HEAD'])).trim();
        job.command=`git push ${JSON.stringify(job.remote)} ${JSON.stringify(`HEAD:refs/heads/${job.branch}`)}`;
        job.remoteUrl=(await git(root,['remote','get-url','--push',job.remote])).trim();
        job.preview=`Remote: ${job.remoteUrl}\n`+await git(root,['log','-5','--oneline']);
      }else fail('Unknown job type.');
      save('jobs',job);return job;
    },
    async approveJob(token,id) {
      const root=workspace(token).root, job=get('jobs',id,root);if(job.status!=='pending')fail('This job has already been handled.',409);
      if(job.kind==='command')return start(job,'/bin/sh',['-c',job.command]);
      if(job.kind==='push'){
        if((await git(root,['rev-parse','HEAD'])).trim()!==job.head || (await git(root,['branch','--show-current'])).trim()!==job.branch || (await git(root,['remote','get-url','--push',job.remote])).trim()!==job.remoteUrl)fail('Branch, HEAD, or remote changed; prepare the push again.',409);
        return start(job,'git',['push',job.remote,`HEAD:refs/heads/${job.branch}`]);
      }
      const fingerprint=await commitFingerprint(root,job.paths);
      if(fingerprint!==job.fingerprint)fail('Git changes changed; prepare the commit again.',409);
      // No shell interpolation: paths and message are arguments to a fixed Node runner.
      const script=`const {spawnSync}=require('node:child_process');const [message,...paths]=process.argv.slice(1);for(const args of [['add','--',...paths],['commit','--only','-m',message,'--',...paths]]){const r=spawnSync('git',args,{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);}`;
      return start(job,process.execPath,['-e',script,'--',job.message,...job.paths]);
    },
    jobs(token) { return all('jobs',workspace(token).root); },
    job(token,id) { return get('jobs',id,workspace(token).root); },
    cancelJob(token,id) { const job=get('jobs',id,workspace(token).root);if(job.status==='running')processes.get(id)?.stop();else if(job.status==='pending'){job.status='rejected';save('jobs',job);}return job; },
    async close() { for(const process of processes.values())process.stop();await Promise.all([...processes.values()].map(p=>p.completion));db.close(); },
  };
}
