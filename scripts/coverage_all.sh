#!/usr/bin/env bash
# MERGED coverage: run all THREE V8 sources, then union them into one line% table.
#
#   1. NODE          vitest run --coverage  -> coverage/node/coverage-final.json (istanbul)
#   2. BROWSER-RENDER test-browser/run.mjs   -> coverage/browser-render/v8.json  (raw V8)
#   3. REAL-APP BOOT  test-browser/boot_cover.mjs -> coverage/boot/v8.json        (raw V8)
#   merge            scripts/coverage_merge.mjs  -> prints per-file + All-files line% table
#
# (2) and (3) share ONE vite DEV server (per-file /src/*.ts modules with inline
# sourcemaps -- REQUIRED so the raw V8 maps back to individual modules; `vite preview`
# serves a minified bundle with no per-module URLs).  The server is started in THIS
# shell (background + PID + trap) so it outlives the node drivers, and killed by PID.
# NEVER `pkill -f vite` -- it would self-match this script.
#
# The merge ALWAYS runs (the table is the deliverable); the script then exits non-zero
# iff any collector failed, so a real test/render/boot failure is not hidden.
#
# Usage:  bash scripts/coverage_all.sh   (or: npm run coverage:all)
set -uo pipefail

ROOT="/home/user/Scorched Earth/scorch-html5"
PORT="${TB_PORT:-4188}"
cd "$ROOT"

rc_node=0; rc_render=0; rc_boot=0

# --- 1. NODE coverage (vitest v8 -> istanbul) --------------------------------
echo "== [1/3] node coverage: vitest run --coverage =="
npx vitest run --coverage; rc_node=$?
[ "$rc_node" = 0 ] || echo "WARN: vitest run --coverage exited $rc_node (continuing to merge)"

# --- start ONE vite dev server for both browser captures ---------------------
echo "== start vite dev server on :$PORT =="
npx vite --port "$PORT" --strictPort >/tmp/cov_vite.log 2>&1 &
VITE_PID=$!
trap 'kill "$VITE_PID" 2>/dev/null' EXIT

ok=0
for i in $(seq 1 60); do
  if curl -s -o /dev/null "http://localhost:$PORT/test-browser/harness.html" \
     && curl -s -o /dev/null "http://localhost:$PORT/index.html"; then ok=1; break; fi
  sleep 0.5
done
if [ "$ok" != 1 ]; then echo "FAIL: vite did not come up"; tail -30 /tmp/cov_vite.log; exit 11; fi

# --- 2. BROWSER-RENDER coverage (render-crash harness) -----------------------
echo "== [2/3] browser-render coverage: test-browser/run.mjs =="
COVER_V8_OUT="$ROOT/coverage/browser-render/v8.json" node test-browser/run.mjs "http://localhost:$PORT"; rc_render=$?
[ "$rc_render" = 0 ] || echo "WARN: browser-render harness exited $rc_render (continuing to merge)"

# --- 3. REAL-APP BOOT+PLAY coverage (drives src/main.ts) ---------------------
echo "== [3/3] real-app boot coverage: test-browser/boot_cover.mjs =="
COVER_V8_OUT="$ROOT/coverage/boot/v8.json" node test-browser/boot_cover.mjs "http://localhost:$PORT"; rc_boot=$?
[ "$rc_boot" = 0 ] || echo "WARN: boot driver exited $rc_boot (continuing to merge)"

kill "$VITE_PID" 2>/dev/null; trap - EXIT

# --- merge (always; the table is the deliverable) ----------------------------
echo "== merge: scripts/coverage_merge.mjs =="
node scripts/coverage_merge.mjs; rc_merge=$?

# Exit non-zero if the merge itself failed, or any collector failed (do not hide a
# real test/render/boot failure behind a green coverage run).
if [ "$rc_merge" != 0 ]; then exit "$rc_merge"; fi
if [ "$rc_node" != 0 ] || [ "$rc_render" != 0 ] || [ "$rc_boot" != 0 ]; then
  echo "NOTE: merged table printed, but a collector failed (node=$rc_node render=$rc_render boot=$rc_boot)"
  exit 1
fi
echo "OK: all three coverage sources collected and merged."
