#!/usr/bin/env bash
# Visual regression gate: end-to-end runner.
#
#   1. Python ORACLE: render reference frames + state snapshots (headless pygame).
#   2. vite dev server (started here; killed by PID at the end -- NOT `pkill -f
#      vite`, which self-matches this script's command line and SIGTERMs us).
#   3. playwright driver: capture TS frames + snapshots from the browser.
#   4. compare: sanity gate + pixel diff + region report + diff images.
#
# The server is started and the driver+compare run in THIS shell so the server
# outlives a subshell (a subshell-backgrounded server dies when its command ends).
#
# Usage:  bash visual/run_gate.sh
# Exit:   0 = gate pass; non-zero = sanity/world divergence (see compare.mjs).
set -uo pipefail

ROOT="/home/user/Scorched Earth/scorch-html5"
VENV_PY="/home/user/Scorched Earth/.venv/bin/python"
PORT="${VIS_PORT:-5180}"
cd "$ROOT"

echo "== [1/4] Python oracle reference frames =="
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy "$VENV_PY" visual/render_python.py || {
  echo "FAIL: python oracle render"; exit 10; }

echo "== [2/4] start vite dev server on :$PORT =="
npx vite --port "$PORT" --strictPort >/tmp/vis_vite.log 2>&1 &
VITE_PID=$!
trap 'kill "$VITE_PID" 2>/dev/null' EXIT

# wait for the server to answer (up to ~20s)
ok=0
for i in $(seq 1 40); do
  if curl -s -o /dev/null "http://localhost:$PORT/harness.html"; then ok=1; break; fi
  sleep 0.5
done
if [ "$ok" != 1 ]; then echo "FAIL: vite did not come up"; tail -20 /tmp/vis_vite.log; exit 11; fi

echo "== [3/4] playwright capture of TS frames =="
node visual/diff_run.mjs "http://localhost:$PORT"; DRV=$?
if [ "$DRV" != 0 ]; then echo "FAIL: TS capture (exit $DRV)"; tail -20 /tmp/vis_vite.log; exit 12; fi

echo "== [4/4] compare + report =="
node visual/compare.mjs; CMP=$?

# explicit kill (trap also covers it); no pkill.
kill "$VITE_PID" 2>/dev/null
exit "$CMP"
