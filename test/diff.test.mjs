import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/html.js';
import { diffTrees, mismatches, alignChildren } from '../src/diff.js';

const wrap = (html) => parse(`<body><div id="root">${html}</div></body>`);
const run = (a, b) => diffTrees(wrap(a), wrap(b), { rootId: 'root' });
const ops = (a, b) => mismatches(run(a, b));

test('identical trees produce no ops', () => {
  assert.equal(ops('<p class="a">x</p>', '<p class="a">x</p>').length, 0);
});

test('a changed text node is one op with a path to that node', () => {
  const [op, ...rest] = ops('<div><p>old</p></div>', '<div><p>new</p></div>');
  assert.equal(rest.length, 0);
  assert.equal(op.kind, 'text-changed');
  assert.equal(op.left, 'old');
  assert.equal(op.right, 'new');
  assert.equal(op.path, 'body[0] > div#root[0] > div[0] > p[0] > #text[0]');
});

test('attribute differences are reported per attribute and named', () => {
  const found = ops('<i class="a" title="t">x</i>', '<i class="b" data-n="1">x</i>');
  assert.deepEqual(
    found.map((o) => [o.kind, o.attr]).sort(),
    [['attr-changed', 'class'], ['attr-only-left', 'title'], ['attr-only-right', 'data-n']].sort(),
  );
});

test('one inserted node reports as one op, not as a mismatch on everything after it', () => {
  // Index-by-index comparison is the failure this alignment exists to avoid: it would report
  // four changes for one insertion, which is the same unhelpful shape as React's own message.
  const before = '<ul><li>a</li><li>b</li><li>c</li><li>d</li></ul>';
  const after = '<ul><li>a</li><li>NEW</li><li>b</li><li>c</li><li>d</li></ul>';
  const found = ops(before, after);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'node-only-right');
  assert.match(found[0].right, /NEW/);
});

test('a node inserted at the front is also one op', () => {
  const found = ops('<ul><li>a</li><li>b</li></ul>', '<ul><li>NEW</li><li>a</li><li>b</li></ul>');
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'node-only-right');
});

test('a node removed from the middle is one op on the left', () => {
  const found = ops('<ul><li>a</li><li>b</li><li>c</li></ul>', '<ul><li>a</li><li>c</li></ul>');
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'node-only-left');
  assert.match(found[0].left, />b</);
});

test('a differently tagged wrapper is reported once, not once per descendant', () => {
  const deep = '<h2>t</h2><ul><li><span>a</span></li><li><span>b</span></li></ul>';
  const found = ops(`<section>${deep}</section>`, `<article>${deep}</article>`);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((o) => o.kind), ['node-only-left', 'node-only-right']);
});

test('changes outside the hydration root are reported but not counted as mismatches', () => {
  const left = parse('<body><div id="root"><p>x</p></div></body>');
  const right = parse('<body cz-shortcut-listen="true"><div id="root"><p>x</p></div><div id="ext"></div></body>');
  const result = diffTrees(left, right, { rootId: 'root' });
  assert.equal(mismatches(result).length, 0);
  assert.equal(result.ops.length, 2);
  assert.ok(result.ops.every((o) => o.scope === 'outside-root'));
});

test('without a rootId nothing is in scope, which is why capture asserts the root exists', () => {
  const left = parse('<body><div id="root"><p>x</p></div></body>');
  const right = parse('<body><div id="root"><p>y</p></div></body>');
  assert.equal(mismatches(diffTrees(left, right)).length, 0);
  assert.equal(mismatches(diffTrees(left, right, { rootId: 'root' })).length, 1);
});

test('ops come back in document order', () => {
  const found = ops('<div><p>a</p><p>b</p><p>c</p></div>', '<div><p>A</p><p>b</p><p>C</p></div>');
  assert.deepEqual(found.map((o) => o.left), ['a', 'c']);
});

test('alignChildren anchors on identical subtrees', () => {
  const a = parse('<div><p>a</p><p>b</p></div>').children[0].children;
  const b = parse('<div><p>a</p><span>x</span><p>b</p></div>').children[0].children;
  const entries = alignChildren(a, b);
  assert.equal(entries.filter((e) => e.kind === 'pair').length, 2);
  assert.equal(entries.filter((e) => e.kind === 'added').length, 1);
});
