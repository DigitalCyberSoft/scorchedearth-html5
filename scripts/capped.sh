#!/usr/bin/env bash
# Run a command under a HARD, kernel-enforced CPU + memory ceiling so this project's
# test / coverage tooling can never starve the interactive desktop.  Fedora is cgroup
# v2 with the cpu+memory controllers delegated to the user manager, so a transient
# `systemd-run --user --scope` puts the command AND all its children (vitest forks, the
# vite dev server, headless Chrome) into one cgroup with:
#   MemoryMax        overshoot SIGKILLs only THIS scope (proven: a 512M alloc under a
#                    128M cap exits 137); the desktop is never the OOM target.
#   MemorySwapMax=0  contains pressure instead of thrashing zram swap.
#   CPUQuota         throttles the scope to a fraction of the cores; the rest stays free.
# Overridable: CAP_MEM (default 8G), CAP_CPU (default = half the logical cores).
# If no user scope is available (CI, no systemd), falls back to nice/ionice (soft only).
set -uo pipefail
[ "$#" -ge 1 ] || { echo "usage: capped.sh <command> [args...]" >&2; exit 2; }

cores="$(nproc 2>/dev/null || echo 4)"
CAP_MEM="${CAP_MEM:-8G}"
CAP_CPU="${CAP_CPU:-$(( cores * 100 / 2 ))%}"   # half the cores, in systemd per-core %

# Probe with the real caps on a no-op first; only `exec` the real command if the scope
# is accepted (exec cannot fall back, so the decision must be made before it -- and a
# non-zero from the real command must NOT be misread as scope failure).
if systemd-run --user --scope --quiet -p MemoryMax="$CAP_MEM" -p CPUQuota="$CAP_CPU" -- true >/dev/null 2>&1; then
  echo "[capped] MemoryMax=$CAP_MEM CPUQuota=$CAP_CPU (cgroup v2, ${cores} cores)" >&2
  exec systemd-run --user --scope --quiet \
    -p MemoryMax="$CAP_MEM" -p MemorySwapMax=0 -p CPUQuota="$CAP_CPU" \
    -- nice -n 10 "$@"
fi

echo "[capped] systemd user scope unavailable; soft fallback (nice/ionice only)" >&2
RN="nice -n 10"; command -v ionice >/dev/null 2>&1 && RN="ionice -c3 $RN"
exec $RN "$@"
