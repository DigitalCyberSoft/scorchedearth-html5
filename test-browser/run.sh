#!/usr/bin/env bash
# Browser render-crash harness: one-command runner.
#
#   1. start the vite DEV server (per-file /src/*.ts modules -- REQUIRED so V8
#      coverage maps to individual modules; `vite preview` serves a minified bundle
#      with no per-module URLs AND would not include this harness page).
#   2. run the playwright driver against it (drives every real render state,
#      collects coverage).
# The server is started in THIS shell (background + PID + trap) so it outlives the
# command, and is killed by PID at the end.  NEVER `pkill -f vite` -- that
# self-matches this script's own command line and would SIGTERM the runner.
#
# Usage:  bash test-browser/run.sh
# Exit:   0 = every render state painted with no exception; non-zero = a crash, a
#         blank canvas, a pageerror, or the server failed to come up.
set -uo pipefail

ROOT="/home/user/Scorched Earth/scorch-html5"
PORT="${TB_PORT:-4188}"
cd "$ROOT"

echo "== start vite dev server on :$PORT =="
npx vite --port "$PORT" --strictPort >/tmp/tb_vite.log 2>&1 &
VITE_PID=$!
trap 'kill "$VITE_PID" 2>/dev/null' EXIT

# wait for the server to answer the harness page (up to ~30s)
ok=0
for i in $(seq 1 60); do
  if curl -s -o /dev/null "http://localhost:$PORT/test-browser/harness.html"; then ok=1; break; fi
  sleep 0.5
done
if [ "$ok" != 1 ]; then echo "FAIL: vite did not come up"; tail -30 /tmp/tb_vite.log; exit 11; fi

echo "== run playwright render-crash driver =="
node test-browser/run.mjs "http://localhost:$PORT"; RC=$?

kill "$VITE_PID" 2>/dev/null
exit "$RC"
