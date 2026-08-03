import { createElement as h } from 'react';

// A control, not a bug. React writes `<!-- -->` between adjacent text children so the client can
// find the boundary again; a client render of the same tree has two text nodes and no comment.
// A differ that does not fold that away reports a mismatch on every interpolated string in the
// application, which is the failure mode that makes a detector worthless. This scenario exists
// so that failure is caught by the suite rather than by a user.
function Greeting() {
  const user = 'Bek';
  const unread = 3;
  return h(
    'p',
    { className: 'greeting' },
    'Signed in as ',
    user,
    '. You have ',
    String(unread),
    ' unread messages.',
  );
}

export default {
  id: 'control-text-separators',
  title: 'Adjacent text children (control, must report nothing)',
  cause: null,
  control: true,
  summary:
    'Interpolated text produces React text-separator comments in the server HTML and none in the client render. This must not be reported.',
  fix: 'Nothing to fix. This is what correct output looks like.',
  variants: { fixed: Greeting },
  expect: { fixed: { minMismatches: 0 } },
};
