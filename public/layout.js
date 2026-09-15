const root = document.documentElement;
const app = document.getElementById('app');
const sizes = { explorer: 225, assistant: 365 };
try {
  const saved = JSON.parse(localStorage.getItem('lac.panel-widths') || '{}');
  for (const name of Object.keys(sizes)) if (Number.isFinite(saved[name])) sizes[name] = saved[name];
} catch { /* Defaults when storage is unavailable. */ }
function limits(name) {
  const width = app.clientWidth;
  const compact = width <= 850;
  const rail = compact ? 44 : 48;
  const closed = document.body.classList.contains('editor-closed');
  const hiddenChat = document.body.classList.contains('hide-assistant');
  const editorMin = closed ? 0 : 48;
  let max;
  if (name === 'explorer') {
    // Leave a usable chat area when the editor has been closed.
    const reserve = closed ? 120 : compact || hiddenChat ? editorMin : sizes.assistant + editorMin;
    max = width - rail - reserve;
  } else {
    max = compact && !closed ? width - rail : width - rail - sizes.explorer - editorMin;
  }
  const min = Math.min(name === 'explorer' ? 80 : 120, Math.max(40, max));
  return { min, max: Math.max(min, max) };
}
function apply(name, width) {
  const { min, max } = limits(name);
  sizes[name] = Math.round(Math.max(min, Math.min(max, width)));
  root.style.setProperty(`--${name}-width`, `${sizes[name]}px`);
  const handle = document.getElementById(`resize-${name}`);
  handle?.setAttribute('aria-valuemin', min);
  handle?.setAttribute('aria-valuemax', Math.floor(max));
  handle?.setAttribute('aria-valuenow', sizes[name]);
}
function persist() { try { localStorage.setItem('lac.panel-widths', JSON.stringify(sizes)); } catch {} }
for (const name of Object.keys(sizes)) {
  const panel = document.getElementById(name === 'explorer' ? 'explorer' : 'assistant-pane');
  const handle = document.createElement('div'); handle.id = `resize-${name}`; handle.className = `resize-handle ${name}`;
  handle.tabIndex = 0; handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', `Resize ${name} panel`); handle.title = 'Drag to resize · Double-click to reset';

  panel.append(handle);
  let drag;
  handle.onpointerdown = event => {
    if (event.button !== 0) return;
    if (name === 'assistant' && document.body.classList.contains('editor-closed')) return;
    event.preventDefault(); drag = { x: event.clientX, width: panel.getBoundingClientRect().width };
    handle.setPointerCapture(event.pointerId); document.body.classList.add('resizing'); handle.classList.add('dragging');
  };
  handle.onpointermove = event => { if (drag) apply(name, drag.width + (event.clientX - drag.x) * (name === 'explorer' ? 1 : -1)); };
  const finish = () => { if (!drag) return; drag = null; document.body.classList.remove('resizing'); handle.classList.remove('dragging'); persist(); };
  handle.onpointerup = finish; handle.onpointercancel = finish; handle.onlostpointercapture = finish;
  handle.ondblclick = () => { apply(name, name === 'explorer' ? 225 : 365); persist(); };
  handle.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); apply(name, sizes[name] + (event.key === 'ArrowRight' ? 10 : -10) * (name === 'explorer' ? 1 : -1)); persist();
  };
  apply(name, sizes[name]);
}
function fit() { for (const name of Object.keys(sizes)) apply(name, sizes[name]); }
window.addEventListener('resize', fit);
// Refit when the editor closes/reopens or the assistant is toggled.
new MutationObserver(records => {
  if (records.some(record => record.attributeName === 'class')) fit();
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });
