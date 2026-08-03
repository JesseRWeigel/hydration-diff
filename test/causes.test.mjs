import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/html.js';
import { diffTrees } from '../src/diff.js';
import { classify, findNestingViolations } from '../src/causes.js';

const wrap = (html) => parse(`<body><div id="root">${html}</div></body>`);
const noDiff = diffTrees(wrap(''), wrap(''), { rootId: 'root' });

function classifyWith({ hydration = noDiff, repair = noDiff, mutation = noDiff, server = [], client = [], emitted = wrap(''), pre = wrap('') } = {}) {
  return classify({
    repairDiff: repair,
    mutationDiff: mutation,
    hydrationDiff: hydration,
    emittedTree: emitted,
    preHydrationTree: pre,
    serverRecords: server,
    clientRecords: client,
  });
}

const record = (api, over = {}) => ({
  api, detail: null, phase: 'server-render', file: 'scenarios/x.js', line: 12, column: 3,
  componentStack: ['Widget'], ...over,
});

test('a nesting violation is found through an intervening element', () => {
  const found = findNestingViolations(wrap('<p><span><div>x</div></span></p>'));
  assert.equal(found.length, 1);
  assert.equal(found[0].detail, '<div> inside <p>');
  assert.match(found[0].path, /div\[0\]$/);
});

test('valid nesting produces no violation', () => {
  assert.equal(findNestingViolations(wrap('<p><span><em>x</em></span></p>')).length, 0);
});

test('a <p> inside a <p> is reported with the implied-end-tag explanation', () => {
  const found = findNestingViolations(wrap('<p>a<p>b</p></p>'));
  assert.equal(found.length, 1);
  assert.match(found[0].why, /closes any open <p>/);
});

test('<li> directly inside <li> is a violation, <li> inside a nested <ul> is not', () => {
  assert.equal(findNestingViolations(wrap('<ul><li>a<li>b</li></li></ul>')).length, 1);
  assert.equal(findNestingViolations(wrap('<ul><li>a<ul><li>b</li></ul></li></ul>')).length, 0);
});

test('a repair diff always yields the invalid-nesting cause, with certainty', () => {
  const repair = diffTrees(wrap('<p><div>x</div></p>'), wrap('<p></p><div>x</div><p></p>'), { rootId: 'root' });
  const hydration = repair;
  const out = classifyWith({ repair, hydration, emitted: wrap('<p><div>x</div></p>') });
  const nesting = out.causes.find((c) => c.id === 'invalid-nesting');
  assert.ok(nesting);
  assert.equal(nesting.confidence, 'certain');
  assert.match(nesting.evidence[0], /<div> inside <p>/);
});

test('a render-phase call becomes a cause only when there is a mismatch to explain', () => {
  const hydration = diffTrees(wrap('<p>a</p>'), wrap('<p>b</p>'), { rootId: 'root' });
  const withMismatch = classifyWith({ hydration, server: [record('Math.random()')] });
  assert.deepEqual(withMismatch.causes.map((c) => c.id), ['nondeterministic-random']);

  const withoutMismatch = classifyWith({ server: [record('Math.random()')] });
  assert.equal(withoutMismatch.causes.length, 0);
  assert.equal(withoutMismatch.notes[0].confidence, 'not-a-cause');
});

test('an effect-phase call is never a cause, even when there is a mismatch', () => {
  const hydration = diffTrees(wrap('<p>a</p>'), wrap('<p>b</p>'), { rootId: 'root' });
  const out = classifyWith({ hydration, client: [record('Date.now()', { phase: 'hydrate' })] });
  assert.deepEqual(out.causes.map((c) => c.id), ['unattributed']);
  assert.ok(out.notes.some((n) => n.id === 'effect-phase-call'));
});

test('each trapped API maps to its cause', () => {
  const hydration = diffTrees(wrap('<p>a</p>'), wrap('<p>b</p>'), { rootId: 'root' });
  const cases = [
    ['Math.random()', 'nondeterministic-random'],
    ['new Date()', 'nondeterministic-time'],
    ['Date.now()', 'nondeterministic-time'],
    ['Date#toLocaleString()', 'locale-or-timezone'],
    ['Number#toLocaleString()', 'locale-or-timezone'],
    ['Intl.DateTimeFormat', 'locale-or-timezone'],
    ['localStorage.getItem()', 'client-only-storage'],
    ['sessionStorage', 'client-only-storage'],
    ['typeof window', 'environment-branch'],
    ['typeof document', 'environment-branch'],
  ];
  for (const [api, cause] of cases) {
    const out = classifyWith({ hydration, server: [record(api)] });
    assert.deepEqual(out.causes.map((c) => c.id), [cause], `${api} should map to ${cause}`);
  }
});

test('an untrapped API leaves the mismatch unattributed rather than guessing', () => {
  const hydration = diffTrees(wrap('<p>a</p>'), wrap('<p>b</p>'), { rootId: 'root' });
  const out = classifyWith({ hydration, server: [record('crypto.getRandomValues()')] });
  assert.deepEqual(out.causes.map((c) => c.id), ['unattributed']);
});

test('an in-root pre-hydration mutation is a cause and an out-of-root one is only a note', () => {
  const parsed = parse('<body><div id="root"><form><input></form></div></body>');
  const inRoot = parse('<body><div id="root"><form><div data-lastpass-icon-root=""></div><input></form></div></body>');
  const outRoot = parse('<body cz-shortcut-listen="true"><div id="root"><form><input></form></div></body>');

  const a = classifyWith({
    mutation: diffTrees(parsed, inRoot, { rootId: 'root' }),
    hydration: diffTrees(inRoot, parsed, { rootId: 'root' }),
    pre: inRoot,
  });
  const mutation = a.causes.find((c) => c.id === 'external-dom-mutation');
  assert.ok(mutation);
  assert.deepEqual(mutation.extensions, ['LastPass']);

  const b = classifyWith({ mutation: diffTrees(parsed, outRoot, { rootId: 'root' }), pre: outRoot });
  assert.equal(b.causes.length, 0);
  const note = b.notes.find((n) => n.id === 'external-dom-mutation');
  assert.ok(note);
  assert.deepEqual(note.extensions, ['ColorZilla']);
});

test('the structural causes are ranked ahead of the runtime ones', () => {
  const repair = diffTrees(wrap('<p><div>x</div></p>'), wrap('<p></p><div>x</div><p></p>'), { rootId: 'root' });
  const out = classifyWith({
    repair,
    hydration: repair,
    emitted: wrap('<p><div>x</div></p>'),
    server: [record('Math.random()')],
  });
  assert.equal(out.causes[0].id, 'invalid-nesting');
});

test('firstDivergence is the first in-root op in document order', () => {
  const hydration = diffTrees(
    wrap('<div><p>a</p><p>b</p></div>'),
    wrap('<div><p>A</p><p>B</p></div>'),
    { rootId: 'root' },
  );
  const out = classifyWith({ hydration });
  assert.equal(out.firstDivergence.left, 'a');
});
