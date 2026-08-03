#!/usr/bin/env bash
# Attack this project's own checks and require them to notice.
#
# Each sabotage runs in a throwaway copy of the working tree, and each one is PROVED to have
# changed real output before anything is concluded from it. An observation command runs before and
# after the patch and the two outputs must differ; if they do not, the sabotage is reported as
# having proved nothing, rather than as evidence of a gap. One of the six patches here was a no-op
# on its first draft (both sides of the string replacement were the same byte), which is exactly
# the failure this handshake exists to catch.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT=$PWD
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok() { printf '  ok    %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail + 1)); }

n=0
# run_sabotage <name> <patch file> <observation command> <check command>
run_sabotage() {
  local name=$1 patch=$2 observe=$3 check=$4
  n=$((n + 1))
  local dir="$TMP/s$n"
  mkdir -p "$dir"
  # The working tree, including files not yet committed. A sabotage against a stale copy would
  # exercise code that is not the code under test.
  git -C "$ROOT" ls-files -z --cached --others --exclude-standard \
    | tar -C "$ROOT" --null -T - -cf - | tar -C "$dir" -xf -
  ln -s "$ROOT/node_modules" "$dir/node_modules"

  local before after
  before=$(cd "$dir" && eval "$observe" 2>&1)

  if ! (cd "$dir" && python3 "$ROOT/scripts/sabotage/$patch"); then
    bad "$name: the patch did not apply, so it proves nothing"
    return
  fi

  after=$(cd "$dir" && eval "$observe" 2>&1)
  if [ "$before" = "$after" ]; then
    bad "$name: the sabotage changed no observable output, so it proves nothing"
    return
  fi
  local delta
  delta=$(diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | grep -c '^[<>]' || true)
  printf '  ..    %s: changed %s line(s) of real output\n' "$name" "$delta"

  if (cd "$dir" && eval "$check" >"$TMP/check$n.log" 2>&1); then
    bad "$name: the check still passed on sabotaged code"
    tail -12 "$TMP/check$n.log" | sed 's/^/        /'
  else
    ok "$name: the check failed, as it must"
    grep -m3 '^  FAIL' "$TMP/check$n.log" | sed 's/^/        /'
  fi
}

echo "hydration-diff sabotage"
echo

run_sabotage 'text nodes ignored' 01-ignore-text.py \
  'node bin/hydration-diff.js run random-during-render broken | head -5' \
  'node scripts/assert-scenarios.mjs'

run_sabotage 'attributes ignored' 02-ignore-attributes.py \
  'node bin/hydration-diff.js run client-storage broken | head -5' \
  'node scripts/assert-scenarios.mjs'

run_sabotage 'the authored parser repairs like a browser' 03-parser-repairs.py \
  'node bin/hydration-diff.js run nesting-div-in-p broken | head -12' \
  'node scripts/assert-scenarios.mjs'

run_sabotage 'nbsp folded into an ordinary space' 04-overfold-nbsp.py \
  'node -e "import(\"./src/html.js\").then((m) => console.log(JSON.stringify(m.decodeEntities(\"a&nbsp;b\"))))"' \
  'node --test "test/*.test.mjs"'

run_sabotage 'every text node reported as changed' 05-report-everything.py \
  'node bin/hydration-diff.js run random-during-render fixed | head -5' \
  'node scripts/assert-scenarios.mjs'

run_sabotage 'a cause named on every run' 06-always-nesting.py \
  'node bin/hydration-diff.js run control-text-separators fixed | head -12' \
  'node scripts/assert-scenarios.mjs'

echo
echo "  $pass passed, $fail failed across $n sabotages"
[ "$fail" -eq 0 ]
