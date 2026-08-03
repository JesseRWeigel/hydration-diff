#!/usr/bin/env node
// Build docs/index.html from the recording that scripts/assert-scenarios.mjs just asserted.
//
// Everything on the page is a number or a string that came out of a live run. The page has no
// external resources of any kind, because a docs page that needs a CDN is a docs page that breaks
// when the CDN does.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAUSE_TITLES, CAUSE_FIXES } from '../src/causes.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const data = JSON.parse(readFileSync(join(root, 'data', 'captures.json'), 'utf8'));

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// Only what the page draws, so the inlined payload stays small enough to read.
const payload = {
  node: data.node,
  react: data.react,
  runCount: data.runCount,
  scenarioCount: data.scenarioCount,
  checks: data.checks,
  causeTitles: CAUSE_TITLES,
  causeFixes: CAUSE_FIXES,
  runs: data.captures.map((c) => ({
    id: c.scenario.id,
    variant: c.variant,
    title: c.scenario.title,
    cause: c.scenario.cause,
    control: c.scenario.control,
    summary: c.scenario.summary,
    fix: c.scenario.fix,
    env: { server: c.env.server, client: c.env.client },
    counts: c.counts,
    causes: c.analysis.causes.map((x) => ({
      id: x.id, confidence: x.confidence, evidence: x.evidence,
      file: x.file ?? null, line: x.line ?? null, api: x.api ?? null,
      componentStack: x.componentStack ?? null,
    })),
    notes: c.analysis.notes.map((x) => ({ id: x.id, evidence: x.evidence })),
    firstDivergence: c.analysis.firstDivergence,
    stages: [
      { key: 'repair', label: 'Parser repair', ...c.diffs.repair },
      { key: 'mutation', label: 'Mutation before hydration', ...c.diffs.mutation },
      { key: 'hydration', label: 'Hydration mismatch', ...c.diffs.hydration },
    ],
    html: c.html,
    react: {
      recoverable: c.react.recoverable,
      consoleErrors: c.react.consoleErrors.slice(0, 2),
    },
  })),
};

const causeCount = new Set(
  data.captures.filter((c) => !c.scenario.control && c.scenario.cause).map((c) => c.scenario.cause),
).size;
const brokenRuns = data.captures.filter((c) => c.counts.hydration > 0).length;
const cleanRuns = data.captures.length - brokenRuns;

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f7f5f2;
  --panel: #ffffff;
  --panel-2: #f0ece6;
  --ink: #1a1a1e;
  --muted: #5d5f68;
  --line: #ddd7cf;
  --accent: #8a3324;
  --accent-soft: #f6e3de;
  --server: #1f5f4f;
  --server-soft: #dff0ea;
  --client: #2b4a8b;
  --client-soft: #dee7f8;
  --warn: #7a4a00;
  --warn-soft: #f7e9cf;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14151a;
    --panel: #1b1d24;
    --panel-2: #23262f;
    --ink: #eceef2;
    --muted: #a3a8b4;
    --line: #333846;
    --accent: #ff9f85;
    --accent-soft: #3a241f;
    --server: #7fd6bd;
    --server-soft: #17332c;
    --client: #9dbcf5;
    --client-soft: #1a2540;
    --warn: #e8b866;
    --warn-soft: #382c17;
  }
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #f7f5f2; --panel: #ffffff; --panel-2: #f0ece6; --ink: #1a1a1e; --muted: #5d5f68;
  --line: #ddd7cf; --accent: #8a3324; --accent-soft: #f6e3de;
  --server: #1f5f4f; --server-soft: #dff0ea; --client: #2b4a8b; --client-soft: #dee7f8;
  --warn: #7a4a00; --warn-soft: #f7e9cf;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #14151a; --panel: #1b1d24; --panel-2: #23262f; --ink: #eceef2; --muted: #a3a8b4;
  --line: #333846; --accent: #ff9f85; --accent-soft: #3a241f;
  --server: #7fd6bd; --server-soft: #17332c; --client: #9dbcf5; --client-soft: #1a2540;
  --warn: #e8b866; --warn-soft: #382c17;
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.wrap { max-width: 1080px; margin: 0 auto; padding: 28px 18px 72px; }
h1 { font-size: clamp(1.6rem, 5vw, 2.3rem); margin: 0 0 6px; letter-spacing: -0.02em; }
h2 { font-size: 1.15rem; margin: 32px 0 10px; letter-spacing: -0.01em; }
h3 { font-size: 0.95rem; margin: 18px 0 8px; letter-spacing: 0.02em; text-transform: uppercase; color: var(--muted); }
p { margin: 0 0 12px; }
a { color: var(--accent); }
.lede { color: var(--muted); max-width: 62ch; }
code, pre { font-family: var(--mono); }

.topbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; justify-content: space-between; }
.theme-toggle {
  font: inherit; font-size: 0.8rem; padding: 5px 11px; border-radius: 999px; cursor: pointer;
  background: var(--panel); color: var(--ink); border: 1px solid var(--line);
}

.stats { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin: 22px 0 8px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; min-width: 0; }
.stat b { display: block; font-size: 1.5rem; line-height: 1.2; font-variant-numeric: tabular-nums; }
.stat span { font-size: 0.78rem; color: var(--muted); }

.pipeline { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); margin: 12px 0 4px; }
.step { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; min-width: 0; }
.step b { display: block; font-size: 0.82rem; letter-spacing: 0.03em; text-transform: uppercase; color: var(--accent); }
.step span { font-size: 0.85rem; color: var(--muted); }

nav.scenarios { display: flex; flex-wrap: wrap; gap: 7px; margin: 10px 0 18px; }
nav.scenarios button {
  font: inherit; font-size: 0.83rem; padding: 6px 11px; border-radius: 8px; cursor: pointer;
  background: var(--panel); color: var(--ink); border: 1px solid var(--line); min-width: 0;
}
nav.scenarios button[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 600; }

.variants { display: inline-flex; gap: 0; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-bottom: 14px; }
.variants button { font: inherit; font-size: 0.82rem; padding: 6px 14px; cursor: pointer; background: var(--panel); color: var(--ink); border: 0; }
.variants button[aria-pressed="true"] { background: var(--accent); color: var(--bg); font-weight: 600; }

.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; }
.card.verdict-bad { border-left: 4px solid var(--accent); }
.card.verdict-good { border-left: 4px solid var(--server); }
.verdict { font-size: 1.05rem; font-weight: 650; margin: 0 0 6px; }
.pill { display: inline-block; font-size: 0.72rem; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel-2); color: var(--muted); margin-left: 6px; vertical-align: 2px; }
.site { font-family: var(--mono); font-size: 0.85rem; background: var(--warn-soft); color: var(--warn); border-radius: 6px; padding: 2px 7px; display: inline-block; }
ul.evidence { margin: 8px 0 0; padding-left: 18px; }
ul.evidence li { font-size: 0.9rem; color: var(--muted); overflow-wrap: anywhere; }

.stage { margin: 0 0 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); overflow: hidden; }
.stage > header { padding: 10px 14px; background: var(--panel-2); border-bottom: 1px solid var(--line); font-size: 0.85rem; }
.stage > header b { font-size: 0.92rem; }
.stage > header em { font-style: normal; color: var(--muted); }
.stage .empty { padding: 12px 14px; color: var(--muted); font-size: 0.88rem; }

.rows { display: block; }
.row { border-top: 1px solid var(--line); padding: 10px 14px; }
.row:first-child { border-top: 0; }
.row .what { font-size: 0.8rem; color: var(--muted); margin-bottom: 6px; overflow-wrap: anywhere; }
.row .what b { color: var(--ink); }
.sides { display: grid; gap: 8px; grid-template-columns: 1fr; }
@media (min-width: 720px) { .sides { grid-template-columns: 1fr 1fr; } }
.side { border-radius: 8px; padding: 8px 10px; min-width: 0; }
.side.left { background: var(--server-soft); }
.side.right { background: var(--client-soft); }
.side .tag { display: block; font-size: 0.7rem; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 4px; }
.side.left .tag { color: var(--server); }
.side.right .tag { color: var(--client); }
.side pre { margin: 0; font-size: 0.82rem; overflow-x: auto; white-space: pre; }
.row.outside { opacity: 0.72; }
.row .scopetag { font-size: 0.7rem; border: 1px dashed var(--line); border-radius: 999px; padding: 1px 7px; margin-left: 6px; color: var(--muted); }

details.raw { margin: 0 0 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
details.raw > summary { cursor: pointer; padding: 10px 14px; font-size: 0.85rem; }
details.raw pre { margin: 0; padding: 0 14px 14px; font-size: 0.78rem; overflow-x: auto; white-space: pre; }

.react { font-size: 0.88rem; }
.react pre { margin: 6px 0 0; font-size: 0.8rem; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; }

footer { margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.82rem; }
table.matrix { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
.scroller { overflow-x: auto; }
table.matrix th, table.matrix td { border-bottom: 1px solid var(--line); padding: 7px 10px; text-align: left; white-space: nowrap; }
table.matrix th { color: var(--muted); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em; }
td.yes { color: var(--accent); font-weight: 600; }
td.no { color: var(--server); }
`;

const SCRIPT = String.raw`
(function () {
  var DATA = JSON.parse(document.getElementById('capture-data').textContent);
  var nav = document.getElementById('scenario-nav');
  var detail = document.getElementById('detail');
  var ids = [];
  DATA.runs.forEach(function (r) { if (ids.indexOf(r.id) === -1) ids.push(r.id); });
  var current = ids[0];
  var currentVariant = 'broken';

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function runFor(id, variant) {
    var exact = DATA.runs.filter(function (r) { return r.id === id && r.variant === variant; })[0];
    if (exact) return exact;
    return DATA.runs.filter(function (r) { return r.id === id; })[0];
  }

  function variantsFor(id) {
    return DATA.runs.filter(function (r) { return r.id === id; }).map(function (r) { return r.variant; });
  }

  function opRow(op, stage) {
    var row = el('div', 'row' + (op.scope === 'outside-root' ? ' outside' : ''));
    var what = el('div', 'what');
    var label = {
      'text-changed': 'text differs',
      'attr-changed': 'attribute ' + op.attr + ' differs',
      'attr-only-left': 'attribute ' + op.attr + ' only on the left',
      'attr-only-right': 'attribute ' + op.attr + ' only on the right',
      'node-only-left': 'node present only on the left',
      'node-only-right': 'node present only on the right',
      'tag-changed': 'element name differs',
      'comment-changed': 'comment differs'
    }[op.kind] || op.kind;
    what.appendChild(el('b', null, label));
    what.appendChild(document.createTextNode(' at ' + (op.path || '(root)')));
    if (op.scope === 'outside-root') {
      what.appendChild(el('span', 'scopetag', 'outside the hydration root, React does not compare it'));
    }
    row.appendChild(what);

    var sides = el('div', 'sides');
    [['left', stage.leftLabel, op.left], ['right', stage.rightLabel, op.right]].forEach(function (pair) {
      var side = el('div', 'side ' + pair[0]);
      side.appendChild(el('span', 'tag', pair[1]));
      var pre = el('pre', null, pair[2] === null || pair[2] === undefined ? '(absent)' : String(pair[2]));
      side.appendChild(pre);
      sides.appendChild(side);
    });
    row.appendChild(sides);
    return row;
  }

  function render() {
    nav.innerHTML = '';
    ids.forEach(function (id) {
      var b = el('button', null, id);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(id === current));
      b.addEventListener('click', function () {
        current = id;
        if (variantsFor(id).indexOf(currentVariant) === -1) currentVariant = variantsFor(id)[0];
        render();
      });
      nav.appendChild(b);
    });

    var run = runFor(current, currentVariant);
    detail.innerHTML = '';
    if (!run) return;

    var head = el('div');
    head.appendChild(el('h2', null, run.title));
    head.appendChild(el('p', 'lede', run.summary));
    detail.appendChild(head);

    var picker = el('div', 'variants');
    variantsFor(current).forEach(function (v) {
      var b = el('button', null, v);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(v === run.variant));
      b.addEventListener('click', function () { currentVariant = v; render(); });
      picker.appendChild(b);
    });
    detail.appendChild(picker);

    var bad = run.counts.hydration > 0;
    var verdict = el('div', 'card ' + (bad ? 'verdict-bad' : 'verdict-good'));
    var line = el('p', 'verdict', bad
      ? run.counts.hydration + ' hydration mismatch' + (run.counts.hydration === 1 ? '' : 'es')
      : 'No hydration mismatch');
    verdict.appendChild(line);
    if (run.firstDivergence) {
      verdict.appendChild(el('p', null, 'First divergence: ' + (run.firstDivergence.path || '(root)')));
    }
    if (run.causes.length === 0) {
      verdict.appendChild(el('p', null, bad
        ? 'No known cause matched.'
        : 'Server and client agree on every node, attribute, and text run.'));
    }
    run.causes.forEach(function (c) {
      var h = el('p');
      h.appendChild(el('strong', null, DATA.causeTitles[c.id] || c.id));
      h.appendChild(el('span', 'pill', c.confidence));
      verdict.appendChild(h);
      if (c.file) {
        var site = el('p');
        site.appendChild(el('span', 'site', c.file + ':' + c.line + (c.api ? '  ' + c.api : '')));
        verdict.appendChild(site);
      }
      var ul = el('ul', 'evidence');
      c.evidence.forEach(function (e) { ul.appendChild(el('li', null, e)); });
      ul.appendChild(el('li', null, 'Fix: ' + (DATA.causeFixes[c.id] || run.fix)));
      verdict.appendChild(ul);
    });
    detail.appendChild(verdict);

    run.stages.forEach(function (stage) {
      var box = el('div', 'stage');
      var header = el('header');
      header.appendChild(el('b', null, stage.label));
      header.appendChild(document.createTextNode(' '));
      header.appendChild(el('em', null, stage.leftLabel + '  →  ' + stage.rightLabel));
      box.appendChild(header);
      var shown = stage.ops.filter(function (op) {
        return stage.key === 'mutation' ? true : op.scope === 'in-root';
      });
      if (shown.length === 0) {
        box.appendChild(el('div', 'empty', 'No difference at this stage.'));
      } else {
        var rows = el('div', 'rows');
        shown.forEach(function (op) { rows.appendChild(opRow(op, stage)); });
        box.appendChild(rows);
      }
      detail.appendChild(box);
    });

    var reactCard = el('div', 'card react');
    reactCard.appendChild(el('h3', null, 'What React itself reported'));
    if (run.react.recoverable.length === 0 && run.react.consoleErrors.length === 0) {
      reactCard.appendChild(el('p', null, 'Nothing.'));
    } else {
      run.react.recoverable.forEach(function (r) {
        reactCard.appendChild(el('p', null, r.message));
        if (r.componentStack) reactCard.appendChild(el('pre', null, r.componentStack));
      });
      run.react.consoleErrors.forEach(function (m) {
        reactCard.appendChild(el('pre', null, m));
      });
    }
    detail.appendChild(reactCard);

    [['serverEmitted', 'HTML React emitted on the server'],
     ['parsedBody', 'DOM the browser built from it'],
     ['preHydrationBody', 'DOM at the moment hydration started'],
     ['clientRender', 'What the client render produced']].forEach(function (pair) {
      var d = el('details', 'raw');
      d.appendChild(el('summary', null, pair[1]));
      d.appendChild(el('pre', null, run.html[pair[0]]));
      detail.appendChild(d);
    });
  }

  var toggle = document.getElementById('theme-toggle');
  toggle.addEventListener('click', function () {
    var now = document.documentElement.getAttribute('data-theme');
    var next = now === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    toggle.textContent = next === 'dark' ? 'Light theme' : 'Dark theme';
  });

  render();
  document.documentElement.setAttribute('data-script', 'ran');
})();
`;

const matrixRows = payload.runs.map((r) => `<tr>
      <td><code>${esc(r.id)}</code></td>
      <td>${esc(r.variant)}</td>
      <td class="${r.counts.hydration > 0 ? 'yes' : 'no'}">${r.counts.hydration}</td>
      <td>${r.counts.repair}</td>
      <td>${r.counts.mutationAnywhere}</td>
      <td>${esc(r.causes.map((c) => c.id).join(', ') || 'none')}</td>
      <td class="${r.react.recoverable.length > 0 ? 'yes' : 'no'}">${r.react.recoverable.length > 0 ? 'yes' : 'no'}</td>
    </tr>`).join('\n    ');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hydration-diff</title>
<meta name="description" content="Capture the server HTML and the client render of a React tree, diff them node by node, and name the cause of the hydration mismatch.">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <h1>hydration-diff</h1>
    <button id="theme-toggle" class="theme-toggle" type="button">Dark theme</button>
  </div>
  <p class="lede">
    React tells you that hydration failed. It does not tell you which line caused it, and for two
    of the eight causes below it does not describe the divergence accurately either. This captures
    the HTML the server sent, the DOM the browser built from it, the DOM at the instant hydration
    began, and what the client render actually produced, then diffs the four node by node.
  </p>

  <div class="stats">
    <div class="stat"><b>${causeCount}</b><span>causes reproduced, each with a fixed counterpart</span></div>
    <div class="stat"><b>${payload.runCount}</b><span>live runs recorded</span></div>
    <div class="stat"><b>${brokenRuns}</b><span>runs with a real mismatch</span></div>
    <div class="stat"><b>${cleanRuns}</b><span>runs that must report nothing</span></div>
    <div class="stat"><b>${payload.checks.pass}</b><span>assertions against those runs</span></div>
  </div>

  <h2>Four trees, not two</h2>
  <p class="lede">
    A hydration bug is usually described as the server and the client disagreeing. That is one
    diff out of three, and it is not always the one that holds the cause.
  </p>
  <div class="pipeline">
    <div class="step"><b>1 emitted</b><span>The HTML string React wrote on the server.</span></div>
    <div class="step"><b>2 parsed</b><span>What the browser's parser built from that string. Different documents, if the markup is invalid.</span></div>
    <div class="step"><b>3 at hydration</b><span>The DOM after anything else touched it: an extension, a third-party snippet.</span></div>
    <div class="step"><b>4 client render</b><span>The tree React builds on the client. The mismatch is 3 against 4.</span></div>
  </div>

  <h2>Every run</h2>
  <div class="scroller">
  <table class="matrix">
    <thead><tr><th>Scenario</th><th>Variant</th><th>Mismatches</th><th>Parser repairs</th><th>Pre-hydration edits</th><th>Cause named</th><th>React complained</th></tr></thead>
    <tbody>
    ${matrixRows}
    </tbody>
  </table>
  </div>

  <h2>Explore a run</h2>
  <nav class="scenarios" id="scenario-nav"></nav>
  <div id="detail"></div>

  <footer>
    Recorded on Node ${esc(payload.node)} with React ${esc(payload.react)}. Every number on this
    page came from a live render, a live hydration, and a live diff; nothing here is a fixture.
  </footer>
</div>
<script id="capture-data" type="application/json">${
  JSON.stringify(payload).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`)
}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;

mkdirSync(join(root, 'docs'), { recursive: true });
writeFileSync(join(root, 'docs', 'index.html'), html);
console.log(`  wrote docs/index.html (${(html.length / 1024).toFixed(1)} KB, ${payload.runs.length} runs)`);
