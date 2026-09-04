import { createElement as h, useEffect, useState } from 'react';

// A wide draw on purpose. A `Math.round(Math.random() * 40)` discount collides between the two
// renders about one run in forty, and a test that passes 97.6% of the time is worse than no test.
// The token carries roughly 41 bits, so the two renders disagree every time.
//
// THE TOKEN HAS TO REACH THE TEXT, AND THAT WAS THE BUG IN THIS FILE. It used to appear only in
// the `data-variant` attribute, with the narrow discount carrying the visible text. That makes the
// two renders disagree every time, which is what the paragraph above claims and it is true, but it
// is only half of what this scenario has to guarantee. React raises `onRecoverableError` for text
// and structure and says NOTHING about a lone attribute. So on the one run in forty where the
// discount collided, the text was identical, React was correctly silent, and the assertion that
// React must corroborate this tool failed on a run where nothing was wrong.
//
// Widening the discount does not fix it, because any discount a human would read is narrow. The
// token going into the badge text does fix it: text now differs exactly when the attribute does,
// so React cannot be silent while this tool is not. What is left is both renders drawing the same
// 41-bit token, at which point there is genuinely no mismatch to find.
function draw() {
  const token = Math.random().toString(36).slice(2, 10);
  const discount = Math.round(Math.random() * 40);
  return { token, discount };
}

// BROKEN: drawn during render, so the server picks one value and the client picks another.
function BrokenOffer() {
  const { token, discount } = draw();
  return h(
    'div',
    { className: 'card' },
    h('h2', null, 'Winter jacket'),
    // THE PRICE DOES NOT VARY. It used to, and then the number of mismatches this scenario
    // produces was 3 on most runs and 2 on the runs where the discount collided, so no exact count
    // could be stated about it truthfully. The badge carries the wide draw and the price carries
    // none, which makes the count exactly two on every run: one text and one attribute.
    h('p', { className: 'price' }, '$120.00'),
    h('span', { className: 'badge', 'data-variant': token }, `${discount}% off, code ${token}`),
  );
}

// FIXED: the first render is deterministic on both sides. The draw moves into an effect, which
// never runs on the server and runs after hydration on the client.
function FixedOffer() {
  const [offer, setOffer] = useState({ token: 'baseline', discount: 0 });
  useEffect(() => { setOffer(draw()); }, []);
  return h(
    'div',
    { className: 'card' },
    h('h2', null, 'Winter jacket'),
    h('p', { className: 'price' }, '$120.00'),
    h('span', { className: 'badge', 'data-variant': offer.token }, `${offer.discount}% off, code ${offer.token}`),
  );
}

export default {
  id: 'random-during-render',
  title: 'Math.random() called during render',
  cause: 'nondeterministic-random',
  summary:
    'A value drawn from Math.random() during render differs between the server pass and the client pass.',
  fix: 'Draw the value in an effect, or pass one value down from a source both renders share.',
  // Drawn fresh on each render, so this scenario's recording legitimately differs from one run
  // to the next. verify.sh reads this flag to know which recordings are allowed to move, and
  // the README explains the dirty tree from the same flag. Declared here so those two cannot
  // drift apart from each other or from the scenario.
  nondeterministic: true,
  variants: { broken: BrokenOffer, fixed: FixedOffer },
  expect: {
    broken: {
      minMismatches: 2,
      kinds: ['text-changed', 'attr-changed'],
      cause: 'nondeterministic-random',
      api: 'Math.random()',
    },
    fixed: { minMismatches: 0, settledChange: true },
  },
};
