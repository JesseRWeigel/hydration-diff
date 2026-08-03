#!/usr/bin/env node
import { scenarios, getScenario } from '../scenarios/index.js';
import { captureScenario } from '../src/capture.js';
import { reportText } from '../src/report.js';

const [command, ...rest] = process.argv.slice(2);

function usage() {
  console.log('hydration-diff  capture a server render and a client render, diff them, name the cause');
  console.log('');
  console.log('  hydration-diff list');
  console.log('  hydration-diff run <scenarioId> [variant]     default variant: broken, else fixed');
  console.log('  hydration-diff run-all [--json]');
  console.log('');
  console.log('Exit code is 1 when a run has a mismatch, so it can gate a check.');
}

if (command === 'list' || command === undefined) {
  if (command === undefined) usage();
  console.log('');
  for (const s of scenarios) {
    const variants = Object.keys(s.variants).join(', ');
    console.log(`  ${s.id.padEnd(24)} ${s.control ? '(control)' : s.cause}`);
    console.log(`  ${''.padEnd(24)} ${s.title}`);
    console.log(`  ${''.padEnd(24)} variants: ${variants}`);
  }
  process.exit(0);
}

if (command === 'run') {
  const [id, variantArg] = rest;
  if (!id) { usage(); process.exit(2); }
  const scenario = getScenario(id);
  const variant = variantArg ?? (scenario.variants.broken ? 'broken' : 'fixed');
  const capture = await captureScenario(scenario, variant);
  console.log(reportText(capture));
  process.exit(capture.counts.hydration > 0 ? 1 : 0);
}

if (command === 'run-all') {
  const asJson = rest.includes('--json');
  const results = [];
  for (const scenario of scenarios) {
    for (const variant of Object.keys(scenario.variants)) {
      results.push(await captureScenario(scenario, variant));
    }
  }
  if (asJson) {
    console.log(JSON.stringify({ generated: 'run-all', results }, null, 2));
  } else {
    for (const capture of results) {
      console.log(reportText(capture));
      console.log('');
      console.log('-'.repeat(78));
      console.log('');
    }
  }
  const withMismatch = results.filter((r) => r.counts.hydration > 0).length;
  console.error(`${results.length} runs, ${withMismatch} with a hydration mismatch`);
  process.exit(0);
}

usage();
process.exit(2);
