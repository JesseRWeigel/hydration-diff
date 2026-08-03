import { createElement as h, useEffect, useState } from 'react';

// A wide draw on purpose. A `Math.round(Math.random() * 40)` discount collides between the two
// renders about one run in forty, and a test that passes 97.6% of the time is worse than no test.
// The token carries roughly 41 bits, so the two renders disagree every time.
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
    h('p', { className: 'price' }, `$${(120 - discount).toFixed(2)}`),
    h('span', { className: 'badge', 'data-variant': token }, `${discount}% off`),
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
    h('p', { className: 'price' }, `$${(120 - offer.discount).toFixed(2)}`),
    h('span', { className: 'badge', 'data-variant': offer.token }, `${offer.discount}% off`),
  );
}

export default {
  id: 'random-during-render',
  title: 'Math.random() called during render',
  cause: 'nondeterministic-random',
  summary:
    'A value drawn from Math.random() during render differs between the server pass and the client pass.',
  fix: 'Draw the value in an effect, or pass one value down from a source both renders share.',
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
