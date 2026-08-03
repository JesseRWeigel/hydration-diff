import { createElement as h } from 'react';

// A fixed instant. Nothing here is random and nothing reads the clock, which is what makes this
// case confusing in the wild: the data is identical on both sides and the rendering still
// differs, because the formatting resolves against the machine's timezone and default locale.
const CHARGED_AT = new Date('2026-03-14T21:30:00Z');
const AMOUNT = 1234567.891;

// BROKEN: no explicit locale and no explicit timezone. The server runs with TZ=UTC and an
// en-US default; the browser is in Asia/Tokyo with a de-DE default.
function BrokenReceipt() {
  return h(
    'dl',
    { className: 'receipt' },
    h('dt', null, 'Charged'),
    h('dd', { className: 'when' }, CHARGED_AT.toLocaleString()),
    h('dt', null, 'Amount'),
    h('dd', { className: 'amount' }, AMOUNT.toLocaleString()),
  );
}

// FIXED: both sides are told exactly which locale and which timezone to format in.
function FixedReceipt() {
  return h(
    'dl',
    { className: 'receipt' },
    h('dt', null, 'Charged'),
    h(
      'dd',
      { className: 'when' },
      CHARGED_AT.toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }),
    ),
    h('dt', null, 'Amount'),
    h(
      'dd',
      { className: 'amount' },
      AMOUNT.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    ),
  );
}

export default {
  id: 'locale-timezone',
  title: 'Locale and timezone formatting differ between server and browser',
  cause: 'locale-or-timezone',
  summary:
    'toLocaleString() with no explicit locale or timeZone resolves against the host. The server process runs TZ=UTC LANG=en_US and the client process runs TZ=Asia/Tokyo LANG=de_DE, which is a real deployment shape.',
  fix: 'Pass an explicit locale and an explicit timeZone, or format on the client only.',
  variants: { broken: BrokenReceipt, fixed: FixedReceipt },
  serverEnv: { TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
  clientEnv: { TZ: 'Asia/Tokyo', LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8' },
  expect: {
    broken: {
      minMismatches: 2,
      kinds: ['text-changed'],
      cause: 'locale-or-timezone',
      api: 'Date#toLocaleString()',
    },
    fixed: { minMismatches: 0 },
  },
};
