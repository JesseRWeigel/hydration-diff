import { createElement as h, useEffect, useState } from 'react';

// BROKEN: the clock is read during render. The server pass and the client pass happen at
// different instants, so both the visible text and the `datetime` attribute differ. This is the
// case that produces an attribute mismatch as well as a text one, which matters because React's
// message for an attribute mismatch is even less specific than its message for text.
function BrokenReceiptStamp() {
  const now = new Date();
  return h(
    'div',
    { className: 'stamp' },
    h('time', { dateTime: now.toISOString() }, now.toISOString().slice(11, 23)),
    h('p', { className: 'epoch' }, `epoch ${Date.now()}`),
  );
}

// FIXED: render a placeholder, then fill it in after hydration.
function FixedReceiptStamp() {
  const [now, setNow] = useState(null);
  useEffect(() => { setNow(new Date()); }, []);
  return h(
    'div',
    { className: 'stamp' },
    h(
      'time',
      { dateTime: now ? now.toISOString() : undefined },
      now ? now.toISOString().slice(11, 23) : '--:--:--.---',
    ),
    h('p', { className: 'epoch' }, now ? `epoch ${now.getTime()}` : 'epoch --'),
  );
}

export default {
  id: 'time-during-render',
  title: 'new Date() / Date.now() read during render',
  cause: 'nondeterministic-time',
  summary:
    'The current time is read during render. The server render and the client render happen at different instants, so the text and the datetime attribute both diverge.',
  fix: 'Render a placeholder and set the real time in an effect, or pass a timestamp captured once.',
  variants: { broken: BrokenReceiptStamp, fixed: FixedReceiptStamp },
  expect: {
    broken: {
      minMismatches: 3,
      kinds: ['text-changed', 'attr-changed'],
      cause: 'nondeterministic-time',
      api: 'new Date()',
    },
    fixed: { minMismatches: 0 },
  },
};
