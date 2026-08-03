#!/usr/bin/env node
// The client half of a capture. Reads the server HTML on stdin and produces four things:
//
//   parsedBody       the DOM after the browser parsed the server HTML. Not the same document as
//                    the string, when the markup is invalid.
//   preHydrationBody the DOM at the instant React starts hydrating, after anything an extension
//                    did to it.
//   clientRender     what the component renders on the client, as authored. This is a render-only
//                    pass, so effects have not run and every recorded call is a render-phase call.
//   hydration        what React itself reported, captured through onRecoverableError and the
//                    console, plus the DOM after hydration and effects settled.
//
// Runs in its own process with its own TZ and locale.
//
// Usage: node runner/render-client.mjs <scenarioId> <variant>   (server HTML on stdin)

import { createElement } from 'react';
import { JSDOM } from 'jsdom';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecorder, installTraps } from '../src/instrument.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const scenarioRoot = join(repoRoot, 'scenarios');

const [scenarioId, variant] = process.argv.slice(2);
if (!scenarioId || !variant) {
  console.error('usage: render-client.mjs <scenarioId> <variant>   (server HTML on stdin)');
  process.exit(2);
}

const serverHtml = await new Promise((resolve, reject) => {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { buf += chunk; });
  process.stdin.on('end', () => resolve(buf));
  process.stdin.on('error', reject);
});

const dom = new JSDOM(
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>hydration-diff capture</title></head><body><div id="root"></div></body></html>',
  { url: 'https://hydration-diff.test/', pretendToBeVisual: true },
);
const { window } = dom;

for (const name of [
  'document', 'navigator', 'location', 'history', 'HTMLElement', 'Element', 'Node', 'NodeList',
  'Text', 'Comment', 'DocumentFragment', 'Event', 'CustomEvent', 'MutationObserver',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
  'cancelIdleCallback', 'CSS', 'DOMParser', 'XMLHttpRequest', 'HTMLIFrameElement', 'FormData',
  // Without these two a `typeof localStorage === 'undefined'` guard takes the server branch on
  // the client as well, and the storage scenario quietly stops being a scenario.
  'localStorage', 'sessionStorage',
]) {
  if (window[name] === undefined) continue;
  // Node 24 defines some of these (navigator, location) as accessors on the global object, so a
  // plain assignment throws. Redefining as a data property works for both cases.
  Object.defineProperty(globalThis, name, {
    value: window[name], writable: true, configurable: true, enumerable: false,
  });
}
globalThis.self = window;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// react-dom is imported only now, dynamically. Static imports are hoisted above everything above,
// so a top-level `import ... from 'react-dom/client'` would initialise React while `window` and
// `document` were still absent. It happens to work today, and depending on that is a bet on
// React's module initialisation staying lazy.
const { act } = await import('react');
const { renderToString } = await import('react-dom/server');
const { hydrateRoot } = await import('react-dom/client');

const { getScenario } = await import('../scenarios/index.js');
const scenario = getScenario(scenarioId);
const Component = scenario.variants[variant];
if (!Component) throw new Error(`scenario ${scenarioId} has no variant ${variant}`);

// A returning visitor's browser state, established before anything renders.
if (typeof scenario.seedClient === 'function') scenario.seedClient(window);

const container = window.document.getElementById('root');
container.innerHTML = serverHtml;
const parsedBody = window.document.body.outerHTML;

// Whatever runs between parse and hydrate: an extension's content script, a third-party snippet,
// a polyfill. This is the window React knows nothing about.
const mutate = scenario.beforeHydrate?.[variant];
if (typeof mutate === 'function') mutate(container, window.document);
const preHydrationBody = window.document.body.outerHTML;

const recorder = createRecorder({ sourceRoots: [scenarioRoot], repoRoot });
const uninstall = installTraps({
  record: recorder.record,
  hasWindow: true,
  windowValue: window,
});

// The client's first render, as authored, with no DOM involved. Anything recorded here happened
// during render, which is the distinction that separates a bug from a correct effect.
recorder.arm('client-render');
let clientRender;
try {
  clientRender = renderToString(createElement(Component));
} finally {
  recorder.disarm();
}

// Now the real thing: React hydrating the real DOM, reporting through its own channels.
const recoverable = [];
const consoleErrors = [];
const origConsoleError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
};

recorder.arm('hydrate');
let hydrationThrew = null;
try {
  await act(async () => {
    hydrateRoot(container, createElement(Component), {
      onRecoverableError(error, errorInfo) {
        recoverable.push({
          message: error instanceof Error ? error.message : String(error),
          componentStack: (errorInfo?.componentStack ?? '').trim(),
        });
      },
    });
  });
} catch (err) {
  hydrationThrew = err instanceof Error ? err.message : String(err);
} finally {
  recorder.disarm();
  console.error = origConsoleError;
}

const postHydrationBody = window.document.body.outerHTML;
uninstall();

process.stdout.write(JSON.stringify({
  parsedBody,
  preHydrationBody,
  clientRender,
  postHydrationBody,
  records: recorder.records,
  hydration: { recoverable, consoleErrors, threw: hydrationThrew },
  env: {
    TZ: process.env.TZ ?? null,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    node: process.version,
    dom: 'jsdom',
  },
}));
