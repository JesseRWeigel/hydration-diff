#!/usr/bin/env node
// The server half of a capture. Runs in its own process, with its own TZ and locale, and with no
// window, no document, and no storage, which is the only way the `typeof window` and
// `localStorage` scenarios can be real rather than simulated.
//
// Usage: node runner/render-server.mjs <scenarioId> <variant>
// Writes one JSON object to stdout.

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecorder, installTraps } from '../src/instrument.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const scenarioRoot = join(repoRoot, 'scenarios');

const [scenarioId, variant] = process.argv.slice(2);
if (!scenarioId || !variant) {
  console.error('usage: render-server.mjs <scenarioId> <variant>');
  process.exit(2);
}

const recorder = createRecorder({ sourceRoots: [scenarioRoot], repoRoot });
const uninstall = installTraps({ record: recorder.record, hasWindow: false });

const { getScenario } = await import('../scenarios/index.js');
const scenario = getScenario(scenarioId);
const Component = scenario.variants[variant];
if (!Component) throw new Error(`scenario ${scenarioId} has no variant ${variant}`);

recorder.arm('server-render');
let html;
try {
  html = renderToString(createElement(Component));
} finally {
  recorder.disarm();
}
uninstall();

process.stdout.write(JSON.stringify({
  html,
  records: recorder.records,
  env: {
    TZ: process.env.TZ ?? null,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    node: process.version,
  },
}));
