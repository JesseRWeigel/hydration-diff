#!/usr/bin/env node
// Run every scenario for real and assert the diff it produces, then record the run.
//
// Nothing here is a fixture. Each check spawns a server process and a client process, renders
// with React, hydrates with React, and asserts on what came back. The recording written to
// data/captures.json is a by-product of the run that was just asserted, so the page built from it
// cannot show numbers that were never measured.
//
// Two assertions matter more than the rest and are applied to every scenario:
//   - a broken variant must make React itself complain, so the mismatch is not this tool's
//     invention;
//   - a fixed variant must make React silent, so the detector is not simply reporting everything.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarios } from '../scenarios/index.js';
import { captureScenario } from '../src/capture.js';
import { mismatches } from '../src/diff.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  ok    ${m}`); pass += 1; };
const bad = (m) => { console.log(`  FAIL  ${m}`); fail += 1; };

const captures = [];

for (const scenario of scenarios) {
  for (const variant of Object.keys(scenario.variants)) {
    const label = `${scenario.id}/${variant}`;
    let capture;
    try {
      capture = await captureScenario(scenario, variant);
    } catch (err) {
      bad(`${label}: the capture threw: ${err.message}`);
      continue;
    }
    captures.push(capture);

    const expect = scenario.expect?.[variant];
    if (!expect) {
      bad(`${label}: no expectation declared, so nothing was asserted`);
      continue;
    }

    const hydrationOps = mismatches(capture.diffs.hydration);
    const n = hydrationOps.length;

    if (expect.minMismatches === 0) {
      if (n === 0) ok(`${label}: no mismatch, as expected`);
      else {
        bad(`${label}: expected no mismatch, found ${n}`);
        for (const op of hydrationOps.slice(0, 4)) {
          console.log(`        ${op.kind} at ${op.path}: ${JSON.stringify(op.left)?.slice(0, 60)} vs ${JSON.stringify(op.right)?.slice(0, 60)}`);
        }
      }
    } else if (n >= expect.minMismatches) {
      ok(`${label}: ${n} mismatch(es), expected at least ${expect.minMismatches}`);
    } else {
      bad(`${label}: expected at least ${expect.minMismatches} mismatch(es), found ${n}`);
    }

    if (expect.kinds) {
      const seen = new Set(hydrationOps.map((op) => op.kind));
      const missing = expect.kinds.filter((k) => !seen.has(k));
      if (missing.length === 0) ok(`${label}: produced ${expect.kinds.join(' and ')}`);
      else bad(`${label}: expected op kinds ${missing.join(', ')}, saw ${[...seen].join(', ') || 'none'}`);
    }

    if (expect.cause) {
      const ids = capture.analysis.causes.map((c) => c.id);
      if (ids.includes(expect.cause)) ok(`${label}: named the cause ${expect.cause}`);
      else bad(`${label}: expected cause ${expect.cause}, got ${ids.join(', ') || 'none'}`);
    } else if (expect.minMismatches === 0) {
      if (capture.analysis.causes.length === 0) ok(`${label}: named no cause`);
      else bad(`${label}: named ${capture.analysis.causes.map((c) => c.id).join(', ')} on a clean run`);
    }

    if (expect.api) {
      const apis = capture.analysis.causes.map((c) => c.api).filter(Boolean);
      if (apis.includes(expect.api)) {
        const site = capture.analysis.causes.find((c) => c.api === expect.api);
        ok(`${label}: blamed ${expect.api} at ${site.file}:${site.line}`);
      } else {
        bad(`${label}: expected ${expect.api} to be blamed, saw ${apis.join(', ') || 'none'}`);
      }
    }

    if (expect.repair === true) {
      if (capture.counts.repair > 0) {
        ok(`${label}: the parser restructured the markup (${capture.counts.repair} change(s))`);
      } else {
        bad(`${label}: expected the parser to restructure the markup, it did not`);
      }
      // The repair claim rests on the two strings being different documents. Say so directly.
      const emitted = `<div id="root">${capture.html.serverEmitted}</div>`;
      if (!capture.html.parsedBody.includes(emitted)) {
        ok(`${label}: the DOM is not the string React emitted`);
      } else {
        bad(`${label}: the DOM contains the emitted string verbatim, so nothing was repaired`);
      }
    } else if (expect.repair === false) {
      if (capture.counts.repair === 0) ok(`${label}: the parser kept the markup as written`);
      else bad(`${label}: unexpected parser repair (${capture.counts.repair} change(s))`);
    }

    // A "fixed" variant that simply deleted the feature would also report no mismatch, and would
    // not be a fix. So where the fix is "do it after mount", the DOM has to actually change once
    // effects have run. This is the assertion that separates repairing the bug from removing it.
    if (expect.settledChange === true) {
      if (capture.counts.settled > 0) {
        ok(`${label}: the DOM still changes after effects run (${capture.counts.settled} change(s)), so the behaviour was moved and not deleted`);
      } else {
        bad(`${label}: nothing changed after hydration, so the fix may have removed the feature rather than deferred it`);
      }
    }

    if (expect.mutation === true) {
      if (capture.counts.mutationAnywhere > 0) {
        ok(`${label}: the DOM changed between parse and hydrate (${capture.counts.mutationAnywhere} change(s))`);
      } else {
        bad(`${label}: expected a pre-hydration DOM mutation, saw none`);
      }
    }

    // React's own verdict, as the independent witness.
    const reactComplained = capture.react.recoverable.length > 0;
    if (expect.minMismatches > 0) {
      if (reactComplained) ok(`${label}: React itself reported a hydration error`);
      else bad(`${label}: this tool reports a mismatch and React does not, so one of them is wrong`);
    } else if (!reactComplained) {
      ok(`${label}: React itself reported nothing`);
    } else {
      bad(`${label}: React reported ${capture.react.recoverable.length} error(s) on a run this tool called clean`);
      for (const e of capture.react.recoverable) console.log(`        ${e.message.slice(0, 160)}`);
    }
  }
}

// What React itself reports, measured rather than assumed.
//
// The premise this project started from was that React names the wrong node. Measured against
// React 19.2, that is mostly not true: the component stack usually lands on the right element or
// its parent. Three things are true instead, and each is asserted here so the README cannot drift
// back to the more flattering story.
const brokenRuns = captures.filter((c) => c.react.recoverable.length > 0);

// 1. React never names a file, a line, or the API that caused it. Not once, in any scenario.
{
  const withLocation = brokenRuns.filter((c) => c.react.recoverable.some(
    (r) => /\.(js|jsx|ts|tsx):\d+/.test(`${r.message}\n${r.componentStack}`),
  ));
  if (withLocation.length === 0) {
    ok(`React named no source location in any of ${brokenRuns.length} failing runs; this tool named one in every attributed run`);
  } else {
    bad(`React named a source location in ${withLocation.map((c) => c.scenario.id).join(', ')}, so that claim is wrong`);
  }
}

// 2. React's recoverable error reports a text mismatch and stays silent about attributes. The
//    storage scenario diverges on class and data-theme as well as on text, and React mentions
//    neither.
{
  const storage = captures.find((c) => c.scenario.id === 'client-storage' && c.variant === 'broken');
  const attrOps = mismatches(storage.diffs.hydration).filter((op) => op.kind === 'attr-changed');
  const saidAttr = storage.react.recoverable.some((r) => /attribut/i.test(r.message));
  if (attrOps.length >= 2 && !saidAttr) {
    ok(`client-storage/broken: ${attrOps.length} attribute mismatches (${attrOps.map((o) => o.attr).join(', ')}) that React's message never mentions`);
  } else {
    bad(`client-storage/broken: expected unreported attribute mismatches, found ${attrOps.length} and React said attribute=${saidAttr}`);
  }
}

// 3. Where React does point somewhere misleading: the extension scenario. The offending node was
//    inserted by something outside the application, and React's stack names the application's own
//    <input> inside its own SignIn component.
{
  const ext = captures.find((c) => c.scenario.id === 'extension-mutation' && c.variant === 'broken');
  const stack = ext.react.recoverable[0]?.componentStack ?? '';
  const innermost = stack.split('\n')[0].trim();
  const offender = mismatches(ext.diffs.hydration)[0];
  const offenderInClientRender = ext.html.clientRender.includes('data-lastpass-icon-root');
  if (!offenderInClientRender && /SignIn/.test(stack)) {
    ok(`extension-mutation/broken: React's stack is "${innermost}" inside SignIn, for a node SignIn never rendered (${(offender.left ?? '').slice(0, 40)}...)`);
  } else {
    bad('extension-mutation/broken: expected React to blame the application for a node it did not render');
  }
}

// 4. Credit where it is due. React 19 detects the two nesting cases specifically and says so
//    clearly. This tool's contribution there is the resulting tree, not the detection.
for (const id of ['nesting-div-in-p', 'nesting-p-in-p']) {
  const run = captures.find((c) => c.scenario.id === id && c.variant === 'broken');
  const warned = run.react.consoleErrors.some((m) => /cannot be a descendant/.test(m));
  if (warned) ok(`${id}/broken: React 19 already warns about this nesting, and names it correctly`);
  else bad(`${id}/broken: expected React's nesting warning, saw none`);
}

mkdirSync(join(root, 'data'), { recursive: true });
writeFileSync(
  join(root, 'data', 'captures.json'),
  `${JSON.stringify({
    generatedBy: 'scripts/assert-scenarios.mjs',
    node: process.version,
    react: JSON.parse(
      // eslint-disable-next-line no-undef
      await (await import('node:fs')).promises.readFile(join(root, 'node_modules', 'react', 'package.json'), 'utf8'),
    ).version,
    scenarioCount: scenarios.length,
    runCount: captures.length,
    checks: { pass, fail },
    captures,
  }, null, 2)}\n`,
);

console.log(`  ${pass} passed, ${fail} failed across ${captures.length} live runs`);
process.exit(fail === 0 ? 0 : 1);
