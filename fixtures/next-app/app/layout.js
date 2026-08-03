import { createElement as h } from 'react';

export const metadata = { title: 'hydration-diff next fixture' };

export default function RootLayout({ children }) {
  return h('html', { lang: 'en' }, h('body', null, children));
}
