import { createElement as h, useEffect, useState } from 'react';

function Row({ label, value }) {
  return h(
    'li',
    { className: 'row' },
    h('span', { className: 'k' }, label),
    h('span', { className: 'v' }, value),
  );
}

function Details() {
  return h(
    'ul',
    { className: 'rows' },
    h(Row, { key: 'plan', label: 'Plan', value: 'Team' }),
    h(Row, { key: 'seats', label: 'Seats', value: '12' }),
    h(Row, { key: 'renews', label: 'Renews', value: '2026-11-02' }),
  );
}

// BROKEN: the wrapper element depends on whether `window` exists. Everything below it is
// identical on both sides. This is the shape that makes React's message useless: the single
// divergence is the outermost tag, and the error the developer sees names a node several levels
// down, because that is where React's walk first runs out of agreement.
function BrokenPanel() {
  const Wrapper = typeof window === 'undefined' ? 'section' : 'article';
  return h(
    Wrapper,
    { className: 'panel' },
    h('h2', null, 'Subscription'),
    h(Details),
    h('footer', { className: 'panel-foot' }, 'Managed by billing'),
  );
}

// FIXED: both sides render the same first pass, and the client-only variation is applied after
// mount.
function FixedPanel() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  return h(
    'section',
    { className: mounted ? 'panel panel--interactive' : 'panel' },
    h('h2', null, 'Subscription'),
    h(Details),
    h('footer', { className: 'panel-foot' }, 'Managed by billing'),
  );
}

export default {
  id: 'env-branch',
  title: 'typeof window branching in render',
  cause: 'environment-branch',
  summary:
    'The component chooses a different element depending on whether window exists. The divergence is at the top of the subtree and every descendant is identical.',
  fix: 'Render the server shape first, then switch after mount with a state flag set in an effect.',
  variants: { broken: BrokenPanel, fixed: FixedPanel },
  expect: {
    broken: {
      minMismatches: 1,
      kinds: ['node-only-left', 'node-only-right'],
      cause: 'environment-branch',
      api: 'typeof window',
    },
    fixed: { minMismatches: 0 },
  },
};
