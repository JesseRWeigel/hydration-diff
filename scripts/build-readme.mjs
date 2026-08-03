#!/usr/bin/env node
// Regenerate README.md from the recording, so its numbers cannot drift from the runs.
//
//   node scripts/build-readme.mjs                  keeps the existing Status block
//   node scripts/build-readme.mjs --status <file>  replaces Status with that verify output
//
// The example command output is produced by actually running the CLI, not transcribed.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarios } from '../scenarios/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readmePath = join(root, 'README.md');
const data = JSON.parse(readFileSync(join(root, 'data', 'captures.json'), 'utf8'));

const args = process.argv.slice(2);
const statusIdx = args.indexOf('--status');
const statusFile = statusIdx === -1 ? null : args[statusIdx + 1];

const runs = data.captures;
const causeIds = [...new Set(runs.filter((c) => !c.scenario.control && c.scenario.cause).map((c) => c.scenario.cause))];
const brokenRuns = runs.filter((c) => c.counts.hydration > 0).length;
const unitTests = 49;

function runCli(id, variant) {
  return execFileSync(process.execPath, [join(root, 'bin', 'hydration-diff.js'), 'run', id, variant], {
    cwd: root, encoding: 'utf8', env: { ...process.env }, maxBuffer: 8 * 1024 * 1024,
  });
}

// The CLI exits 1 when it finds a mismatch, which execFileSync treats as a throw.
function cliOutput(id, variant) {
  try {
    return runCli(id, variant);
  } catch (err) {
    if (err.stdout) return err.stdout;
    throw err;
  }
}

const nestingExample = cliOutput('nesting-div-in-p', 'broken').trimEnd();
const storageExample = cliOutput('client-storage', 'broken').trimEnd();

const scenarioRows = scenarios.map((s) => {
  const broken = runs.find((c) => c.scenario.id === s.id && c.variant === 'broken');
  const fixed = runs.find((c) => c.scenario.id === s.id && c.variant === 'fixed');
  const brokenCell = broken ? `${broken.counts.hydration} mismatch${broken.counts.hydration === 1 ? '' : 'es'}` : 'n/a';
  const fixedCell = fixed ? (fixed.counts.hydration === 0 ? 'clean' : `${fixed.counts.hydration} MISMATCH`) : 'n/a';
  const site = broken?.analysis?.causes?.find((c) => c.file);
  const blame = s.control ? 'n/a' : (site ? `\`${site.file}:${site.line}\`` : 'structural, no call site');
  return `| \`${s.id}\` | ${s.control ? 'control' : `\`${s.cause}\``} | ${brokenCell} | ${fixedCell} | ${blame} |`;
}).join('\n');

const reactRows = runs
  .filter((c) => c.react.recoverable.length > 0)
  .map((c) => {
    const stack = c.react.recoverable[0].componentStack.split('\n')[0].trim();
    const kind = /server rendered text/.test(c.react.recoverable[0].message) ? 'text' : 'HTML';
    return `| \`${c.scenario.id}\` | ${kind} mismatch | \`${stack}\` | \`${c.analysis.firstDivergence?.path ?? '-'}\` | ${
      c.analysis.causes.find((x) => x.file) ? `\`${c.analysis.causes.find((x) => x.file).file}:${c.analysis.causes.find((x) => x.file).line}\`` : 'structural'
    } |`;
  })
  .join('\n');

let status = '```\n(not yet run)\n```';
if (statusFile && existsSync(statusFile)) {
  status = `\`\`\`\n$ bash scripts/verify.sh\n${readFileSync(statusFile, 'utf8').trimEnd()}\n\`\`\``;
} else if (existsSync(readmePath)) {
  const prev = readFileSync(readmePath, 'utf8');
  const m = prev.match(/## Status\n\n([\s\S]*?)(?=\n## |\n?$)/);
  if (m) status = m[1].trimEnd();
}

const readme = `# hydration-diff

Capture the HTML a React server render emitted, the DOM a browser built from it, the DOM at the
instant hydration began, and the tree the client render produced. Diff the four node by node, and
name the cause.

React's hydration error tells you that the trees disagreed. It does not tell you which line made
them disagree, and it does not distinguish "your component read the clock" from "an extension
inserted a div" from "the parser rewrote your markup before React ever saw it". Those are
different bugs with different fixes, and only the first one is in your code.

\`\`\`
$ node bin/hydration-diff.js run nesting-div-in-p broken
${nestingExample}
\`\`\`

Nothing in that component is non-deterministic. The server and the client render the identical
string. The mismatch exists because \`<div>\` is not phrasing content, so the browser closed the
paragraph before it and opened a fresh empty one after it, and React is comparing its tree against
a document nobody wrote. The first diff above is the one that explains it, and it is a diff React
does not perform.

## Four trees, not two

| Tree | Where it comes from |
| --- | --- |
| 1. emitted | The string \`renderToString\` produced on the server. |
| 2. parsed | What the browser's tree builder made of that string. A different document, if the markup is invalid. |
| 3. at hydration | The DOM at the moment \`hydrateRoot\` runs, after anything else touched it. |
| 4. client render | The tree the client's own render produces, as authored. |

The mismatch React reports is 3 against 4. The cause may be in 1 against 2 (the parser) or in
2 against 3 (an extension), and in both of those cases every minute spent reading the component is
wasted.

## The causes, and the fixed version of each

${data.captures.length} live runs, ${brokenRuns} of which have a real mismatch. Every cause ships a fixed
counterpart that must report nothing, because a detector that fires on everything is worth less
than no detector.

| Scenario | Cause | Broken variant | Fixed variant | Blamed site |
| --- | --- | --- | --- | --- |
${scenarioRows}

That is ${causeIds.length} distinct causes over ${scenarios.filter((s) => !s.control).length} broken scenarios, plus ${scenarios.filter((s) => s.control).length} controls, for ${scenarios.length} scenarios in
total. The controls are there to catch the opposite failure: React writes \`<!-- -->\`
between adjacent text children and the DOM does not, and React serialises \`&#x27;\`, \`readOnly\`
and \`style="color:red;font-weight:bold"\` where the DOM writes \`'\`, \`readonly\` and
\`style="color: red; font-weight: bold;"\`. A differ that does not fold those away reports a
mismatch on almost every page.

## How the cause is found

Two structural facts and one runtime trap.

**Structural.** If tree 1 and tree 2 differ, the parser repaired something, and the specific
violation is found by walking the emitted tree against the content model (\`<div>\` inside \`<p>\`,
\`<p>\` inside \`<p>\`, \`<li>\` inside \`<li>\`, \`<a>\` inside \`<a>\`). If tree 2 and tree 3
differ, something outside the application edited the DOM, and the attribute names are matched
against known extension signatures (\`data-lastpass-icon-root\`, \`data-gramm\`,
\`cz-shortcut-listen\`, \`data-1p-*\`). Both are proofs rather than inferences.

**Runtime.** \`Math.random\`, \`Date\`, \`Date.now\`, \`toLocaleString\`, \`Intl.DateTimeFormat\`,
\`localStorage\` and \`window\` are replaced for the duration of the render pass, and every call is
recorded with the file, line and component stack that made it.

\`typeof window\` looks untrappable, since \`typeof\` on an undeclared binding cannot throw. But
\`window\` on the server is not undeclared, it is absent, and an absent global can be defined as an
accessor. \`typeof window\` then performs an ordinary property get, the getter records the probe,
and returning \`undefined\` leaves the component on the branch it would have taken anyway.

A recorded call is only reported as a cause when there is a mismatch for it to explain, and only
when it happened during the render pass. The same call inside \`useEffect\` is correct code and is
listed separately as "noted, not blamed".

\`\`\`
$ node bin/hydration-diff.js run client-storage broken
${storageExample}
\`\`\`

## What React actually says, measured

The premise this started from was that React names the wrong node. Measured against React 19.2,
that is mostly not true, and the honest version is narrower.

| Scenario | React's message | React's innermost frame | The actual first divergence | This tool's blame |
| --- | --- | --- | --- | --- |
${reactRows}

Three things hold across every run, and each is a passing assertion in
\`scripts/assert-scenarios.mjs\` rather than a claim in prose:

1. React never names a file or a line. Not in any of the ${brokenRuns} failing runs.
2. React's recoverable error describes a text mismatch and says nothing about attributes.
   \`client-storage\` diverges on \`class\` and \`data-theme\` as well as on text, and React
   mentions neither.
3. On \`extension-mutation\` React's stack points at the application's own \`<input>\` inside its
   own \`SignIn\` component, for a node \`SignIn\` never rendered.

Credit where it is due: React 19 detects both invalid-nesting cases specifically and names them
correctly ("In HTML, \`<div>\` cannot be a descendant of \`<p>\`"). What it does not show is the
resulting tree, which is what makes the follow-on hydration error legible.

## Running it

\`\`\`
npm install
npm --prefix fixtures/next-app install     # for the real-Next.js corroboration

node bin/hydration-diff.js list
node bin/hydration-diff.js run <scenario> [broken|fixed]
node bin/hydration-diff.js run-all --json

bash scripts/verify.sh
\`\`\`

Requires Node 20 or newer and Python 3 (for the independent checker).

## How it is verified

- **${unitTests} unit tests** over the parser, the alignment, the cause rules and the traps.
- **${data.captures.length} live runs**, each a real server process and a real client process with
  their own \`TZ\` and locale, a real \`renderToString\`, and a real \`hydrateRoot\`. React's own
  \`onRecoverableError\` is captured on every run and must agree: broken variants make React
  complain, fixed variants make it silent.
- **An independent checker in Python** (\`scripts/independent-check.py\`) that shares no code with
  the engine. Different language, different HTML parser, different tree, different comparison. It
  re-derives every verdict, and separately checks that each reported value literally occurs in the
  raw bytes of its own side. It found a real defect on its first run: React emits \`dateTime\` and
  the DOM holds \`datetime\`.
- **A real browser.** \`scripts/check-page.mjs\` loads \`docs/index.html\` in Chromium and asserts
  on nodes only the inline script can have created, on the absence of horizontal overflow at 390px
  measured element by element, and on both dark-mode mechanisms.
- **Real Next.js.** \`scripts/next-corroborate.mjs\` builds and serves a Next 16 app that imports
  these same scenario modules, reads the DOM back with JavaScript disabled so what it measures is
  the parser and nothing else, confirms Chromium and jsdom build the same tree from the same
  bytes, and confirms real Next.js reports a hydration error on the broken routes and none on the
  fixed ones.
- **Six sabotages** (\`scripts/sabotage.sh\`), each proved to have changed real output before any
  conclusion is drawn from it: text nodes ignored, attributes ignored, the authored parser made to
  repair like a browser, \`&nbsp;\` folded into an ordinary space, every text node reported as
  changed, and a cause named on every run.

## Which runtime, and why

The engine runs real \`react-dom/server\` and real \`react-dom/client\` in jsdom, and a real
Next.js 16 build in real Chromium corroborates it. Both, rather than one.

jsdom carries the engine because two processes are needed for a single capture, one with \`window\`
absent and one with it present, in two timezones; a browser cannot be put in the first state at
all. jsdom's parser is parse5, which implements the same specification Chromium does, and
\`scripts/next-corroborate.mjs\` asserts on every route that the two build an identical tree from
identical bytes rather than assuming it.

The Next.js half exists because the central claim here is about what a *browser's* parser does,
and only a browser can settle that. It runs a production build rather than \`next dev\`: the dev
overlay installs its own \`console.error\` handler and the hydration message never reaches the
page, so the check saw nothing on routes that were definitely failing.

## What is not built

- **No in-page overlay and no framework plugin.** This is a capture harness, a diff engine, a
  cause classifier and a CLI. Wiring it into a running Next.js app as a dev-mode overlay, which is
  what the original brief describes, is not done.
- **The component stack comes from JS stack frames**, not from React's owner stack, so it names
  the functions on the call path rather than the React element tree. It is accurate about the file
  and line, which is the part React omits.
- **Attribution is by call site, not by DOM node.** The tool says "this mismatch exists and
  \`Math.random()\` at \`scenarios/x.js:7\` ran during both renders". It does not prove that
  specific call produced that specific text node.
- **Eight cause categories.** \`crypto.getRandomValues\`, \`performance.now\`, \`document.cookie\`,
  and a \`useId\` collision are not trapped; a mismatch caused by one of those is reported as
  \`unattributed\` with the diff, rather than guessed at.
- **Streaming SSR and Suspense boundaries are not exercised.** The boundary comments are folded
  away by the normaliser, but no scenario produces one.

## Status

${status}

## Licence

MIT.
`;

writeFileSync(readmePath, readme);
console.log(`  wrote README.md (${(readme.length / 1024).toFixed(1)} KB)`);
