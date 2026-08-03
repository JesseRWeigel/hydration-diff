import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecorder, installTraps } from '../src/instrument.js';
import { drawsRandom, readsClock, probesWindow, formatsLocale } from './fixture-caller.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

function withTraps(fn, { hasWindow = false } = {}) {
  const recorder = createRecorder({ sourceRoots: [here], repoRoot });
  const uninstall = installTraps({ record: recorder.record, hasWindow });
  try {
    recorder.arm('server-render');
    fn();
    recorder.disarm();
  } finally {
    uninstall();
  }
  return recorder.records;
}

test('Math.random is recorded with the file and line that called it', () => {
  const records = withTraps(() => { drawsRandom(); });
  assert.equal(records.length, 1);
  assert.equal(records[0].api, 'Math.random()');
  assert.equal(records[0].file, 'test/fixture-caller.js');
  assert.equal(records[0].line, 6);
  // The whole stack of in-source frames is kept, innermost first. This test file counts as one,
  // since it is inside the declared source root.
  assert.equal(records[0].componentStack[0], 'drawsRandom');
  assert.ok(records[0].componentStack.includes('withTraps'));
});

test('both spellings of reading the clock are recorded', () => {
  const apis = withTraps(() => { readsClock(); }).map((r) => r.api);
  assert.deepEqual(apis.sort(), ['Date.now()', 'new Date()']);
});

test('new Date(value) is not recorded, because a fixed instant is deterministic', () => {
  const records = withTraps(() => { formatsLocale(new Date('2026-03-14T21:30:00Z')); });
  assert.deepEqual(records.map((r) => r.api), ['Date#toLocaleString()']);
  assert.equal(records[0].detail, 'no explicit locale');
});

test('typeof window is trapped on the server and still reads as undefined', () => {
  let branch;
  const records = withTraps(() => { branch = probesWindow(); });
  assert.equal(branch, 'server');
  assert.deepEqual(records.map((r) => r.api), ['typeof window']);
});

test('calls from outside the source roots are dropped rather than blamed on the app', () => {
  // This call originates in the test file, which is not a declared source root for this recorder.
  const recorder = createRecorder({ sourceRoots: [join(here, 'nowhere')], repoRoot });
  const uninstall = installTraps({ record: recorder.record, hasWindow: false });
  recorder.arm('server-render');
  drawsRandom();
  recorder.disarm();
  uninstall();
  assert.equal(recorder.records.length, 0);
});

test('nothing is recorded while disarmed', () => {
  const recorder = createRecorder({ sourceRoots: [here], repoRoot });
  const uninstall = installTraps({ record: recorder.record, hasWindow: false });
  drawsRandom();
  uninstall();
  assert.equal(recorder.records.length, 0);
});

test('the phase is carried on every record', () => {
  const recorder = createRecorder({ sourceRoots: [here], repoRoot });
  const uninstall = installTraps({ record: recorder.record, hasWindow: false });
  recorder.arm('client-render');
  drawsRandom();
  recorder.disarm();
  recorder.arm('hydrate');
  drawsRandom();
  recorder.disarm();
  uninstall();
  assert.deepEqual(recorder.records.map((r) => r.phase), ['client-render', 'hydrate']);
});

test('uninstall puts every global back exactly as it was', () => {
  const before = {
    random: Math.random,
    Date: globalThis.Date,
    toLocaleString: Date.prototype.toLocaleString,
    numberToLocaleString: Number.prototype.toLocaleString,
    DateTimeFormat: Intl.DateTimeFormat,
    NumberFormat: Intl.NumberFormat,
    hadWindow: Object.prototype.hasOwnProperty.call(globalThis, 'window'),
  };
  withTraps(() => { drawsRandom(); });
  assert.equal(Math.random, before.random);
  assert.equal(globalThis.Date, before.Date);
  assert.equal(Date.prototype.toLocaleString, before.toLocaleString);
  assert.equal(Number.prototype.toLocaleString, before.numberToLocaleString);
  assert.equal(Intl.DateTimeFormat, before.DateTimeFormat);
  assert.equal(Intl.NumberFormat, before.NumberFormat);
  assert.equal(Object.prototype.hasOwnProperty.call(globalThis, 'window'), before.hadWindow);
});

test('the recording Date still behaves like a Date', () => {
  withTraps(() => {
    const fixed = new Date('2026-03-14T21:30:00Z');
    assert.ok(fixed instanceof Date);
    assert.equal(fixed.toISOString(), '2026-03-14T21:30:00.000Z');
    assert.equal(Date.parse('2026-03-14T21:30:00Z'), 1773523800000);
    assert.equal(Date.UTC(2026, 2, 14), 1773446400000);
  });
});
