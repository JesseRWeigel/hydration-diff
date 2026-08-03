import { createElement as h } from 'react';

// BROKEN: a <p> start tag inside an open <p> is an implied end tag. The browser closes the outer
// paragraph and makes the inner one its sibling, so the nesting the component describes does not
// survive parsing. The same repair applies to <li> in <li>, <a> in <a>, and <form> in <form>.
function BrokenNote() {
  return h(
    'div',
    { className: 'notice' },
    h(
      'p',
      { className: 'note' },
      'Heads up: ',
      h('p', { className: 'inner' }, 'the token expires tonight.'),
    ),
  );
}

// FIXED: two sibling paragraphs, which is what the browser was going to build anyway.
function FixedNote() {
  return h(
    'div',
    { className: 'notice' },
    h('p', { className: 'note' }, 'Heads up: '),
    h('p', { className: 'inner' }, 'the token expires tonight.'),
  );
}

export default {
  id: 'nesting-p-in-p',
  title: '<p> inside <p>, closed early by the implied end tag rule',
  cause: 'invalid-nesting',
  summary:
    'A <p> start tag closes any open <p>. The inner paragraph becomes a sibling, so the tree React expects is one level deeper than the tree that exists.',
  fix: 'Emit the paragraphs as siblings.',
  variants: { broken: BrokenNote, fixed: FixedNote },
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
