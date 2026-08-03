import { createElement as h } from 'react';

// A second control. The serialised forms differ between React's server output and the DOM's own
// innerHTML round trip, without anything having changed:
//
//   style   React writes `color:red;font-weight:bold`, the DOM writes `color: red; font-weight: bold;`
//   text    React escapes an apostrophe as `&#x27;`, the DOM writes it literally
//   nbsp    React writes a raw U+00A0, the DOM writes `&nbsp;`
//
// Every one of those is a false mismatch waiting to happen, and each is folded away by a rule in
// html.js that this scenario keeps honest.
function Widget() {
  return h(
    'fieldset',
    { className: 'widget  spaced', disabled: true },
    h(
      'legend',
      { style: { color: 'red', fontWeight: 'bold' }, tabIndex: -1 },
      `It\u2019s the encoder's fault \u00a0& then some <angle>`,
    ),
    h('input', { type: 'checkbox', defaultChecked: true, readOnly: true, name: 'agree' }),
    h('progress', { value: 0.4, max: 1 }),
  );
}

export default {
  id: 'control-attribute-shapes',
  title: 'Attribute and entity round trips (control, must report nothing)',
  cause: null,
  control: true,
  summary:
    'Styles, boolean attributes, and escaped entities serialise differently on the two sides while describing the same tree.',
  fix: 'Nothing to fix. This is what correct output looks like.',
  variants: { fixed: Widget },
  expect: { fixed: { minMismatches: 0 } },
};
