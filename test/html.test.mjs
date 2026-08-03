import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthored, parse, normalize, serialize, decodeEntities, textOf } from '../src/html.js';

const tagsOf = (node) => (node.children ?? []).filter((c) => c.t === 'el').map((c) => c.tag);

test('the authored parser does not repair invalid nesting, which is its whole job', () => {
  const tree = parseAuthored('<p class="a">x<div>y</div>z</p>');
  assert.equal(tree.children.length, 1);
  const p = tree.children[0];
  assert.equal(p.tag, 'p');
  assert.deepEqual(tagsOf(p), ['div']);
  assert.equal(textOf(p), 'xyz');
});

test('a <p> start tag inside a <p> stays nested in the authored tree', () => {
  const tree = parseAuthored('<p>a<p>b</p></p>');
  assert.deepEqual(tagsOf(tree), ['p']);
  assert.deepEqual(tagsOf(tree.children[0]), ['p']);
});

test('void elements do not swallow their siblings', () => {
  const tree = parseAuthored('<div><br><img src="a.png"><span>after</span></div>');
  const div = tree.children[0];
  assert.deepEqual(tagsOf(div), ['br', 'img', 'span']);
  assert.equal(div.children[1].attrs.src, 'a.png');
});

test('self-closing syntax closes the element', () => {
  const tree = parseAuthored('<div><input type="text"/><span>x</span></div>');
  assert.deepEqual(tagsOf(tree.children[0]), ['input', 'span']);
});

test('an end tag with no open counterpart is dropped rather than restructuring anything', () => {
  const tree = parseAuthored('<div>a</span>b</div>');
  assert.deepEqual(tagsOf(tree), ['div']);
  assert.equal(textOf(tree.children[0]), 'ab');
});

test('attribute values parse quoted, single-quoted, unquoted, and bare', () => {
  const el = parseAuthored('<a href="/x" title=\'y z\' data-n=7 hidden>t</a>').children[0];
  assert.equal(el.attrs.href, '/x');
  assert.equal(el.attrs.title, 'y z');
  assert.equal(el.attrs['data-n'], '7');
  assert.equal(el.attrs.hidden, '');
});

test('script and style content is not parsed as markup', () => {
  const tree = parseAuthored('<div><script>if (a < b) { x("</div>") }</script><p>after</p></div>');
  const div = tree.children[0];
  assert.deepEqual(tagsOf(div), ['script', 'p']);
  assert.match(div.children[0].children[0].value, /a < b/);
});

test('entities decode, including the forms the two sides disagree about', () => {
  assert.equal(decodeEntities('a&amp;b'), 'a&b');
  assert.equal(decodeEntities('&#x27;'), "'");
  assert.equal(decodeEntities('&#39;'), "'");
  assert.equal(decodeEntities('&lt;div&gt;'), '<div>');
  assert.equal(decodeEntities('&nbsp;'), ' ');
  assert.equal(decodeEntities('&notanentity;'), '&notanentity;');
});

test('a non-breaking space is not folded into an ordinary space', () => {
  // If it were, a real mismatch between `&nbsp;` and ` ` would be invisible, and that mismatch
  // is one people actually ship.
  const a = parse('<p>a b</p>');
  const b = parse('<p>a b</p>');
  assert.notEqual(textOf(a), textOf(b));
});

test("React's text-separator comments are folded away and adjacent text merges", () => {
  const withSeparators = parse('<p>Hi <!-- -->Bek<!-- -->!</p>');
  const without = parse('<p>Hi Bek!</p>');
  assert.deepEqual(withSeparators, without);
  assert.equal(withSeparators.children[0].children.length, 1);
});

test('a real comment is kept', () => {
  const tree = parse('<p><!-- keep me --></p>');
  assert.equal(tree.children[0].children[0].t, 'comment');
});

test('style declarations normalize to one spelling', () => {
  const react = parse('<i style="color:red;font-weight:bold"></i>');
  const dom = parse('<i style="color: red; font-weight: bold;"></i>');
  assert.deepEqual(react, dom);
});

test('style normalization does not equate different declarations', () => {
  const a = parse('<i style="color:red"></i>');
  const b = parse('<i style="color:blue"></i>');
  assert.notDeepEqual(a, b);
});

test('class whitespace collapses but class content does not', () => {
  assert.deepEqual(parse('<i class="a  b"></i>'), parse('<i class="a b"></i>'));
  assert.notDeepEqual(parse('<i class="a b"></i>'), parse('<i class="a c"></i>'));
});

test('attribute names are compared case-insensitively because the DOM lowercases them', () => {
  assert.deepEqual(parse('<input readOnly="">'), parse('<input readonly="">'));
});

test('serialize round-trips through parse', () => {
  const html = '<div class="a"><p>x &amp; y</p><br><span data-k="v">z</span></div>';
  assert.equal(serialize(parse(html)), html);
});

test('normalize is idempotent', () => {
  const once = parse('<p>a<!-- -->b<!-- -->c</p>');
  assert.deepEqual(normalize(once), once);
});
