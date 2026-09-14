// Dependency-free markdown renderer + syntax highlighter.
// Everything is escaped before any markup is added, so model output can never
// inject HTML. Streaming-safe: an unterminated ``` fence still renders as code.

const KEYWORDS = {
  python: 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self print len range str int float dict list set tuple bool enumerate zip open super',
  javascript: 'async await break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while with yield console document window',
  typescript: 'abstract any as asserts async await boolean break case catch class const constructor continue declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let namespace never new null number of private protected public readonly return satisfies set static string super switch this throw true try type typeof undefined unknown var void while yield',
  sql: 'select from where group by having order limit offset insert into values update set delete create alter drop table view index join left right inner outer full on as and or not null is distinct union all case when then else end count sum avg min max desc asc primary key foreign references default constraint begin commit rollback with exists in between like database schema truncate cascade',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false make new len cap append error string int int64 float64 bool byte rune',
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self static struct super trait true type unsafe use where while Some None Ok Err Vec String str usize i32 u32 f64 bool',
  bash: 'if then else elif fi for while do done case esac function return local export source echo cd ls rm mv cp mkdir grep sed awk cat curl git sudo chmod chown kill ps env set unset alias read exit',
  java: 'abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import int interface long native new package private protected public return short static super switch synchronized this throw throws try void while true false null var String System',
  c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while include define NULL true false bool',
  css: 'important media supports keyframes import from to and not only display position color background border margin padding font flex grid width height',
  json: 'true false null',
};

const ALIASES = {
  py: 'python', js: 'javascript', jsx: 'javascript', mjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  golang: 'go', rs: 'rust', 'c++': 'c', cpp: 'c', h: 'c', cs: 'java', kt: 'java',
  postgres: 'sql', postgresql: 'sql', mysql: 'sql', psql: 'sql', sqlite: 'sql',
  html: 'css', scss: 'css', yml: 'json', yaml: 'json',
};

const HASH_COMMENT = new Set(['python', 'bash', 'sql', 'yaml']);

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Tokenizes already-escaped code. Comments and strings are matched first so
// keywords inside them are left alone.
export function highlight(escapedCode, lang) {
  const key = ALIASES[lang] ?? lang;
  const words = KEYWORDS[key];
  if (!words) return escapedCode;

  const kw = new Set(words.split(' '));
  const lineComment = key === 'sql' ? '--' : HASH_COMMENT.has(key) ? '#' : '//';

  const patterns = [
    // multi-line comments
    key === 'python'
      ? /("""[\s\S]*?"""|'''[\s\S]*?''')/
      : /(\/\*[\s\S]*?\*\/)/,
    // line comments
    new RegExp(`(${lineComment.replace(/[/*-]/g, '\\$&')}[^\\n]*)`),
    // strings (escaped quotes: &quot; and &#39;)
    /(&quot;(?:[^&\\]|\\.|&(?!quot;))*&quot;|&#39;(?:[^&\\]|\\.|&(?!#39;))*&#39;|`(?:[^`\\]|\\.)*`)/,
    // numbers
    /\b(0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?)\b/,
    // identifiers (keyword or function call)
    /([A-Za-z_$][\w$]*)/,
  ];
  const combined = new RegExp(patterns.map((p) => p.source).join('|'), 'g');

  return escapedCode.replace(combined, (match, block, line, str, num, ident) => {
    if (block !== undefined) return `<span class="tok-com">${block}</span>`;
    if (line !== undefined) return `<span class="tok-com">${line}</span>`;
    if (str !== undefined) return `<span class="tok-str">${str}</span>`;
    if (num !== undefined) return `<span class="tok-num">${num}</span>`;
    if (ident !== undefined) {
      if (kw.has(ident)) return `<span class="tok-kw">${ident}</span>`;
      return `<span class="tok-fn" data-maybe-fn="1">${ident}</span>`;
    }
    return match;
  }).replace(/<span class="tok-fn" data-maybe-fn="1">([\w$]+)<\/span>(?=\()/g, '<span class="tok-fn">$1</span>')
    .replace(/<span class="tok-fn" data-maybe-fn="1">([\w$]+)<\/span>/g, '$1');
}

function inline(text) {
  let out = escapeHtml(text);
  // inline code first — its contents must not be touched by the rules below
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });

  out = out
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '<em>[image: $1]</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
    .replace(/(^|[\s(])([*_])(?=\S)([^*_]*?\S)\2(?=[\s).,!?:;]|$)/g, '$1<em>$3</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');

  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code class="inline">${codes[Number(i)]}</code>`);
}

function renderCodeBlock(lang, code, index) {
  const label = lang || 'text';
  return (
    `<div class="codeblock"><div class="head"><span class="lang">${escapeHtml(label)}</span>` +
    `<button data-copy-code="${index}">copy</button></div>` +
    `<pre><code data-code-index="${index}">${highlight(escapeHtml(code), lang.toLowerCase())}</code></pre></div>`
  );
}

function renderTable(rows) {
  const cells = (line) => line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  return (
    '<table><thead><tr>' + head.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>' +
    body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
    '</tbody></table>'
  );
}

function renderBlocks(src) {
  const lines = src.split('\n');
  const out = [];
  let i = 0;

  const isTableSep = (s) => /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(s) && s.includes('-');

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      const level = Math.min(line.match(/^\s*(#+)/)[1].length, 3);
      out.push(`<h${level}>${inline(line.replace(/^\s*#+\s*/, ''))}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s{0,3}([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (/^\s{0,3}>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push(`<blockquote>${renderBlocks(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // table: header row + separator row
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const buf = [lines[i], lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) buf.push(lines[i++]);
      out.push(renderTable(buf));
      continue;
    }

    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[2]);
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m) {
          // continuation line belonging to the previous item
          if (items.length && lines[i].trim() && /^\s+/.test(lines[i])) {
            items[items.length - 1] += '\n' + lines[i].trim();
            i++;
            continue;
          }
          break;
        }
        if (/\d/.test(m[2]) !== ordered) break;
        items.push(m[3]);
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s{0,3}(#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    out.push(`<p>${inline(para.join('\n'))}</p>`);
  }

  return out.join('');
}

/** Renders markdown to HTML. Returns { html, codes } — codes back the copy buttons. */
export function renderMarkdown(src) {
  const codes = [];
  let html = '';
  let rest = String(src ?? '');
  const fence = /(^|\n)[ \t]*(`{3,}|~{3,})([^\n`]*)\n?/;

  for (;;) {
    const open = fence.exec(rest);
    if (!open) { html += renderBlocks(rest); break; }

    html += renderBlocks(rest.slice(0, open.index));
    const marker = open[2];
    const lang = (open[3] || '').trim().split(/\s+/)[0];
    const after = rest.slice(open.index + open[0].length);

    const close = new RegExp(`(^|\\n)[ \\t]*${marker[0]}{${marker.length},}[ \\t]*(\\n|$)`).exec(after);
    const code = close ? after.slice(0, close.index) : after; // unterminated → still render
    codes.push(code);
    html += renderCodeBlock(lang, code, codes.length - 1);

    if (!close) break;
    rest = after.slice(close.index + close[0].length);
  }

  return { html, codes };
}
