#!/usr/bin/env node
// Corroborate the whole model against real Next.js in real Chromium.
//
// The engine in src/ runs React's own renderToString and React's own hydrateRoot, but it does so
// in jsdom, and the single most important claim in this project is about what a BROWSER's parser
// does to invalid markup. jsdom uses parse5, which implements the same specification, and "two
// spec implementations agree" is worth something only if one of them is the thing being claimed
// about. So this drives the actual browser.
//
// The Next fixture in fixtures/next-app imports the same scenario modules the engine uses, so
// there is no second copy of the components to drift.
//
// Three questions, each answered by a measurement:
//   1. Does the browser's parser really restructure `<p><div></div></p>`? Answered with
//      JavaScript disabled, so the DOM read back is the parser's output and nothing else.
//   2. Does Chromium's repair match the one jsdom produced? Same input string into both.
//   3. Does real Next.js + real React really report a hydration error for the broken routes and
//      stay quiet for the fixed ones?

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { parse, serialize } from '../src/html.js';
import { diffTrees, mismatches } from '../src/diff.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const app = join(root, 'fixtures', 'next-app');
const TITLE = 'hydration-diff next fixture';

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  ok    ${m}`); pass += 1; };
const bad = (m) => { console.log(`  FAIL  ${m}`); fail += 1; };

const require = createRequire(join(root, 'package.json'));
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core is not installed, so the browser half of this check cannot run.');
  console.error('This is a failure and not a skip: without it nothing here observes a real');
  console.error('parser, and the parser is the claim. Install it with:  npm install');
  process.exit(1);
}

if (!existsSync(join(app, 'node_modules', 'next'))) {
  console.error('The Next.js fixture is not installed, so the real-framework half cannot run.');
  console.error('This is a failure and not a skip. Install it with:');
  console.error('  npm --prefix fixtures/next-app install');
  process.exit(1);
}

if (!existsSync(join(app, '.next', 'BUILD_ID'))) {
  console.log('  ..    building the Next fixture (no .next present)');
  execFileSync('npx', ['next', 'build'], { cwd: app, stdio: 'pipe' });
}

// https://react.dev/errors/<n>. Production React ships codes instead of sentences.
const REACT_ERROR_CODES = {
  418: 'Hydration failed because the server rendered HTML did not match the client.',
  421: 'This Suspense boundary received an update before it finished hydrating.',
  422: 'There was an error while hydrating this Suspense boundary.',
  423: 'There was an error while hydrating.',
  425: 'Text content does not match server-rendered HTML.',
};

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
// A production build, deliberately, after trying dev first. In dev the Next error overlay
// installs its own console.error handler and the hydration message never reaches the page's
// console, so the check saw nothing on routes that were definitely failing. Production surfaces
// it as an uncaught error with a documented code, which is a signal that cannot be swallowed.
// The decode table below turns the code back into the sentence.
const server = spawn('npx', ['next', 'start', '-p', String(port)], {
  cwd: app,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const stop = () => { try { server.kill('SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stop);

async function waitForServer() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/nesting-broken`);
      const body = await res.text();
      // A stale server on this port would answer 200 with someone else's page, so the readiness
      // test is on the bytes and not on the status code.
      if (res.ok && body.includes(TITLE)) return body;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the Next server did not serve this fixture within 120s\n${serverLog}`);
}

await waitForServer();

const ROUTES = [
  { path: '/nesting-broken', broken: true, repairs: true },
  { path: '/nesting-fixed', broken: false, repairs: false },
  { path: '/time-broken', broken: true, repairs: false },
  { path: '/time-fixed', broken: false, repairs: false },
  { path: '/env-broken', broken: true, repairs: false },
  { path: '/env-fixed', broken: false, repairs: false },
];

function rootHtmlFromDocument(html) {
  const tree = parse(html);
  const found = [];
  const walk = (n) => {
    if (n.t === 'el' && n.attrs.id === 'root') found.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  if (found.length !== 1) throw new Error(`expected exactly one #root, found ${found.length}`);
  return serialize(found[0]);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const chromeVersion = browser.version();
const results = [];

for (const route of ROUTES) {
  const res = await fetch(`${base}${route.path}`);
  const body = await res.text();
  if (!res.ok || !body.includes(TITLE)) {
    bad(`${route.path}: the dev server did not serve this fixture (status ${res.status})`);
  }
}

try {
  // Pass 1: JavaScript off. Whatever is in the DOM is what the HTML parser built, with no React
  // and no framework runtime anywhere near it.
  const staticContext = await browser.newContext({ javaScriptEnabled: false });
  for (const route of ROUTES) {
    const page = await staticContext.newPage();
    // Navigate and measure as one step, and assert identity inside the evaluation, because the
    // browser could otherwise be somewhere else entirely by the time the read happens.
    const response = await page.goto(`${base}${route.path}`, { waitUntil: 'load' });
    const measured = await page.evaluate(() => ({
      title: document.title,
      path: location.pathname,
      root: document.getElementById('root')?.outerHTML ?? null,
    }));
    // The bytes of THIS navigation, not a second request. A separate fetch of /time-broken
    // returns a different timestamp, and comparing that against the DOM from the first response
    // reported a parser repair on a route where the parser had done nothing at all. Read before
    // the page closes, because the response body dies with it.
    const served = await response.text();
    await page.close();
    if (measured.title !== TITLE || measured.path !== route.path) {
      bad(`${route.path}: measured a different page (title=${measured.title} path=${measured.path})`);
      continue;
    }
    results.push({ route, servedRoot: rootHtmlFromDocument(served), chromiumRoot: measured.root });
  }
  await staticContext.close();

  // Pass 2: JavaScript on. Next boots, React hydrates, and React says what it thinks.
  const liveContext = await browser.newContext();
  for (const entry of results) {
    const page = await liveContext.newPage();
    const messages = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') messages.push(msg.text());
    });
    page.on('pageerror', (err) => messages.push(`pageerror: ${err.message}`));
    await page.goto(`${base}${entry.route.path}`, { waitUntil: 'networkidle' });
    const identity = await page.evaluate(() => ({ title: document.title, path: location.pathname }));
    await page.waitForTimeout(500);
    await page.close();
    if (identity.title !== TITLE || identity.path !== entry.route.path) {
      bad(`${entry.route.path}: hydration pass measured a different page`);
      continue;
    }
    entry.console = messages;
  }
  await liveContext.close();
} finally {
  await browser.close();
  stop();
}

if (results.length !== ROUTES.length) bad(`only ${results.length} of ${ROUTES.length} routes were measured`);

for (const entry of results) {
  const { route, servedRoot, chromiumRoot } = entry;
  const emittedTree = parse(servedRoot);
  const chromiumTree = parse(chromiumRoot);
  const repair = diffTrees(emittedTree, chromiumTree, {
    leftLabel: 'HTML Next.js served', rightLabel: 'DOM Chromium built', rootId: 'root',
  });
  const ops = mismatches(repair);

  if (route.repairs) {
    if (ops.length > 0) {
      ok(`${route.path}: Chromium restructured the served markup (${ops.length} change(s))`);
      const emptyP = ops.some((op) => op.kind === 'node-only-right' && op.right === '<p></p>');
      if (emptyP) ok(`${route.path}: the browser opened an empty <p> that nobody wrote`);
      else bad(`${route.path}: expected the parser to leave an empty <p> behind`);
    } else {
      bad(`${route.path}: expected the parser to restructure the markup, it did not`);
    }
  } else if (ops.length === 0) {
    ok(`${route.path}: Chromium built exactly the tree that was served`);
  } else {
    bad(`${route.path}: unexpected parser repair (${ops.length} change(s))`);
  }

  // Same input string into jsdom. If the two implementations disagree, the engine's jsdom-based
  // results are describing something other than a browser.
  const dom = new JSDOM('<!doctype html><html><body><div id="holder"></div></body></html>');
  const holder = dom.window.document.getElementById('holder');
  holder.innerHTML = servedRoot;
  const jsdomTree = parse(holder.innerHTML);
  const cross = mismatches(diffTrees(jsdomTree, chromiumTree, {
    leftLabel: 'jsdom', rightLabel: 'Chromium', rootId: 'root',
  }));
  if (cross.length === 0) ok(`${route.path}: jsdom and Chromium built the same tree from the same bytes`);
  else bad(`${route.path}: jsdom and Chromium disagree in ${cross.length} place(s)`);

  // In dev the message is spelled out. The minified production form (`Minified React error
  // #418`) is matched too, so this check does not quietly depend on the mode.
  const hydrationErrors = (entry.console ?? [])
    .filter((m) => /hydrat/i.test(m) || /React error #(418|421|422|423|425)/.test(m));
  const decoded = hydrationErrors
    .map((m) => {
      const code = /React error #(\d+)/.exec(m);
      return code ? REACT_ERROR_CODES[Number(code[1])] ?? m : m;
    })
    .filter(Boolean);

  if (route.broken) {
    if (hydrationErrors.length > 0) {
      ok(`${route.path}: real Next.js reported a hydration error: ${(decoded[0] ?? '').slice(0, 80)}`);
    } else {
      bad(`${route.path}: expected a hydration error from real Next.js, saw none`);
      for (const m of (entry.console ?? []).slice(0, 3)) console.log(`        ${m.slice(0, 160)}`);
    }
  } else if (hydrationErrors.length === 0) {
    ok(`${route.path}: real Next.js reported no hydration error`);
  } else {
    bad(`${route.path}: unexpected hydration error on a fixed route`);
    for (const m of hydrationErrors.slice(0, 2)) console.log(`        ${m.slice(0, 200)}`);
  }
}

const nextVersion = JSON.parse(
  execFileSync('node', ['-p', 'JSON.stringify(require("next/package.json").version)'], { cwd: app }).toString(),
);
console.log(`  ${pass} passed, ${fail} failed  (real Next.js ${nextVersion} production build, real Chromium ${chromeVersion})`);
process.exit(fail === 0 ? 0 : 1);
