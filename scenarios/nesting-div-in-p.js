import { createElement as h } from 'react';

// BROKEN, and the component is identical on both sides. Nothing here is non-deterministic:
// no clock, no random, no environment check. The server sends
//   <p class="lede">The build finished in <div class="stat">4.2s</div> which is faster.</p>
// and the browser's parser refuses to keep a <div> inside a <p>. It closes the paragraph before
// the div and opens a fresh empty one after it, so by the time React looks at the DOM there are
// three siblings where the component described one. React then reports a mismatch on a node the
// developer never wrote, and reading the component all afternoon will not show it.
function BrokenPost() {
  return h(
    'article',
    { className: 'post' },
    h(
      'p',
      { className: 'lede' },
      'The build finished in ',
      h('div', { className: 'stat' }, '4.2s'),
      ' which is faster than yesterday.',
    ),
  );
}

// FIXED: a phrasing-content element is allowed inside a paragraph, so the parser leaves the tree
// exactly as written.
function FixedPost() {
  return h(
    'article',
    { className: 'post' },
    h(
      'p',
      { className: 'lede' },
      'The build finished in ',
      h('span', { className: 'stat' }, '4.2s'),
      ' which is faster than yesterday.',
    ),
  );
}

export default {
  id: 'nesting-div-in-p',
  title: '<div> inside <p>, repaired by the HTML parser before React sees it',
  cause: 'invalid-nesting',
  summary:
    'The markup React emitted and the DOM the browser built are different documents. The paragraph is closed before the div and a second empty paragraph is opened after it.',
  fix: 'Use a phrasing-content element such as <span>, or move the block element out of the paragraph.',
  variants: { broken: BrokenPost, fixed: FixedPost },
  expect: {
    broken: {
      minMismatches: 1,
      repair: true,
      kinds: ['node-only-left', 'node-only-right'],
      cause: 'invalid-nesting',
    },
    fixed: { minMismatches: 0, repair: false },
  },
};
