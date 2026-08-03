import { createElement as h, useEffect, useState } from 'react';

function readTheme() {
  if (typeof localStorage === 'undefined') return 'light';
  return localStorage.getItem('theme') ?? 'light';
}

// BROKEN: localStorage is read during render. There is no localStorage on the server, so the
// guard falls through to the default, and the browser has a stored value. The divergence lands
// on attributes rather than text, which React reports in an even vaguer form.
function BrokenShell() {
  const theme = readTheme();
  return h(
    'div',
    { className: `shell theme-${theme}`, 'data-theme': theme },
    h('p', { className: 'hint' }, `Theme: ${theme}`),
  );
}

// FIXED: the first render always uses the default, and the stored value is applied after mount.
function FixedShell() {
  const [theme, setTheme] = useState('light');
  useEffect(() => { setTheme(readTheme()); }, []);
  return h(
    'div',
    { className: `shell theme-${theme}`, 'data-theme': theme },
    h('p', { className: 'hint' }, `Theme: ${theme}`),
  );
}

export default {
  id: 'client-storage',
  title: 'localStorage read during render',
  cause: 'client-only-storage',
  summary:
    'The stored theme exists only in the browser, so the server renders the default and the client renders the stored value.',
  fix: 'Read storage in an effect and re-render, or send the preference from the server (a cookie is readable there).',
  variants: { broken: BrokenShell, fixed: FixedShell },
  // Seeds the browser storage before either render, the way a returning visitor would have it.
  seedClient(window) {
    window.localStorage.setItem('theme', 'dark');
  },
  expect: {
    broken: {
      minMismatches: 2,
      kinds: ['attr-changed', 'text-changed'],
      cause: 'client-only-storage',
      api: 'localStorage.getItem()',
    },
    fixed: { minMismatches: 0, settledChange: true },
  },
};
