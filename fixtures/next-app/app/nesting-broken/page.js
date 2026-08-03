'use client';
import { createElement as h } from 'react';
import scenario from '../../../../scenarios/nesting-div-in-p.js';

export const dynamic = 'force-static';
const Component = scenario.variants.broken;

export default function Page() {
  return h('div', { id: 'root' }, h(Component));
}
