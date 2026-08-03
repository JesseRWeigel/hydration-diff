// Turn a diff into a named cause.
//
// A diff on its own says two trees differ, which is roughly what React already says. The value is
// in the next sentence: which of the small set of known causes produced it, and which line.
//
// Three independent sources of evidence feed this, and they are ranked in that order because
// that is the order of certainty:
//
//   1. The emitted-vs-parsed diff. If the browser's tree is not the tree React wrote, the parser
//      repaired something. That is a proof, not an inference.
//   2. The parsed-vs-pre-hydration diff. If the DOM changed between parse and hydrate, something
//      outside the application edited it.
//   3. The instrumentation records. A `Math.random()` recorded during the render pass on both
//      sides, at a known file and line, explains a text mismatch better than any heuristic over
//      the strings.

import { mismatches } from './diff.js';

// Content that a <p> cannot contain. The browser closes the paragraph at each of these.
const NOT_ALLOWED_IN_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);
// Elements that cannot contain themselves at any depth without the parser intervening.
const SELF_NESTING_BANNED = new Set(['a', 'form', 'button', 'p']);
// Direct-child-only self nesting, where the parser closes the open one.
const SELF_NESTING_DIRECT = new Set(['li', 'dt', 'dd', 'option', 'tr', 'td', 'th']);

const EXTENSION_SIGNATURES = [
  { match: /^data-lastpass-/, name: 'LastPass' },
  { match: /^data-lp-/, name: 'LastPass' },
  { match: /^data-gramm/, name: 'Grammarly' },
  { match: /^grammarly/, name: 'Grammarly' },
  { match: /^cz-shortcut-listen$/, name: 'ColorZilla' },
  { match: /^data-1p-/, name: '1Password' },
  { match: /^data-onepassword-/, name: '1Password' },
  { match: /^data-dashlane/, name: 'Dashlane' },
  { match: /^data-bitwarden/, name: 'Bitwarden' },
  { match: /^data-honey-/, name: 'Honey' },
  { match: /^data-darkreader/, name: 'Dark Reader' },
];

const API_TO_CAUSE = [
  { match: /^Math\.random/, cause: 'nondeterministic-random' },
  { match: /^new Date|^Date\.now/, cause: 'nondeterministic-time' },
  { match: /^Date#toLocale|^Number#toLocaleString|^Intl\./, cause: 'locale-or-timezone' },
  { match: /^localStorage|^sessionStorage/, cause: 'client-only-storage' },
  { match: /^typeof window|^typeof document|^navigator/, cause: 'environment-branch' },
];

export const CAUSE_TITLES = {
  'invalid-nesting': 'Invalid HTML nesting, repaired by the parser before React saw it',
  'external-dom-mutation': 'Something outside the application edited the DOM before hydration',
  'nondeterministic-random': 'A random value was drawn during render',
  'nondeterministic-time': 'The clock was read during render',
  'locale-or-timezone': 'Formatting resolved against the host locale or timezone',
  'client-only-storage': 'Browser-only storage was read during render',
  'environment-branch': 'The render branched on whether it was running in a browser',
  unattributed: 'A mismatch with no identified cause',
};

export const CAUSE_FIXES = {
  'invalid-nesting':
    'Emit markup the parser will keep. A <p> may only contain phrasing content, and a second <p> closes the first.',
  'external-dom-mutation':
    'The application cannot prevent this. Reproduce in a clean browser profile before changing any component.',
  'nondeterministic-random': 'Draw the value in an effect, or pass one value down from a shared source.',
  'nondeterministic-time': 'Render a placeholder and set the time in an effect.',
  'locale-or-timezone': 'Pass an explicit locale and an explicit timeZone to every formatter.',
  'client-only-storage': 'Read storage in an effect, or send the value from the server in a cookie.',
  'environment-branch': 'Render the server shape first and switch after mount with a state flag.',
  unattributed:
    'None of the known causes fired. The diff below is still the real divergence; start from its path.',
};

/**
 * Find the specific nesting violation in the tree as authored. Structural, not statistical: it
 * walks ancestors, so `<p><span><div>` is found as well as `<p><div>`.
 */
export function findNestingViolations(emittedTree) {
  const found = [];
  const walk = (node, ancestors, path) => {
    if (node.t === 'el') {
      const openTags = ancestors.map((a) => a.tag);
      if (openTags.includes('p') && NOT_ALLOWED_IN_P.has(node.tag)) {
        found.push({
          detail: `<${node.tag}> inside <p>`,
          path: path.join(' > '),
          why: node.tag === 'p'
            ? 'A <p> start tag closes any open <p>, so the inner paragraph becomes a sibling.'
            : `<${node.tag}> is not phrasing content, so the parser closes the paragraph before it and opens a new empty one after it.`,
        });
      }
      const parent = ancestors[ancestors.length - 1];
      if (parent && SELF_NESTING_DIRECT.has(node.tag) && parent.tag === node.tag) {
        found.push({
          detail: `<${node.tag}> directly inside <${node.tag}>`,
          path: path.join(' > '),
          why: `A <${node.tag}> start tag closes an open <${node.tag}>.`,
        });
      }
      if (SELF_NESTING_BANNED.has(node.tag) && openTags.includes(node.tag) && node.tag !== 'p') {
        found.push({
          detail: `<${node.tag}> inside <${node.tag}>`,
          path: path.join(' > '),
          why: `<${node.tag}> may not be nested; the parser will restructure it.`,
        });
      }
    }
    const counts = new Map();
    for (const child of node.children ?? []) {
      const kind = child.t === 'el' ? child.tag : (child.t === 'text' ? '#text' : '#comment');
      const n = counts.get(kind) ?? 0;
      counts.set(kind, n + 1);
      // Same step format the diff uses, including the `#id` decoration, so a path in a cause
      // and a path in a diff can be compared by eye.
      const step = child.t === 'el' && child.attrs.id
        ? `${child.tag}#${child.attrs.id}[${n}]`
        : `${kind}[${n}]`;
      walk(
        child,
        node.t === 'el' ? [...ancestors, node] : ancestors,
        [...path, step],
      );
    }
  };
  walk(emittedTree, [], []);
  return found;
}

function extensionFor(ops) {
  // Scoped to the mutation itself, deliberately. An earlier version also swept every attribute
  // in the pre-hydration tree, which would name Grammarly for any application that carries the
  // common `data-gramm="false"` opt-out on a textarea, whatever the actual mutation was.
  const names = new Set();
  const tokens = new Set();
  for (const op of ops) {
    if (op.attr) tokens.add(op.attr);
    for (const side of [op.left, op.right]) {
      if (typeof side !== 'string') continue;
      for (const m of side.matchAll(/([a-zA-Z0-9_:-]+)\s*=/g)) tokens.add(m[1]);
      // Extensions are as likely to be identifiable by an id or a class as by an attribute name.
      for (const m of side.matchAll(/(?:id|class)\s*=\s*"([^"]*)"/g)) {
        for (const word of m[1].split(/\s+/)) if (word) tokens.add(word);
      }
    }
  }
  for (const token of tokens) {
    for (const sig of EXTENSION_SIGNATURES) {
      if (sig.match.test(token)) names.add(sig.name);
    }
  }
  return [...names];
}

function causeForApi(api) {
  for (const rule of API_TO_CAUSE) if (rule.match.test(api)) return rule.cause;
  return null;
}

/**
 * classify(input) -> { causes, notes, firstDivergence }
 *
 * `causes` is ordered by certainty. Each entry names a cause id, the evidence that produced it,
 * and where available the file and line.
 */
export function classify({
  repairDiff,
  mutationDiff,
  hydrationDiff,
  emittedTree,
  serverRecords = [],
  clientRecords = [],
}) {
  const causes = [];
  const notes = [];
  const repairOps = mismatches(repairDiff);
  const mutationOps = mismatches(mutationDiff);
  const hydrationOps = mismatches(hydrationDiff);

  if (repairOps.length > 0) {
    const violations = findNestingViolations(emittedTree);
    causes.push({
      id: 'invalid-nesting',
      confidence: 'certain',
      evidence: violations.length > 0
        ? violations.map((v) => `${v.detail} at ${v.path}: ${v.why}`)
        : ['The parsed tree is not the tree React emitted, but no known content-model rule matched.'],
      sites: violations.map((v) => ({ path: v.path, detail: v.detail })),
      opCount: repairOps.length,
    });
  }

  if (mutationOps.length > 0 || mutationDiff.ops.length > 0) {
    const names = extensionFor(mutationDiff.ops);
    const entry = {
      id: 'external-dom-mutation',
      confidence: 'certain',
      inRoot: mutationOps.length > 0,
      evidence: [
        mutationOps.length > 0
          ? `${mutationOps.length} change(s) inside the hydration root between parse and hydrate.`
          : `${mutationDiff.ops.length} change(s) outside the hydration root between parse and hydrate. React does not compare these.`,
        names.length > 0
          ? `Attribute names match ${names.join(', ')}.`
          : 'No known extension signature in the added markup.',
      ],
      extensions: names,
      opCount: mutationOps.length,
    };
    if (mutationOps.length > 0) causes.push(entry);
    else notes.push(entry);
  }

  // Runtime evidence. A call only explains a mismatch if there was a mismatch; a `Date.now()` in
  // an effect is correct code and must never be reported as a cause.
  const byKey = new Map();
  const add = (rec, side) => {
    if (rec.phase !== 'server-render' && rec.phase !== 'client-render') return;
    const cause = causeForApi(rec.api);
    if (!cause) return;
    const key = `${cause}|${rec.file}:${rec.line}|${rec.api}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        id: cause,
        confidence: 'likely',
        api: rec.api,
        file: rec.file,
        line: rec.line,
        column: rec.column,
        componentStack: rec.componentStack,
        detail: rec.detail,
        server: 0,
        client: 0,
      };
      byKey.set(key, entry);
    }
    entry[side] += 1;
  };
  for (const rec of serverRecords) add(rec, 'server');
  for (const rec of clientRecords) add(rec, 'client');

  for (const entry of byKey.values()) {
    entry.evidence = [
      `${entry.api} called during render at ${entry.file}:${entry.line}` +
        (entry.detail ? ` (${entry.detail})` : ''),
      `server render: ${entry.server} call(s), client render: ${entry.client} call(s)`,
      entry.componentStack.length > 0
        ? `component stack: ${entry.componentStack.join(' < ')}`
        : 'no component frame',
    ];
    if (hydrationOps.length > 0) causes.push(entry);
    else notes.push({ ...entry, confidence: 'not-a-cause', why: 'no mismatch was found' });
  }

  const effectPhase = [...serverRecords, ...clientRecords].filter((r) => r.phase === 'hydrate');
  if (effectPhase.length > 0) {
    // A site already named as a cause is not also interesting as an effect-phase note. React
    // re-renders the failing subtree during hydration, so every render-phase call shows up here
    // too and would double every entry.
    const seen = new Set(causes.filter((c) => c.file).map((c) => `${c.file}:${c.line}`));
    for (const rec of effectPhase) {
      const key = `${rec.file}:${rec.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      notes.push({
        id: 'effect-phase-call',
        confidence: 'not-a-cause',
        api: rec.api,
        file: rec.file,
        line: rec.line,
        evidence: [`${rec.api} at ${rec.file}:${rec.line} ran after hydration, not during render.`],
      });
    }
  }

  if (hydrationOps.length > 0 && causes.length === 0) {
    causes.push({
      id: 'unattributed',
      confidence: 'unknown',
      evidence: [
        `${hydrationOps.length} mismatch(es) with no matching runtime call, no parser repair, and no external mutation.`,
      ],
      opCount: hydrationOps.length,
    });
  }

  const order = ['invalid-nesting', 'external-dom-mutation'];
  causes.sort((a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return { causes, notes, firstDivergence: hydrationOps[0] ?? null };
}
