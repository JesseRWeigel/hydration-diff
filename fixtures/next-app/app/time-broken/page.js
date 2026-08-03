'use client';
import { createElement as h } from 'react';
import scenario from '../../../../scenarios/time-during-render.js';

export const dynamic = 'force-dynamic';
const Component = scenario.variants.broken;

export default function Page() {
  return h('div', { id: 'root' }, h(Component));
}
