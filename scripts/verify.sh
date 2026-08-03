#!/usr/bin/env bash
# Verification for hydration-diff.
#
# Nothing here is allowed to skip. If a dependency is missing this exits nonzero and names the
# command that installs it, because a skipped check reports the same green as a check that ran.
#
# The order is deliberate: the unit suite first because it is fast and specific, then the live
# runs that produce the recording, then three independent re-derivations of that recording (a
# Python checker that shares no code, a real browser, and real Next.js), then the sabotages that
# prove the checks above can fail, then hygiene, then the README.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT=$PWD
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
FAILED_CHECKS=$TMP/failed.txt
: >"$FAILED_CHECKS"
ok() { printf '  ok    %s\n' "$1"; pass=$((pass + 1)); }
# Every failure is also recorded, so the summary can name them. A run whose output got truncated
# once left a "25 passed, 1 failed" with no way to tell which check it was, and an anonymous
# failure is barely more useful than no failure.
bad() { printf '  FAIL  %s\n' "$1"; printf '%s\n' "$1" >>"$FAILED_CHECKS"; fail=$((fail + 1)); }
# The escaped tilde matters: the unescaped form is tilde-expanded by bash before the substitution,
# so it replaces $HOME with $HOME and silently leaves the absolute path in the output.
rel() { printf '%s' "${1/#$HOME/\~}"; }

EXPECTED_UNIT_TESTS=51
EXPECTED_SCENARIOS=10
EXPECTED_RUNS=18
EXPECTED_CAUSES=7

echo "hydration-diff verification"
echo "  node $(node -v), python $(python3 --version 2>&1 | cut -d' ' -f2), repo $(rel "$ROOT")"
echo

echo "1. dependencies"
if [ ! -d node_modules ]; then
  echo "  ..    installing dependencies (node_modules is absent)"
  if ! npm install --no-audit --no-fund >"$TMP/install.log" 2>&1; then
    bad "npm install failed. Run: npm install"
    tail -15 "$TMP/install.log" | sed 's/^/        /'
  fi
fi
for pkg in react react-dom jsdom playwright-core; do
  if [ -d "node_modules/$pkg" ]; then
    ok "$pkg $(node -p "require('./node_modules/$pkg/package.json').version")"
  else
    bad "$pkg is missing. Run: npm install"
  fi
done
if [ ! -d fixtures/next-app/node_modules/next ]; then
  echo "  ..    installing the Next.js fixture (absent)"
  if ! npm --prefix fixtures/next-app install --no-audit --no-fund >"$TMP/next-install.log" 2>&1; then
    bad "the Next fixture failed to install. Run: npm --prefix fixtures/next-app install"
    tail -15 "$TMP/next-install.log" | sed 's/^/        /'
  fi
fi
if [ -d fixtures/next-app/node_modules/next ]; then
  ok "next $(node -p "require('./fixtures/next-app/node_modules/next/package.json').version") (fixture)"
else
  bad "next is missing. Run: npm --prefix fixtures/next-app install"
fi
echo

echo "2. unit suite"
if node --test "test/*.test.mjs" >"$TMP/unit.log" 2>&1; then
  unit=$(grep -oE '^. pass [0-9]+' "$TMP/unit.log" | tail -1 | grep -oE '[0-9]+')
  if [ "$unit" = "$EXPECTED_UNIT_TESTS" ]; then
    ok "$unit unit tests pass"
  else
    bad "expected $EXPECTED_UNIT_TESTS unit tests, ran $unit (update EXPECTED_UNIT_TESTS and the README)"
  fi
else
  bad "the unit suite failed"
  grep -A8 'failing tests' "$TMP/unit.log" | head -30 | sed 's/^/        /'
fi
echo

echo "3. live scenario runs (two processes each, real render, real hydration)"
if node scripts/assert-scenarios.mjs >"$TMP/live.log" 2>&1; then
  live=$(grep -cE '^  ok ' "$TMP/live.log")
  runs=$(grep -oE 'across [0-9]+ live runs' "$TMP/live.log" | grep -oE '[0-9]+')
  if [ "$runs" = "$EXPECTED_RUNS" ]; then
    ok "$live assertions across $runs live runs"
  else
    bad "expected $EXPECTED_RUNS live runs, saw $runs"
  fi
else
  bad "the live scenario assertions failed"
  grep '^  FAIL' "$TMP/live.log" | head -12 | sed 's/^/        /'
fi

# Each cause must have both a broken and a fixed variant, or the negative control is missing.
missing=$(node -e '
const { scenarios } = await import("./scenarios/index.js");
const bad = scenarios.filter((s) => !s.control && !(s.variants.broken && s.variants.fixed));
process.stdout.write(bad.map((s) => s.id).join(","));
' --input-type=module 2>/dev/null)
if [ -z "$missing" ]; then
  ok "every non-control scenario ships a broken variant and a fixed one"
else
  bad "these scenarios have no fixed counterpart: $missing"
fi

causes=$(node -p '
const d = require("./data/captures.json");
new Set(d.captures.filter((c) => !c.scenario.control && c.scenario.cause).map((c) => c.scenario.cause)).size
')
if [ "$causes" = "$EXPECTED_CAUSES" ]; then
  ok "$causes distinct causes reproduced"
else
  bad "expected $EXPECTED_CAUSES distinct causes, the recording has $causes"
fi
echo

echo "4. independent re-derivation (Python, shares no code with the engine)"
if python3 scripts/independent-check.py >"$TMP/indep.log" 2>&1; then
  ok "$(grep -oE '[0-9]+ passed' "$TMP/indep.log" | tail -1) in the independent checker"
else
  bad "the independent checker disagrees with the engine"
  grep '^  FAIL' "$TMP/indep.log" | head -10 | sed 's/^/        /'
  grep '^        ' "$TMP/indep.log" | head -6 | sed 's/^/  /'
fi
echo

echo "5. the page, in a real browser"
if node scripts/build-docs.mjs >"$TMP/docs.log" 2>&1; then
  ok "$(sed 's/^ *//' "$TMP/docs.log" | tail -1)"
else
  bad "the docs build failed"
  tail -10 "$TMP/docs.log" | sed 's/^/        /'
fi
if node scripts/check-page.mjs >"$TMP/page.log" 2>&1; then
  ok "$(grep -oE '[0-9]+ passed' "$TMP/page.log" | tail -1) in the browser page check"
else
  bad "the browser page check failed"
  grep '^  FAIL' "$TMP/page.log" | head -10 | sed 's/^/        /'
fi
echo

echo "6. real Next.js and real Chromium"
if node scripts/next-corroborate.mjs >"$TMP/next.log" 2>&1; then
  ok "$(grep -oE '[0-9]+ passed' "$TMP/next.log" | tail -1) against a real Next.js build"
  grep -oE '\(real Next.js.*\)' "$TMP/next.log" | tail -1 | sed 's/^/        /'
else
  bad "the Next.js corroboration failed"
  grep '^  FAIL' "$TMP/next.log" | head -10 | sed 's/^/        /'
fi
echo

echo "7. sabotage: break the engine on purpose and require the checks to notice"
if bash scripts/sabotage.sh >"$TMP/sabotage.log" 2>&1; then
  ok "$(grep -oE '[0-9]+ passed, [0-9]+ failed across [0-9]+ sabotages' "$TMP/sabotage.log")"
  grep '^  \.\.' "$TMP/sabotage.log" | sed 's/^/      /'
else
  bad "a sabotage went unnoticed or failed to apply"
  grep -E '^  (FAIL|\.\.)' "$TMP/sabotage.log" | head -12 | sed 's/^/        /'
fi
echo

echo "8. hygiene"
# Case-sensitive on purpose: AWS key ids are uppercase by definition, and a case-insensitive
# sweep matches base64 inside any embedded image.
if git grep -nE '(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{32,}|xox[baprs]-[A-Za-z0-9-]{10,})' -- . >"$TMP/secrets.txt" 2>/dev/null; then
  bad "credential-shaped strings in tracked files"
  head -5 "$TMP/secrets.txt" | sed 's/^/        /'
else
  ok "no credential-shaped strings in tracked files"
fi
# A single NUL byte makes git and grep treat a file as binary, and both scans above then skip it
# silently. grep -P is not available everywhere, so this is done in Python.
nulls=$(git ls-files -z | python3 -c '
import sys
names = sys.stdin.buffer.read().split(b"\0")
hits = []
for name in names:
    if not name:
        continue
    try:
        with open(name, "rb") as fh:
            if b"\0" in fh.read():
                hits.append(name.decode())
    except OSError:
        pass
print(" ".join(hits))
')
if [ -z "$nulls" ]; then
  ok "no tracked file contains a NUL byte, so the scans above could read all of them"
else
  bad "these tracked files contain a NUL byte and are invisible to the scans: $nulls"
fi
if git grep -nI "$HOME" -- . >"$TMP/paths.txt" 2>/dev/null; then
  bad "an absolute home path is committed"
  head -5 "$TMP/paths.txt" | sed 's/^/        /'
else
  ok "no absolute home path in tracked files"
fi
if git ls-files | grep -qE '^(node_modules|\.next|fixtures/next-app/(node_modules|\.next))/'; then
  bad "dependencies or build output are tracked"
else
  ok "no dependencies or build output are tracked"
fi
big=$(git ls-files -z | xargs -0 -I{} sh -c 'test -f "{}" && wc -c < "{}" | tr -d " " | sed "s|$|	{}|"' 2>/dev/null | awk -F'\t' '$1 > 1048576 {print $2 " (" int($1/1024) " KB)"}')
if [ -z "$big" ]; then
  ok "no tracked file is over a megabyte"
else
  bad "tracked files over a megabyte: $big"
fi
if [ -f LICENSE ] && [ -f .gitignore ] && [ -f README.md ]; then
  ok "LICENSE, .gitignore and README.md are present"
else
  bad "LICENSE, .gitignore or README.md is missing"
fi
echo

echo "9. the README is part of the deliverable"
SUCCESS_LINE="hydration-diff: all checks passed"
if [ ! -f README.md ]; then
  bad "README.md does not exist"
elif ! grep -q '^## Status' README.md; then
  bad "README.md has no Status section"
elif ! grep -qF "$SUCCESS_LINE" README.md; then
  bad "README.md's Status section does not carry this script's success line"
else
  ok "README.md carries a Status section with this script's success line"
fi
# The numbers in the README are claims like any other, so they are checked against this run.
for claim in "$EXPECTED_UNIT_TESTS unit tests" "$EXPECTED_RUNS live runs" "$EXPECTED_CAUSES distinct causes" "$EXPECTED_SCENARIOS scenarios"; do
  if grep -qF "$claim" README.md; then
    ok "README states \"$claim\", which matches this run"
  else
    bad "README does not state \"$claim\"; regenerate it with: node scripts/build-readme.mjs"
  fi
done
if grep -qE 'TODO|FIXME|replace with a real' README.md; then
  bad "README still contains a placeholder"
else
  ok "README contains no placeholder"
fi
echo

echo "  $pass passed, $fail failed"
if [ "$fail" -eq 0 ]; then
  echo "  $SUCCESS_LINE"
  exit 0
fi
echo "  failed checks:"
sed 's/^/    - /' "$FAILED_CHECKS"
exit 1
