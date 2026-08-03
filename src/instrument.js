// Record the calls that make a render non-reproducible, with the file and line that made them.
//
// A tree diff says two trees differ. It cannot say why. The why is almost always a specific call
// in a specific component: `Math.random()`, `new Date()`, a `toLocaleString()` that resolves
// against the machine's timezone, a `localStorage` read, or a `typeof window` probe. All of those
// are observable if you replace the global before the render and put it back after.
//
// `typeof window` is the interesting one. It looks untrappable, because `typeof` on an undeclared
// binding cannot throw. But `window` on the server is not undeclared, it is absent, and an absent
// global can be defined as an accessor. `typeof window` then performs a normal property get, the
// getter runs, and the probe is recorded. The getter returns `undefined`, so the component still
// takes the branch it would have taken.
//
// Records are attributed by walking the JS stack for the first frame inside the scenario sources.
// Frames from React and from this file are dropped, so a `typeof window` check inside react-dom
// itself does not get blamed on the app.

import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRAME = /^\s*at (?:(.*?) \()?(.+?):(\d+):(\d+)\)?$/;

function toPath(loc) {
  if (loc.startsWith('file://')) {
    try {
      return fileURLToPath(loc);
    } catch {
      return loc;
    }
  }
  return loc;
}

export function createRecorder({ sourceRoots, repoRoot }) {
  const records = [];
  let armed = false;
  let phase = 'idle';

  const inSources = (file) => sourceRoots.some((root) => file.startsWith(root + sep) || file === root);

  function frames() {
    const err = new Error();
    const lines = (err.stack ?? '').split('\n').slice(1);
    const out = [];
    for (const line of lines) {
      const m = FRAME.exec(line);
      if (!m) continue;
      const file = toPath(m[2]);
      if (!inSources(file)) continue;
      out.push({
        name: (m[1] ?? '<anonymous>').replace(/^(new|async|Object\.) /, ''),
        file: relative(repoRoot, file).split(sep).join('/'),
        line: Number(m[3]),
        column: Number(m[4]),
      });
    }
    return out;
  }

  function record(api, detail) {
    if (!armed) return;
    const stack = frames();
    // No app frame means the call came from React or from the DOM implementation. Attributing it
    // to a component would be a confident lie.
    if (stack.length === 0) return;
    records.push({
      api,
      detail: detail === undefined ? null : String(detail),
      phase,
      file: stack[0].file,
      line: stack[0].line,
      column: stack[0].column,
      componentStack: stack.map((f) => f.name),
    });
  }

  return {
    records,
    arm(name) { armed = true; phase = name; },
    disarm() { armed = false; phase = 'idle'; },
    record,
  };
}

/**
 * Replace the non-deterministic globals on `target`. Returns a function that puts them back.
 *
 * `hasWindow` says which side we are on. On the server the missing globals become recording
 * accessors; on the client the present ones get wrapped.
 */
export function installTraps({ record, target = globalThis, hasWindow, windowValue = undefined }) {
  const undo = [];
  const define = (name, get) => {
    const had = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { configurable: true, get });
    undo.push(() => {
      if (had) Object.defineProperty(target, name, had);
      else delete target[name];
    });
  };

  const origRandom = Math.random;
  Math.random = function random() {
    record('Math.random()');
    return origRandom.call(Math);
  };
  undo.push(() => { Math.random = origRandom; });

  const OrigDate = target.Date;
  class RecordingDate extends OrigDate {
    constructor(...args) {
      if (args.length === 0) record('new Date()');
      super(...args);
    }
  }
  for (const key of ['parse', 'UTC']) RecordingDate[key] = OrigDate[key];
  RecordingDate.now = function now() {
    record('Date.now()');
    return OrigDate.now();
  };
  target.Date = RecordingDate;
  undo.push(() => { target.Date = OrigDate; });

  for (const method of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
    const orig = OrigDate.prototype[method];
    OrigDate.prototype[method] = function patched(...args) {
      record(`Date#${method}()`, args[0] === undefined ? 'no explicit locale' : String(args[0]));
      return orig.apply(this, args);
    };
    undo.push(() => { OrigDate.prototype[method] = orig; });
  }

  const origNumberLocale = Number.prototype.toLocaleString;
  Number.prototype.toLocaleString = function patched(...args) {
    record('Number#toLocaleString()', args[0] === undefined ? 'no explicit locale' : String(args[0]));
    return origNumberLocale.apply(this, args);
  };
  undo.push(() => { Number.prototype.toLocaleString = origNumberLocale; });

  for (const name of ['DateTimeFormat', 'NumberFormat']) {
    const orig = Intl[name];
    Intl[name] = new Proxy(orig, {
      construct(t, args) {
        record(`Intl.${name}`, args[0] === undefined ? 'no explicit locale' : String(args[0]));
        return Reflect.construct(t, args);
      },
      apply(t, thisArg, args) {
        record(`Intl.${name}`, args[0] === undefined ? 'no explicit locale' : String(args[0]));
        return Reflect.apply(t, undefined, args);
      },
    });
    undo.push(() => { Intl[name] = orig; });
  }

  if (!hasWindow) {
    define('window', () => { record('typeof window'); return undefined; });
    define('document', () => { record('typeof document'); return undefined; });
    define('localStorage', () => { record('localStorage'); return undefined; });
    define('sessionStorage', () => { record('sessionStorage'); return undefined; });
    define('navigator', () => { record('navigator'); return undefined; });
  } else {
    define('window', () => { record('typeof window'); return windowValue; });
    const storageProto = Object.getPrototypeOf(windowValue.localStorage);
    for (const method of ['getItem', 'key']) {
      const orig = storageProto[method];
      storageProto[method] = function patched(...args) {
        record(`localStorage.${method}()`, args[0]);
        return orig.apply(this, args);
      };
      undo.push(() => { storageProto[method] = orig; });
    }
  }

  return function uninstall() {
    for (let i = undo.length - 1; i >= 0; i -= 1) undo[i]();
  };
}
