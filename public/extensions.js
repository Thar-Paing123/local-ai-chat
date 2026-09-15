const $ = id => document.getElementById(id);
const storageKey = 'lac.extensions';
const catalog = [
  { id: 'json-format', name: 'JSON Formatter', icon: '{}', description: 'Format the open JSON file with two-space indentation.', activate() {
    const action = document.createElement('button');
    action.id = 'format-json'; action.textContent = 'Format JSON';
    action.onclick = () => {
      const editor = $('code-editor');
      try {
        const formatted = JSON.stringify(JSON.parse(editor.value), null, 2) + '\n';
        editor.value = formatted; editor.dispatchEvent(new Event('input', { bubbles: true }));
        if (!$('diff-view').hidden) $('toggle-diff').click();
        $('workspace-message').textContent = 'JSON formatted. Save the file to keep your changes.';
      } catch { $('workspace-message').textContent = 'Cannot format: the open file is not valid JSON.'; }
    };
    $('editor-toolbar').insertBefore(action, $('save-file'));
    return () => action.remove();
  } },
  { id: 'large-type', name: 'Larger Editor Text', icon: 'Aa', description: 'Use 16px text in the editor and changes viewer.', activate() {
    document.body.classList.add('extension-large-type');
    return () => document.body.classList.remove('extension-large-type');
  } },
  { id: 'line-highlight', name: 'Editor Reading Lines', icon: '≡', description: 'Add subtle alternating lines behind your code for easier reading.', activate() {
    document.body.classList.add('extension-reading-lines');
    return () => document.body.classList.remove('extension-reading-lines');
  } },
];
let installed = new Set();
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
  if (Array.isArray(saved)) installed = new Set(saved.filter(id => catalog.some(item => item.id === id)));
} catch { /* Use default state when storage is unavailable. */ }
const cleanups = new Map();
const pending = new Set();
const failures = new Map();
function notify(message, kind = 'success') {
  $('extension-status').textContent = message;
  const toast = document.createElement('div'); toast.className = `extension-toast ${kind}`;
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const text = document.createElement('span'); text.textContent = message;
  const close = document.createElement('button'); close.textContent = '×'; close.setAttribute('aria-label', 'Dismiss notification'); close.onclick = () => toast.remove();
  toast.append(text, close); $('notifications').append(toast);
}
async function toggle(extension) {
  if (pending.has(extension.id)) return;
  const removing = installed.has(extension.id);
  pending.add(extension.id); failures.delete(extension.id); render();
  // Yield so the pending state is painted before activation work starts.
  await new Promise(resolve => setTimeout(resolve, 80));
  try {
    if (removing) {
      cleanups.get(extension.id)?.(); cleanups.delete(extension.id); installed.delete(extension.id);
    } else {
      cleanups.set(extension.id, extension.activate()); installed.add(extension.id);
    }
    let message = `${extension.name} ${removing ? 'uninstalled' : 'installed successfully'}.`;
    let kind = 'success';
    try { localStorage.setItem(storageKey, JSON.stringify([...installed])); }
    catch { message += ' Could not save preferences; this change lasts for this session only.'; kind = 'warning'; }
    notify(message, kind);
  } catch (error) {
    failures.set(extension.id, `${removing ? 'Uninstall' : 'Installation'} failed: ${error.message}`);
    notify(`${extension.name}: ${failures.get(extension.id)}`, 'error');
  } finally { pending.delete(extension.id); render(); }
}
function render() {
  const query = $('extension-search').value.trim().toLowerCase();
  const filtered = catalog.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query)
    && ($('extension-filter').value !== 'installed' || installed.has(item.id)));
  $('extension-list').replaceChildren(...filtered.map(extension => {
    const card = document.createElement('article'); card.className = 'extension-card';
    const icon = document.createElement('span'); icon.className = 'extension-icon'; icon.textContent = extension.icon;
    const title = document.createElement('h3'); title.textContent = extension.name;
    const description = document.createElement('p'); description.textContent = extension.description;
    const publisher = document.createElement('small'); publisher.textContent = 'Local Code Assistant · 1.0.0';
    const action = document.createElement('button'); action.className = 'extension-action';
    const enabled = installed.has(extension.id);
    action.textContent = pending.has(extension.id) ? (enabled ? 'Uninstalling…' : 'Installing…') : enabled ? 'Uninstall' : failures.has(extension.id) ? 'Retry install' : 'Install';
    action.disabled = pending.has(extension.id);
    const state = document.createElement('div'); state.className = 'extension-state';
    state.textContent = failures.get(extension.id) || (enabled ? '✓ Installed · Enabled' : '');
    if (failures.has(extension.id)) state.classList.add('error');
    action.setAttribute('aria-label', `${action.textContent} ${extension.name}`);
    action.classList.toggle('installed', enabled); action.onclick = () => toggle(extension);
    card.append(icon, title, description, publisher, state, action); return card;
  }));
  if (!filtered.length) {
    const empty = document.createElement('p'); empty.className = 'extension-info';
    empty.textContent = $('extension-filter').value === 'installed' ? 'No installed extensions match.' : 'No extensions match your search.';
    $('extension-list').append(empty);
  }
}
$('view-extensions').onclick = () => {
  $('extensions-panel').hidden = false;
  for (const id of ['file-tree', 'changes-list', 'folder-name', 'open-folder']) $(id).hidden = true;
  document.querySelector('.explorer-note').hidden = true;
  $('explorer-title').textContent = 'EXTENSIONS';
  for (const id of ['view-files', 'view-changes']) $(id).classList.remove('active');
  $('view-extensions').classList.add('active');
  $('extension-search').focus();
};
$('extension-search').oninput = render; $('extension-filter').onchange = render;
for (const extension of catalog) if (installed.has(extension.id)) {
  try { cleanups.set(extension.id, extension.activate()); }
  catch (error) { installed.delete(extension.id); failures.set(extension.id, `Activation failed: ${error.message}`); notify(`${extension.name} could not start: ${error.message}`, 'error'); }
}
render();
