// A deliberately literal HTML parser.
//
// This is the one piece of the project that must NOT behave like a browser. The browser's tree
// builder repairs invalid markup while it parses: `<p><div>x</div></p>` becomes three siblings,
// not a nested pair. That repair happens before React ever looks at the DOM, which is why the
// resulting hydration error names a node nobody wrote. To show the repair, something has to hold
// the tree as it was authored, and that is this file: it never inserts an implied end tag, never
// closes `<p>` on a block start tag, and never foster-parents anything out of a table.
//
// Everything else in the pipeline is parsed by the browser (or jsdom) and then read back through
// this same parser via innerHTML, so both sides of every diff go through one representation.
//
// Node shapes:
//   { t: 'el', tag, attrs: { name: value }, children: [] }
//   { t: 'text', value }
//   { t: 'comment', value }
//   { t: 'root', children: [] }

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Elements whose content is not parsed as markup.
const RAW_TEXT = new Set(['script', 'style']);
const ESCAPABLE_RAW_TEXT = new Set(['textarea', 'title']);

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–',
};

export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? whole : named;
  });
}

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

/**
 * Parse markup exactly as written. Returns a root node.
 *
 * `repair` is intentionally absent. If you want the browser's tree, ask a browser.
 */
export function parseAuthored(html) {
  const root = { t: 'root', children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const push = (node) => top().children.push(node);
  const pushText = (raw) => {
    if (raw === '') return;
    push({ t: 'text', value: decodeEntities(raw) });
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      const stop = end === -1 ? html.length : end;
      push({ t: 'comment', value: html.slice(lt + 4, stop) });
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    if (html[lt + 1] === '/') {
      const end = html.indexOf('>', lt);
      const stop = end === -1 ? html.length : end;
      const tag = html.slice(lt + 2, stop).trim().toLowerCase();
      // Pop to the nearest matching open element. An end tag with no open counterpart is
      // dropped, which is what a browser does too; it is not a structural repair.
      let depth = -1;
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k].tag === tag) { depth = k; break; }
      }
      if (depth > 0) stack.length = depth;
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    // Start tag.
    let j = lt + 1;
    while (j < html.length && !isSpace(html[j]) && html[j] !== '>' && html[j] !== '/') j += 1;
    const tag = html.slice(lt + 1, j).toLowerCase();
    if (tag === '') {
      // A bare `<` that is not a tag is text.
      pushText('<');
      i = lt + 1;
      continue;
    }
    const attrs = {};
    let selfClosing = false;
    while (j < html.length) {
      while (j < html.length && isSpace(html[j])) j += 1;
      if (j >= html.length) break;
      if (html[j] === '>') { j += 1; break; }
      if (html[j] === '/' && html[j + 1] === '>') { selfClosing = true; j += 2; break; }
      if (html[j] === '/') { j += 1; continue; }
      const nameStart = j;
      while (j < html.length && !isSpace(html[j]) && html[j] !== '=' && html[j] !== '>') j += 1;
      const name = html.slice(nameStart, j).toLowerCase();
      let value = '';
      let k = j;
      while (k < html.length && isSpace(html[k])) k += 1;
      if (html[k] === '=') {
        k += 1;
        while (k < html.length && isSpace(html[k])) k += 1;
        const quote = html[k];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, k + 1);
          const stop = end === -1 ? html.length : end;
          value = decodeEntities(html.slice(k + 1, stop));
          j = end === -1 ? html.length : end + 1;
        } else {
          const start = k;
          while (k < html.length && !isSpace(html[k]) && html[k] !== '>') k += 1;
          value = decodeEntities(html.slice(start, k));
          j = k;
        }
      }
      if (name !== '') attrs[name] = value;
    }

    const node = { t: 'el', tag, attrs, children: [] };
    push(node);
    i = j;

    if (VOID.has(tag) || selfClosing) continue;

    if (RAW_TEXT.has(tag) || ESCAPABLE_RAW_TEXT.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}`, i);
      const stop = close === -1 ? html.length : close;
      const body = html.slice(i, stop);
      if (body !== '') {
        node.children.push({
          t: 'text',
          value: ESCAPABLE_RAW_TEXT.has(tag) ? decodeEntities(body) : body,
        });
      }
      if (close === -1) {
        i = html.length;
      } else {
        const end = html.indexOf('>', close);
        i = end === -1 ? html.length : end + 1;
      }
      continue;
    }

    stack.push(node);
  }

  return root;
}

// React writes `<!-- -->` between adjacent text children so the client can find the boundary.
// The comment is not content. A client render of `{a}{b}` produces two text nodes with no
// comment at all, so leaving these in place would report a mismatch on every interpolated
// string in the app.
const REACT_TEXT_SEPARATOR = /^ ?$/;
// Suspense and activity boundary markers, also not content.
const REACT_BOUNDARY_MARKERS = new Set(['$', '/$', '$!', '$?', '&', '/&']);

function normalizeStyle(value) {
  return value
    .split(';')
    .map((decl) => decl.trim())
    .filter((decl) => decl !== '')
    .map((decl) => {
      const at = decl.indexOf(':');
      if (at === -1) return decl;
      return `${decl.slice(0, at).trim().toLowerCase()}:${decl.slice(at + 1).trim()}`;
    })
    .join(';');
}

function normalizeAttrs(attrs) {
  const out = {};
  for (const name of Object.keys(attrs).sort()) {
    let value = attrs[name];
    if (name === 'style') value = normalizeStyle(value);
    else if (name === 'class') value = value.trim().split(/\s+/).filter(Boolean).join(' ');
    out[name] = value;
  }
  return out;
}

/**
 * Fold away the representational differences that are not mismatches, so that what remains is
 * real. Every rule here has a test, because an over-eager normalizer is a detector that reports
 * "no mismatch" on a broken page.
 */
export function normalize(node) {
  if (node.t === 'text') return { t: 'text', value: node.value };
  if (node.t === 'comment') return { t: 'comment', value: node.value };

  const kids = [];
  for (const child of node.children) {
    if (child.t === 'comment') {
      const v = child.value;
      if (REACT_TEXT_SEPARATOR.test(v) || REACT_BOUNDARY_MARKERS.has(v.trim())) continue;
    }
    const norm = normalize(child);
    if (norm.t === 'text') {
      if (norm.value === '') continue;
      const prev = kids[kids.length - 1];
      if (prev && prev.t === 'text') {
        prev.value += norm.value;
        continue;
      }
    }
    kids.push(norm);
  }

  if (node.t === 'root') return { t: 'root', children: kids };
  return { t: 'el', tag: node.tag, attrs: normalizeAttrs(node.attrs), children: kids };
}

export function parse(html) {
  return normalize(parseAuthored(html));
}

const ESCAPE_TEXT = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const ESCAPE_ATTR = { '&': '&amp;', '"': '&quot;' };

export function serialize(node) {
  if (node.t === 'text') return node.value.replace(/[&<>]/g, (c) => ESCAPE_TEXT[c]);
  if (node.t === 'comment') return `<!--${node.value}-->`;
  if (node.t === 'root') return node.children.map(serialize).join('');
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${v.replace(/[&"]/g, (c) => ESCAPE_ATTR[c])}"`)
    .join('');
  if (VOID.has(node.tag)) return `<${node.tag}${attrs}>`;
  return `<${node.tag}${attrs}>${node.children.map(serialize).join('')}</${node.tag}>`;
}

export function textOf(node) {
  if (node.t === 'text') return node.value;
  if (node.t === 'comment') return '';
  return node.children.map(textOf).join('');
}

export { VOID };
