import { agentRequest, disconnectAgent, initializeAgentUI } from './agent-client.js';
import { extendAgentSession } from './agent-tools.js';
import { createFileTools } from './file-tools.js';
const $ = (id) => document.getElementById(id);
let files = new Map(), opened = new Map(), active = null, diff = false, changes = false;
let folded = new Set();
let welcomeOpen = true;
let serverWorkspace = null;
let workspaceId = crypto.randomUUID(), workspaceName = '', folderReady = false;
const ignored = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.venv']);
const dirty = (f) => f.text !== f.saved;
const tell = (message) => { $('workspace-message').textContent = message; };
function button(label, action, className = '') {
  const b = document.createElement('button'); b.textContent = label; b.className = className; b.onclick = action; return b;
}
async function chooseFolder() {
  if ([...opened.values()].some(dirty) && !confirm('Open another folder and discard unsaved edits?')) return;
  if (!window.showDirectoryPicker) { $('folder-input').click(); return; }
  try {
    const root = await window.showDirectoryPicker({ mode: 'readwrite' });
    const next = new Map();
    async function walk(dir, prefix = '') {
      for await (const [name, handle] of dir.entries()) {
        if (ignored.has(name)) continue;
        const path = prefix + name;
        if (handle.kind === 'directory') await walk(handle, path + '/');
        else next.set(path, { handle, getFile: () => handle.getFile() });
        if (next.size > 15000) throw new Error('Folder is too large. Open a smaller project folder.');
      }
    }
    tell('Reading folder…'); await walk(root); setFolder(root.name, next, true);
  } catch (e) { if (e.name !== 'AbortError') tell(`Cannot open folder: ${e.message}`); }
}
function setFolder(name, next, writable, agent = null) {
  window.dispatchEvent(new Event('workspace-access-changed'));
  if (serverWorkspace && !agent) disconnectAgent().catch(error=>tell(error.message));
  serverWorkspace = agent;
  workspaceId = crypto.randomUUID(); workspaceName = name; folderReady = true;
  $('ai-folder-access').disabled = false; $('ai-folder-access').checked = true;
  files = next; opened = new Map(); active = null; diff = false;
  updateFolderConnection();
  $('folder-name').textContent = name;
  $('workspace-status').textContent = `${name} · ${writable ? 'Folder access granted' : 'Read only · download edits to save'}`;
  tell(`${files.size} files loaded${writable ? '' : '. This browser uses read-only folder access.'}.`);
  renderTree(); renderEditor(); renderChanges();
}
$('folder-input').onchange = (event) => {
  const selected = [...event.target.files]; if (!selected.length) return;
  const next = new Map();
  for (const file of selected) {
    const parts = file.webkitRelativePath.split('/');
    if (parts.some((p) => ignored.has(p))) continue;
    next.set(parts.slice(1).join('/'), { getFile: async () => file });
  }
  setFolder(selected[0].webkitRelativePath.split('/')[0], next, false); event.target.value = '';
};
function renderTree() {
  const root = Object.create(null);
  for (const path of [...files.keys()].sort()) {
    const parts = path.split('/'); let node = root;
    parts.forEach((part, i) => { if (i === parts.length - 1) node[part] = path; else node = node[part] ||= Object.create(null); });
  }
  function branch(node, depth = 0) {
    const fragment = document.createDocumentFragment();
    for (const [name, entry] of Object.entries(node).sort((a,b) => (typeof a[1] === 'string') - (typeof b[1] === 'string') || a[0].localeCompare(b[0]))) {
      if (typeof entry === 'string') {
        const b = button(`◇  ${name}`, () => openFile(entry), 'tree-file'); b.style.paddingLeft = `${16 + depth * 14}px`; b.dataset.path = entry; b.title = entry; fragment.append(b);
      } else {
        const d = document.createElement('details'); d.open = depth < 1;
        const summary = document.createElement('summary'); summary.textContent = name; summary.style.paddingLeft = `${12 + depth * 14}px`; d.append(summary, branch(entry, depth + 1)); fragment.append(d);
      }
    }
    return fragment;
  }
  $('file-tree').replaceChildren(branch(root));
  if (!files.size) $('file-tree').textContent = 'This folder has no visible files.';
}
async function openFile(path) {
  try {
    if (!opened.has(path)) {
      const source = files.get(path), file = await source.getFile();
      if (file.size > 400000) throw new Error('Files larger than 400 KB cannot be opened.');
      const text = await file.text();
      if (text.includes('\0')) throw new Error('Binary files cannot be edited.');
      opened.set(path, { ...source, text, baseline: text, saved: text });
    }
    active = path; renderEditor(); tell('');
  } catch (e) { tell(e.message); }
}
function renderEditor() {
  const empty = !welcomeOpen && !opened.size;
  document.body.classList.toggle('editor-closed', empty);
  if (empty) document.body.classList.remove('hide-assistant');
  folded.clear(); $('folded-view').hidden = true; $('fold-all').textContent = 'Fold blocks';
  $('editor-tabs').replaceChildren();
  function tab(label, select, close, selected, title) {
    const wrapper = document.createElement('div'); wrapper.className = `editor-tab-wrap${selected ? ' selected' : ''}`;
    const item = button(label, select, 'editor-tab'); item.title = title;
    const dismiss = button('×', close, 'close-tab'); dismiss.title = `Close ${title}`; dismiss.setAttribute('aria-label', dismiss.title);
    wrapper.append(item, dismiss); return wrapper;
  }
  if (welcomeOpen) $('editor-tabs').append(tab('Welcome', () => { active = null; renderEditor(); }, () => {
    welcomeOpen = false; if (!active) active = opened.keys().next().value || null; renderEditor();
  }, !active, 'Welcome'));
  for (const [path, f] of opened) {
    $('editor-tabs').append(tab(`${path.split('/').pop()}${dirty(f) ? ' ●' : ''}`, () => { active = path; renderEditor(); }, () => {
      if (dirty(f) && !confirm(`Close ${path} and discard unsaved edits?`)) return;
      const paths = [...opened.keys()], index = paths.indexOf(path);
      opened.delete(path);
      if (active === path) active = paths[index + 1] || paths[index - 1] || null;
      renderEditor(); renderChanges();
    }, active === path, path));
  }
  $('editor-welcome').hidden = !!active || !welcomeOpen;
  $('editor-toolbar').hidden = !active;
  $('code-view').hidden = !active || diff; $('diff-view').hidden = !active || !diff;
  document.querySelectorAll('.tree-file').forEach(b => b.classList.toggle('selected', b.dataset.path === active));
  if (!active) return;
  const f = opened.get(active); $('file-path').textContent = active;
  $('save-file').textContent = f.handle ? 'Save' : 'Download';
  $('code-editor').value = f.text; $('toggle-diff').textContent = diff ? 'Edit file' : 'View changes';
  numbers(); if (diff) renderDiff();
}
function numbers() {
  renderFoldGutter();
  $('line-numbers').textContent = Array.from({ length: $('code-editor').value.split('\n').length }, (_, i) => i + 1).join('\n');
}
$('code-editor').oninput = () => {
  opened.get(active).text = $('code-editor').value; numbers(); renderChanges();
  const index = [...opened.keys()].indexOf(active) + (welcomeOpen ? 1 : 0);
  $('editor-tabs').children[index].querySelector('.editor-tab').textContent = `${active.split('/').pop()}${dirty(opened.get(active)) ? ' ●' : ''}`;
};
$('code-editor').onscroll = () => { $('line-numbers').scrollTop = $('code-editor').scrollTop; $('fold-gutter').scrollTop = $('code-editor').scrollTop; };
$('code-editor').onkeyup = $('code-editor').onclick = () => {
  const before = $('code-editor').value.slice(0, $('code-editor').selectionStart).split('\n');
  $('editor-position').textContent = `Ln ${before.length}, Col ${before.at(-1).length + 1}`;
};
function renderChanges() {
  const edited = [...opened].filter(([, f]) => f.text !== f.baseline);
  $('change-count').textContent = edited.length;
  $('changes-list').replaceChildren(...edited.map(([path]) => button(`M  ${path}`, () => { active = path; diff = true; renderEditor(); }, 'changed-file')));
  if (!edited.length) $('changes-list').textContent = 'No changes since opening files.';
}
function renderDiff() {
  const f = opened.get(active), container = $('diff-view'); container.replaceChildren();
  const note = document.createElement('div'); note.className = 'diff-note'; note.textContent = 'Original on open ↔ Current edits · saved edits remain visible until you reopen the folder'; container.append(note);
  const before = f.baseline.split('\n'), after = f.text.split('\n');
  let start = 0, end = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  function line(value, type, n) { const row = document.createElement('pre'); row.className = `diff-line ${type}`; row.textContent = `${String(n).padStart(4)} ${type === 'removed' ? '−' : type === 'added' ? '+' : ' '} ${value}`; container.append(row); }
  before.slice(0, start).forEach((s, i) => line(s, '', i + 1));
  before.slice(start, before.length - end).forEach((s, i) => line(s, 'removed', start + i + 1));
  after.slice(start, after.length - end).forEach((s, i) => line(s, 'added', start + i + 1));
  after.slice(after.length - end).forEach((s, i) => line(s, '', after.length - end + i + 1));
}
async function save() {
  if (!active) return;
  const path = active, f = opened.get(path), text = f.text;
  try {
    if (f.handle) {
      const disk = await (await f.getFile()).text();
      if (disk !== f.saved) throw new Error('File changed on disk. Reopen the folder or copy your edits before continuing.');
      const writer = await f.handle.createWritable(); await writer.write(text); await writer.close(); f.saved = text;
      tell(`Saved ${path}`);
    } else {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = document.createElement('a'); a.href = url; a.download = path.split('/').pop(); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      tell('Downloaded edited file. Replace the original file manually.');
    }
    renderEditor();
  } catch (e) { tell(`Save failed: ${e.message}`); }
}
for (const id of ['title-open', 'open-folder', 'empty-open', 'welcome-open']) $(id).onclick = chooseFolder;
$('save-file').onclick = save;
$('toggle-diff').onclick = () => { diff = !diff; renderEditor(); };
$('add-context').onclick = () => {
  if (!active) return;
  document.body.classList.remove('hide-assistant');
  window.dispatchEvent(new CustomEvent('workspace-context', { detail: { name: active, text: opened.get(active).text } }));
  tell(`Added ${active} to chat context.`);
};
function view(showChanges) {
  $('extensions-panel').hidden = true;
  $('folder-name').hidden = false;
  $('open-folder').hidden = false;
  document.querySelector('.explorer-note').hidden = false;
  $('view-extensions').classList.remove('active');
  changes = showChanges; $('file-tree').hidden = changes; $('changes-list').hidden = !changes;
  $('explorer-title').textContent = changes ? 'CHANGES' : 'EXPLORER';
  $('view-files').classList.toggle('active', !changes); $('view-changes').classList.toggle('active', changes);
}
$('view-files').onclick = () => view(false); $('view-changes').onclick = () => view(true);
$('view-chat').onclick = () => { if (!document.body.classList.contains('editor-closed')) document.body.classList.toggle('hide-assistant'); };
$('chat-history').onclick = () => $('sidebar').classList.toggle('expanded');
$('view-settings').onclick = () => { document.body.classList.remove('hide-assistant'); $('sidebar').classList.add('expanded'); document.querySelector('.settings').open = true; };
window.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); } });
window.addEventListener('beforeunload', (e) => { if ([...opened.values()].some(dirty)) { e.preventDefault(); e.returnValue = ''; } });

// Folding uses a read-only projection; source text remains intact for saving and chat.
function foldRanges(text) {
  const lines = text.split('\n'), ranges = new Map();
  if (/\.pyw?$/i.test(active || '')) {
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*(?:(?:async\s+)?def|class|if|elif|else|for|while|try|except|finally|with)\b.*:\s*(?:#.*)?$/.test(lines[i])) continue;
      const indent = lines[i].match(/^\s*/)[0].length;
      let end = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        if (lines[j].match(/^\s*/)[0].length <= indent) break;
        end = j;
      }
      if (end > i) ranges.set(i, end);
    }
    return ranges;
  }
  const stack = []; let quote = '', blockComment = false, escaped = false;
  for (let line = 0; line < lines.length; line++) {
    const source = lines[line];
    for (let column = 0; column < source.length; column++) {
      const c = source[column], next = source[column + 1];
      if (blockComment) { if (c === '*' && next === '/') { blockComment = false; column++; } continue; }
      if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = ''; continue; }
      if (c === '/' && next === '/') break;
      if (c === '/' && next === '*') { blockComment = true; column++; continue; }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '{' || c === '[') stack.push({ line, char: c });
      if (c === '}' || c === ']') {
        const start = stack.at(-1);
        if (start && start.char === (c === '}' ? '{' : '[')) {
          stack.pop(); if (line > start.line) ranges.set(start.line, line);
        }
      }
    }
    escaped = false;
  }
  return ranges;
}
function renderFoldGutter() {
  if (!$('fold-gutter')) return;
  const ranges = foldRanges($('code-editor').value);
  $('fold-gutter').replaceChildren(...$('code-editor').value.split('\n').map((_, line) => {
    const row = document.createElement('div'); row.className = 'fold-gutter-row';
    if (ranges.has(line)) {
      const toggle = button('⌄', () => { folded.add(line); renderFolded(); }, 'fold-toggle');
      toggle.title = `Fold block at line ${line + 1}`; toggle.setAttribute('aria-label', toggle.title); row.append(toggle);
    }
    return row;
  }));
}
function renderFolded() {
  if (!folded.size) { $('folded-view').hidden = true; $('code-view').hidden = diff; $('fold-all').textContent = 'Fold blocks'; return; }
  diff = false; $('diff-view').hidden = true; $('toggle-diff').textContent = 'View changes';
  $('code-view').hidden = true; $('folded-view').hidden = false; $('fold-all').textContent = 'Unfold to edit';
  const ranges = foldRanges(opened.get(active).text), lines = opened.get(active).text.split('\n');
  $('folded-view').replaceChildren();
  for (let i = 0; i < lines.length; i++) {
    const line = i, end = ranges.get(i), row = document.createElement('div'); row.className = 'fold-row';
    const number = document.createElement('span'); number.className = 'fold-number'; number.textContent = i + 1;
    const toggle = button(end === undefined ? '' : folded.has(i) ? '›' : '⌄', () => {
      if (folded.has(line)) folded.delete(line); else folded.add(line); renderFolded();
    }, 'fold-toggle');
    toggle.disabled = end === undefined;
    if (end !== undefined) { toggle.setAttribute('aria-label', `${folded.has(i) ? 'Expand' : 'Fold'} block at line ${i + 1}`); toggle.setAttribute('aria-expanded', String(!folded.has(i))); }
    const code = document.createElement('code'); code.textContent = lines[i]; row.append(number, toggle, code);
    if (end !== undefined && folded.has(i)) {
      const more = button(`… ${end - i} lines`, () => { folded.delete(line); renderFolded(); }, 'fold-placeholder');
      more.title = 'Expand block'; row.append(more); i = end;
    }
    $('folded-view').append(row);
  }
}
$('fold-all').onclick = () => {
  if (!active) return;
  if (folded.size) folded.clear();
  else folded = new Set(foldRanges(opened.get(active).text).keys());
  if (!folded.size) tell('No foldable blocks, or all blocks expanded.');
  renderFolded();
};

renderEditor();

let proposedCode = null;
window.addEventListener('workspace-apply-code', event => {
  if (typeof event.detail?.code !== 'string') return;
  if (!files.size) {
    tell('Open a folder first, then choose Apply to file again.');
    $('title-open').focus(); return;
  }
  proposedCode = { code: event.detail.code, files };
  $('apply-code-target').replaceChildren(...[...files.keys()].sort().map(path => {
    const option = document.createElement('option'); option.value = path; option.textContent = path; return option;
  }));
  if (active) $('apply-code-target').value = active;
  else $('apply-code-target').selectedIndex = -1;
  $('apply-code-status').textContent = 'Review opens a diff in the editor. Save writes the result to your folder.';
  $('apply-code-dialog').showModal();
});
$('review-code').onclick = async () => {
  const path = $('apply-code-target').value, proposal = proposedCode;
  if (!path || !proposal) { $('apply-code-status').textContent = 'Choose a target file.'; return; }
  if (proposal.files !== files) { $('apply-code-status').textContent = 'The workspace changed. Cancel and apply the code again.'; return; }
  if (new Blob([proposal.code]).size > 400000) { $('apply-code-status').textContent = 'The code block exceeds the 400 KB editor limit.'; return; }
  if (opened.has(path) && dirty(opened.get(path)) && !confirm(`Replace unsaved edits in ${path} with this code block?`)) return;
  $('review-code').disabled = true;
  try {
    await openFile(path);
    if (proposal.files !== files || !opened.has(path)) { $('apply-code-status').textContent = 'Could not open the target file. Check the workspace message.'; return; }
    const file = opened.get(path);
    file.text = proposal.code;
    active = path; diff = true;
    renderEditor(); renderChanges(); view(true);
    $('apply-code-dialog').close();
    tell(`AI changes applied to ${path} in the editor. Review the diff, then ${file.handle ? 'Save to update your folder' : 'Download to save the edited file'}.`);
  } finally { $('review-code').disabled = false; }
};

function workspaceSnapshot() { return { id: workspaceId, name: workspaceName, files, agent: serverWorkspace, enabled: folderReady && $('ai-folder-access').checked }; }
async function workspaceText(path, snapshot) {
  if (snapshot.id !== workspaceId || !$('ai-folder-access').checked) throw new Error('Folder access changed.');
  const item = opened.get(path);
  if (item && dirty(item)) return item.text;
  const file = await snapshot.files.get(path).getFile();
  if (file.size > 400000) throw new Error('File exceeds 400 KB.');
  return file.text();
}
function updateFolderConnection() {
  $('folder-connection').textContent = !folderReady ? 'No folder connected — click Open Folder'
    : !$('ai-folder-access').checked ? `${workspaceName} · AI folder access off`
    : `${workspaceName} · ${files.size} files · AI folder access on`;
}
$('ai-folder-access').onchange = () => { workspaceId = crypto.randomUUID(); updateFolderConnection(); window.dispatchEvent(new Event('workspace-access-changed')); };
const baseTools = createFileTools({ getWorkspace: workspaceSnapshot, getText: workspaceText });
window.localFileTools = () => extendAgentSession(baseTools(),workspaceSnapshot(),workspaceSnapshot);
window.addEventListener('workspace-review-proposal', async event => {
  const proposal = event.detail;
  if(proposal?.changeset)return;
  try {
    if (proposal.workspaceId !== workspaceId || !$('ai-folder-access').checked) throw new Error('Reopen or re-enable the original folder and ask the AI for a fresh proposal.');
    const snapshot = workspaceSnapshot();
    if (await workspaceText(proposal.path, snapshot) !== proposal.original) throw new Error('File changed since the proposal. Ask the AI to read it again.');
    if (snapshot.id !== workspaceId) throw new Error('Folder changed.');
    if (opened.has(proposal.path) && dirty(opened.get(proposal.path)) && !confirm(`Replace unsaved edits in ${proposal.path} with the reviewed proposal?`)) return;
    await openFile(proposal.path);
    if (snapshot.id !== workspaceId || !opened.has(proposal.path)) throw new Error('Could not open the proposal target.');
    const file = opened.get(proposal.path);
    // Refresh a clean buffer so external edits are the baseline for this review.
    if (!dirty(file)) { file.saved = proposal.original; file.baseline = proposal.original; }
    file.text = proposal.content; active = proposal.path; diff = true;
    renderEditor(); renderChanges(); view(true);
    tell('AI proposal loaded for review. Save to write it to the folder.');
  } catch (error) { alert(`Cannot review proposal: ${error.message}`); }
});

window.workspaceDirtyPaths = () => [...opened].filter(([,file])=>dirty(file)).map(([path])=>path);
function serverFiles(connection, paths) {
  return new Map(paths.map(path=>{
    const getFile=async()=>{const result=await agentRequest(`file?path=${encodeURIComponent(path)}`,undefined,connection.token);return {size:new Blob([result.content]).size,text:async()=>result.content};};
    return [path,{getFile,handle:{createWritable:async()=>{
      const before=await (await getFile()).text();let after=before;
      return {write:async text=>{after=text;},close:async()=>{const item=await agentRequest('changes',{changes:[{path,before,after}],explanation:'Editor save'},connection.token);await agentRequest('apply',{id:item.id},connection.token);}};
    }}}];
  }));
}
window.addEventListener('agent-connected',event=>{const connection=event.detail;setFolder(connection.name,serverFiles(connection,connection.files),true,connection);});
window.addEventListener('agent-disconnected',()=>{serverWorkspace=null;folderReady=false;files=new Map();opened=new Map();active=null;workspaceId=crypto.randomUUID();$('ai-folder-access').checked=false;$('ai-folder-access').disabled=true;updateFolderConnection();renderTree();renderEditor();renderChanges();});
window.refreshAgentFiles = async connection=>{
  if(!connection||serverWorkspace?.token!==connection.token)return;
  try{
    const result=await agentRequest('files',undefined,connection.token);
    if(serverWorkspace?.token!==connection.token)return;
    files=serverFiles(connection,result.files);
    for(const [path,file] of opened){
      if(dirty(file))continue;
      if(!files.has(path)){opened.delete(path);if(active===path)active=null;continue;}
      const value=await (await files.get(path).getFile()).text();
      if(serverWorkspace?.token!==connection.token)return;
      opened.set(path,{...files.get(path),text:value,saved:value,baseline:file.baseline});
    }
    renderTree();renderEditor();renderChanges();updateFolderConnection();
  }catch(error){tell(error.message);}
};
initializeAgentUI();
