import { createElement as h } from 'react';

// The component is byte-identical in both variants. What differs is what happens to the DOM in
// the window between the HTML arriving and React hydrating it, which is exactly where a browser
// extension operates. Password managers inject an icon anchor next to password fields; this
// reproduces the shape LastPass uses.
function SignIn() {
  return h(
    'form',
    { className: 'signin', action: '/session', method: 'post' },
    h('label', { htmlFor: 'email' }, 'Email'),
    h('input', { id: 'email', name: 'email', type: 'email', autoComplete: 'username' }),
    h('label', { htmlFor: 'password' }, 'Password'),
    h('input', { id: 'password', name: 'password', type: 'password', autoComplete: 'current-password' }),
    h('button', { type: 'submit' }, 'Sign in'),
  );
}

export default {
  id: 'extension-mutation',
  title: 'A browser extension edits the DOM before hydration',
  cause: 'external-dom-mutation',
  summary:
    'Nothing in the application is wrong. Something outside it added a node inside the hydration root between parse and hydrate, and React blames the application.',
  fix: 'Nothing in the app can prevent it. Confirm it reproduces in a clean profile before spending time on the component; if the extension only touches nodes outside the root, React does not care.',
  variants: { broken: SignIn, fixed: SignIn },
  // BROKEN: the injected node lands inside the hydration root, between two nodes React owns.
  beforeHydrate: {
    broken(container, document) {
      const icon = document.createElement('div');
      icon.setAttribute('data-lastpass-icon-root', '');
      icon.setAttribute('style', 'position: relative; height: 0px; width: 0px; float: left;');
      const password = container.querySelector('#password');
      password.parentNode.insertBefore(icon, password);
    },
    // FIXED, in the only sense available: the same extension writing outside the hydration root.
    // The tool must report this as harmless rather than as a mismatch, because React never
    // compares it.
    fixed(container, document) {
      document.body.setAttribute('cz-shortcut-listen', 'true');
      const toolbar = document.createElement('div');
      toolbar.setAttribute('id', 'grammarly-toolbar');
      document.body.appendChild(toolbar);
    },
  },
  expect: {
    broken: {
      minMismatches: 1,
      mutation: true,
      kinds: ['node-only-left'],
      cause: 'external-dom-mutation',
    },
    fixed: { minMismatches: 0, mutation: true },
  },
};
