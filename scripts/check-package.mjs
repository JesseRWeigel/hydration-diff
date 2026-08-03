#!/usr/bin/env node
// Pack the package the way npm would, unpack it somewhere else, and drive the CLI from there.
//
// This exists because `files` in package.json shipped `bin`, `src` and `scenarios` and not
// `runner`, and src/capture.js spawns `runner/render-server.mjs` as a child process. Everything
// in the repo passed. Every unit test passed. The published package would have failed on its
// first command with ENOENT, and nothing in the suite looked at the tarball.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  ok    ${m}`); pass += 1; };
const bad = (m) => { console.log(`  FAIL  ${m}`); fail += 1; };

const dir = mkdtempSync(join(tmpdir(), 'hydration-diff-pack-'));
try {
  execFileSync('npm', ['pack', '--pack-destination', dir], { cwd: root, stdio: 'pipe' });
  const tgz = readdirSync(dir).find((f) => f.endsWith('.tgz'));
  if (!tgz) {
    bad('npm pack produced no tarball');
  } else {
    execFileSync('tar', ['-xzf', join(dir, tgz), '-C', dir]);
    const pkg = join(dir, 'package');

    for (const needed of ['bin/hydration-diff.js', 'src/capture.js', 'runner/render-server.mjs',
      'runner/render-client.mjs', 'scenarios/index.js', 'README.md', 'LICENSE']) {
      if (existsSync(join(pkg, needed))) ok(`the tarball contains ${needed}`);
      else bad(`the tarball is missing ${needed}, so the published package is broken`);
    }
    if (existsSync(join(pkg, 'node_modules'))) bad('the tarball ships node_modules');
    else ok('the tarball ships no node_modules');

    // Dependencies come from this checkout rather than a network install, because the point here
    // is the file list and not npm's resolver.
    symlinkSync(join(root, 'node_modules'), join(pkg, 'node_modules'));
    let out = '';
    try {
      out = execFileSync('node', [join(pkg, 'bin', 'hydration-diff.js'), 'run', 'nesting-div-in-p', 'broken'],
        { encoding: 'utf8' });
    } catch (err) {
      // The CLI exits 1 when it finds a mismatch, which is the expected outcome here.
      out = err.stdout ?? '';
      if (!out) {
        bad(`the packed CLI failed to run: ${(err.stderr ?? err.message).toString().split('\n').slice(0, 4).join(' ')}`);
      }
    }
    if (/hydration mismatch/.test(out) && /Invalid HTML nesting/.test(out)) {
      ok('the packed CLI runs a full capture and names the cause');
    } else if (out) {
      bad(`the packed CLI ran but produced unexpected output: ${out.slice(0, 200)}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
