// A stand-in for a component module, used by the instrumentation test. It has to live in its own
// file because attribution works by finding the first stack frame inside a source root, and a
// call made from the test file itself would be indistinguishable from a call made by the harness.

export function drawsRandom() {
  return Math.random();
}

export function readsClock() {
  return new Date().getTime() + Date.now();
}

export function probesWindow() {
  return typeof window === 'undefined' ? 'server' : 'browser';
}

export function formatsLocale(date) {
  return date.toLocaleString();
}
