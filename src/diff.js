// Align two parsed trees and report every place they differ, in document order.
//
// The alignment matters more than the comparison. A naive index-by-index walk turns one inserted
// node into a mismatch on every node after it, which is the same unhelpful shape as React's own
// error. So identical subtrees are matched first by an exact hash, and only the runs between
// those anchors are paired positionally. One inserted `<div>` then reports as one inserted
// `<div>`.

import { serialize } from './html.js';

function signature(node) {
  if (node.t === 'el') return `el:${node.tag}`;
  if (node.t === 'text') return 'text';
  return 'comment';
}

function hash(node) {
  return `${signature(node)}|${serialize(node)}`;
}

function kindLabel(node) {
  if (node.t === 'el') return node.tag;
  if (node.t === 'text') return '#text';
  return '#comment';
}

function childPaths(children) {
  const counts = new Map();
  return children.map((child) => {
    const kind = kindLabel(child);
    const n = counts.get(kind) ?? 0;
    counts.set(kind, n + 1);
    let step = `${kind}[${n}]`;
    if (child.t === 'el' && child.attrs.id) step = `${child.tag}#${child.attrs.id}[${n}]`;
    return step;
  });
}

function lcsPairs(a, b) {
  const ha = a.map(hash);
  const hb = b.map(hash);
  const n = a.length;
  const m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = ha[i] === hb[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ha[i] === hb[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * Produce an ordered list of alignment entries for two child lists.
 * Entries: { kind: 'pair' | 'removed' | 'added', ai, bi }
 */
export function alignChildren(a, b) {
  const anchors = lcsPairs(a, b);
  const out = [];
  let ai = 0;
  let bi = 0;

  const fillGap = (aEnd, bEnd) => {
    const left = [];
    const right = [];
    for (let k = ai; k < aEnd; k += 1) left.push(k);
    for (let k = bi; k < bEnd; k += 1) right.push(k);
    // Pair from the front while the node kinds agree, then from the back. What is left in the
    // middle genuinely has no counterpart.
    let p = 0;
    while (p < left.length && p < right.length
      && signature(a[left[p]]) === signature(b[right[p]])) p += 1;
    let s = 0;
    while (left.length - s - 1 >= p && right.length - s - 1 >= p
      && signature(a[left[left.length - 1 - s]]) === signature(b[right[right.length - 1 - s]])) {
      s += 1;
    }
    for (let k = 0; k < p; k += 1) out.push({ kind: 'pair', ai: left[k], bi: right[k] });
    for (let k = p; k < left.length - s; k += 1) out.push({ kind: 'removed', ai: left[k] });
    for (let k = p; k < right.length - s; k += 1) out.push({ kind: 'added', bi: right[k] });
    for (let k = s - 1; k >= 0; k -= 1) {
      out.push({ kind: 'pair', ai: left[left.length - 1 - k], bi: right[right.length - 1 - k] });
    }
    ai = aEnd;
    bi = bEnd;
  };

  for (const [x, y] of anchors) {
    if (x > ai || y > bi) fillGap(x, y);
    out.push({ kind: 'pair', ai: x, bi: y });
    ai = x + 1;
    bi = y + 1;
  }
  if (ai < a.length || bi < b.length) fillGap(a.length, b.length);
  return out;
}

function summarize(node) {
  const s = serialize(node);
  return s.length > 220 ? `${s.slice(0, 217)}...` : s;
}

/**
 * diffTrees(left, right, options) -> { ops, leftLabel, rightLabel }
 *
 * `rootSelector` (an element id) marks the hydration root. Ops outside it are reported with
 * scope 'outside-root'; a browser extension that writes an attribute onto <body> is real, and
 * is also not something React compares.
 */
export function diffTrees(left, right, options = {}) {
  const { leftLabel = 'left', rightLabel = 'right', rootId = null } = options;
  const ops = [];

  const walk = (a, b, pathParts, insideRoot) => {
    if (a.t === 'text') {
      if (a.value !== b.value) {
        ops.push({
          kind: 'text-changed',
          path: pathParts.join(' > '),
          scope: insideRoot ? 'in-root' : 'outside-root',
          left: a.value,
          right: b.value,
        });
      }
      return;
    }
    if (a.t === 'comment') {
      if (a.value !== b.value) {
        ops.push({
          kind: 'comment-changed',
          path: pathParts.join(' > '),
          scope: insideRoot ? 'in-root' : 'outside-root',
          left: a.value,
          right: b.value,
        });
      }
      return;
    }

    // The hydration root's own element is not part of the comparison React makes: React owns the
    // container's children, not the container's attributes. So the element itself keeps the
    // enclosing scope and only its descendants become in-root.
    const isRoot = a.t === 'el' && rootId !== null && a.attrs.id === rootId;
    const here = insideRoot;
    const hereForChildren = insideRoot || isRoot;

    if (a.t === 'el') {
      if (a.tag !== b.tag) {
        ops.push({
          kind: 'tag-changed',
          path: pathParts.join(' > '),
          scope: here ? 'in-root' : 'outside-root',
          left: a.tag,
          right: b.tag,
        });
      }
      const names = new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)]);
      for (const name of [...names].sort()) {
        const av = a.attrs[name];
        const bv = b.attrs[name];
        if (av === bv) continue;
        if (av === undefined) {
          ops.push({
            kind: 'attr-only-right', path: pathParts.join(' > '), attr: name,
            scope: here ? 'in-root' : 'outside-root', left: null, right: bv,
          });
        } else if (bv === undefined) {
          ops.push({
            kind: 'attr-only-left', path: pathParts.join(' > '), attr: name,
            scope: here ? 'in-root' : 'outside-root', left: av, right: null,
          });
        } else {
          ops.push({
            kind: 'attr-changed', path: pathParts.join(' > '), attr: name,
            scope: here ? 'in-root' : 'outside-root', left: av, right: bv,
          });
        }
      }
    }

    const aSteps = childPaths(a.children);
    const bSteps = childPaths(b.children);
    for (const entry of alignChildren(a.children, b.children)) {
      if (entry.kind === 'pair') {
        walk(
          a.children[entry.ai], b.children[entry.bi],
          [...pathParts, aSteps[entry.ai]], hereForChildren,
        );
      } else if (entry.kind === 'removed') {
        const node = a.children[entry.ai];
        ops.push({
          kind: 'node-only-left',
          path: [...pathParts, aSteps[entry.ai]].join(' > '),
          scope: hereForChildren ? 'in-root' : 'outside-root',
          left: summarize(node),
          right: null,
        });
      } else {
        const node = b.children[entry.bi];
        ops.push({
          kind: 'node-only-right',
          path: [...pathParts, bSteps[entry.bi]].join(' > '),
          scope: hereForChildren ? 'in-root' : 'outside-root',
          left: null,
          right: summarize(node),
        });
      }
    }
  };

  walk(left, right, [], false);
  return { ops, leftLabel, rightLabel };
}

export function mismatches(result) {
  return result.ops.filter((op) => op.scope === 'in-root');
}
