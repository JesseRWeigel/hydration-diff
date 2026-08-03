#!/usr/bin/env node
// Load docs/index.html in a real Chromium and assert on what the browser actually did with it.
//
// The failure this exists for is a page whose entire inline script fails to parse. The file still
// looks fine, every Node test still passes because they import modules directly, and the page
// renders as static HTML with an empty explorer. So the assertions below are on nodes that only
// the script can have created, and on numbers the script had to read out of the payload.
//
// Traps avoided here, each of which has cost time in this workspace:
//   - a stale server on a fixed port serves a different project's page, so this binds to port 0
//     and asserts on the served bytes rather than on a 200;
//   - the shared Playwright browser can be navigated away mid-check by another agent, so this
//     launches its own Chromium and re-asserts document.title inside every evaluation;
//   - `body { overflow-x: hidden }` would hide real overflow and make the probe vacuous, so the
//     overflow check walks elements and ignores only what sits inside a scroll container.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const TITLE = 'hydration-diff';

const require = createRequire(join(root, 'package.json'));
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core is not installed, so the page check cannot run.');
  console.error('This is a failure and not a skip. Without it nothing here loads the page, and');
  console.error('a page whose script fails to parse passes every unit test in the suite.');
  console.error('Install it with:  npm install');
  process.exit(1);
}

const html = readFileSync(join(root, 'docs', 'index.html'), 'utf8');
const data = JSON.parse(readFileSync(join(root, 'data', 'captures.json'), 'utf8'));

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  ok    ${m}`); pass += 1; };
const bad = (m) => { console.log(`  FAIL  ${m}`); fail += 1; };

// Recomputed here from the recording, not read off the page.
const expected = {
  scenarios: new Set(data.captures.map((c) => c.scenario.id)).size,
  runs: data.captures.length,
  firstId: data.captures[0].scenario.id,
  firstBrokenOps: data.captures.find((c) => c.scenario.id === data.captures[0].scenario.id && c.variant === 'broken').counts.hydration,
};

const server = createServer((req, res) => {
  if ((req.url ?? '/') !== '/' && req.url !== '/index.html') {
    res.writeHead(404).end('not here');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto(url, { waitUntil: 'load' });

  const served = await (await fetch(url)).text();
  if (served.includes('<title>hydration-diff</title>')) ok('the local server served this project\'s page');
  else bad('the local server served something else');

  const first = await page.evaluate(() => ({
    title: document.title,
    scriptRan: document.documentElement.getAttribute('data-script'),
    navButtons: document.querySelectorAll('#scenario-nav button').length,
    detailChildren: document.getElementById('detail').children.length,
    matrixRows: document.querySelectorAll('table.matrix tbody tr').length,
    stages: document.querySelectorAll('#detail .stage').length,
    diffRows: document.querySelectorAll('#detail .row').length,
    siteText: (document.querySelector('#detail .site') || {}).textContent || '',
    verdict: (document.querySelector('#detail .verdict') || {}).textContent || '',
  }));

  if (first.title !== TITLE) {
    bad(`the browser is on a different page (title "${first.title}")`);
  } else {
    ok(`page identity confirmed (title "${first.title}")`);

    if (first.scriptRan === 'ran') ok('the inline script parsed and ran to completion');
    else bad('the inline script did not finish; the page is static HTML');

    if (first.navButtons === expected.scenarios) ok(`${first.navButtons} scenario buttons, built by the script`);
    else bad(`expected ${expected.scenarios} scenario buttons, found ${first.navButtons}`);

    if (first.matrixRows === expected.runs) ok(`${first.matrixRows} rows in the run matrix`);
    else bad(`expected ${expected.runs} matrix rows, found ${first.matrixRows}`);

    if (first.stages === 3) ok('the three pipeline stages are rendered for the selected run');
    else bad(`expected 3 stages, found ${first.stages}`);

    if (first.diffRows > 0) ok(`${first.diffRows} diff rows rendered for ${expected.firstId}/broken`);
    else bad('no diff rows rendered, so the explorer is empty');

    if (/scenarios\/.+\.js:\d+/.test(first.siteText)) ok(`the cause card names a source line: ${first.siteText.trim()}`);
    else bad(`the cause card names no source line (saw "${first.siteText}")`);

    if (first.verdict.includes(String(expected.firstBrokenOps))) {
      ok(`the verdict shows the recorded mismatch count (${expected.firstBrokenOps})`);
    } else {
      bad(`expected the verdict to mention ${expected.firstBrokenOps}, saw "${first.verdict}"`);
    }
  }

  // Switching variants must actually re-render, which is the only thing that proves the event
  // handlers were attached rather than merely written.
  await page.click('#detail .variants button:last-child');
  const afterSwitch = await page.evaluate(() => ({
    title: document.title,
    verdict: (document.querySelector('#detail .verdict') || {}).textContent || '',
    diffRows: document.querySelectorAll('#detail .row').length,
  }));
  if (afterSwitch.title !== TITLE) bad('the browser navigated away mid-check');
  else if (/No hydration mismatch/.test(afterSwitch.verdict) && afterSwitch.diffRows === 0) {
    ok('clicking the fixed variant re-renders to a clean verdict');
  } else {
    bad(`the fixed variant still shows "${afterSwitch.verdict}" with ${afterSwitch.diffRows} rows`);
  }

  // Overflow at 390px, by measurement rather than by hiding it.
  const overflow = await page.evaluate(() => {
    if (document.title !== 'hydration-diff') return { wrongPage: true };
    const docWidth = document.documentElement.clientWidth;
    const scrolls = (el) => {
      const v = getComputedStyle(el).overflowX;
      return v === 'auto' || v === 'scroll';
    };
    const offenders = [];
    for (const el of document.querySelectorAll('*')) {
      let anc = el.parentElement;
      let inScroller = false;
      while (anc) {
        if (scrolls(anc)) { inScroller = true; break; }
        anc = anc.parentElement;
      }
      if (inScroller) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right > docWidth + 0.5 || r.left < -0.5) {
        offenders.push(`${el.tagName.toLowerCase()}.${el.className || '(no class)'} right=${r.right.toFixed(1)}`);
      }
    }
    return {
      docWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyOverflowX: getComputedStyle(document.body).overflowX,
      offenders: offenders.slice(0, 6),
    };
  });
  if (overflow.wrongPage) {
    bad('the overflow probe ran against a different page');
  } else {
    if (overflow.bodyOverflowX === 'hidden') {
      bad('body has overflow-x: hidden, which hides real overflow and makes this probe vacuous');
    } else {
      ok(`body overflow-x is "${overflow.bodyOverflowX}", so overflow would be visible if present`);
    }
    if (overflow.offenders.length === 0 && overflow.scrollWidth <= overflow.docWidth + 0.5) {
      ok(`no element escapes the viewport at 390px (scrollWidth ${overflow.scrollWidth} <= ${overflow.docWidth})`);
    } else {
      bad(`${overflow.offenders.length} element(s) overflow at 390px, scrollWidth ${overflow.scrollWidth} vs ${overflow.docWidth}`);
      for (const o of overflow.offenders) console.log(`        ${o}`);
    }
  }

  // Dark mode has to work through both mechanisms independently.
  const lightBg = await page.evaluate(() => {
    document.documentElement.removeAttribute('data-theme');
    return getComputedStyle(document.body).backgroundColor;
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  const mediaDarkBg = await page.evaluate(() => ({
    title: document.title,
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  if (mediaDarkBg.title === TITLE && mediaDarkBg.bg !== lightBg) {
    ok(`prefers-color-scheme: dark changes the background (${lightBg} -> ${mediaDarkBg.bg})`);
  } else {
    bad(`prefers-color-scheme: dark did not change the background (still ${mediaDarkBg.bg})`);
  }

  // With the OS preference dark, an explicit light attribute must still win.
  const attrLight = await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'light');
    return getComputedStyle(document.body).backgroundColor;
  });
  if (attrLight === lightBg) ok('data-theme="light" overrides a dark OS preference');
  else bad(`data-theme="light" did not override the media query (got ${attrLight}, expected ${lightBg})`);

  await page.emulateMedia({ colorScheme: 'light' });
  const attrDark = await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    return getComputedStyle(document.body).backgroundColor;
  });
  if (attrDark === mediaDarkBg.bg) ok('data-theme="dark" overrides a light OS preference');
  else bad(`data-theme="dark" did not override the media query (got ${attrDark})`);

  // The toggle button is script, so it is also evidence the script ran.
  await page.evaluate(() => { document.documentElement.removeAttribute('data-theme'); });
  await page.click('#theme-toggle');
  const afterToggle = await page.evaluate(() => ({
    title: document.title,
    theme: document.documentElement.getAttribute('data-theme'),
  }));
  if (afterToggle.title === TITLE && afterToggle.theme === 'dark') ok('the theme toggle sets data-theme');
  else bad(`the theme toggle did not set data-theme (got ${afterToggle.theme})`);

  if (consoleErrors.length === 0) ok('no console errors while loading and driving the page');
  else {
    bad(`${consoleErrors.length} console error(s) on the page`);
    for (const e of consoleErrors.slice(0, 4)) console.log(`        ${e.slice(0, 180)}`);
  }

  // Self-contained: no request may leave for another host.
  const external = /<(?:script|link|img|iframe|source|video|audio)[^>]+(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i;
  if (external.test(html)) bad('the page references an external resource');
  else ok('the page references no external resource');
  if (/@import\s+url|url\(\s*["']?https?:/i.test(html)) bad('the CSS pulls in a remote resource');
  else ok('the CSS pulls in nothing remote');

  await context.close();
} finally {
  await browser.close();
  server.close();
}

console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
