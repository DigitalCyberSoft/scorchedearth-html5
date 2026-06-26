#!/usr/bin/env python3
"""Oracle vector dumper: drives the Python port (the fidelity reference) over
deterministic input batteries and writes golden vectors to vectors/<module>.json.

The TypeScript differential gate (test/*.test.ts) loads these JSON files and
asserts the TS port reproduces each result exactly (integer/index/pixel) or
within a stated epsilon (transcendental-derived float).

This is a STATIC use of the Python port -- it imports and calls the port's pure
functions headless (SDL_VIDEODRIVER=dummy). It never runs the DOS binary.

Run (from scorch-html5/oracle/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../../scorch-py" \
        "../../.venv/bin/python" dump_vectors.py

Phase 0 dumps: rng. Phase 1 agents extend this module-by-module.
"""
import json
import os
import sys

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

_HERE = os.path.dirname(os.path.abspath(__file__))
_VECTORS = os.path.join(_HERE, "vectors")
# scorch-py is the sibling of scorch-html5.
_SCORCH_PY = os.path.normpath(os.path.join(_HERE, "..", "..", "scorch-py"))
if _SCORCH_PY not in sys.path:
    sys.path.insert(0, _SCORCH_PY)


def _write(module, payload):
    os.makedirs(_VECTORS, exist_ok=True)
    path = os.path.join(_VECTORS, module + ".json")
    with open(path, "w") as fh:
        json.dump(payload, fh)
    n = _count(payload)
    print(f"  wrote vectors/{module}.json  ({n} assertions)")
    return n


def _count(payload):
    """Rough assertion count for reporting."""
    total = 0
    for v in payload.values():
        if isinstance(v, list):
            for item in v:
                if isinstance(item, dict):
                    for key in ("words", "out"):
                        if key in item and isinstance(item[key], list):
                            total += len(item[key])
    return total


# ---------------------------------------------------------------------------
# rng -- the linchpin. Validate the raw MT19937 stream + seeding, then the full
# Rng interface (pick / chance / uniform / roulette).
# ---------------------------------------------------------------------------
def dump_rng():
    from scorch import rng as rngmod

    SEEDS = [0, 1, 2, 42, 1234, 2024, 65535, 0x12345678, 0xFFFFFFFF, 0x100000000,
             0xDEADBEEF, 123456789012345]

    # Raw MT stream: getrandbits(32) == one tempered MT word. 700 > N(624) words
    # so the regeneration boundary is crossed and exercised.
    raw = []
    for s in SEEDS:
        r = rngmod.Rng(s)
        words = [r._r.getrandbits(32) for _ in range(700)]
        raw.append({"seed": s, "words": words})

    # pick(n): randrange(n) rejection loop over a battery of n (incl. powers of 2
    # and non-powers, which take different bit_length paths).
    PICK_NS = [2, 3, 5, 7, 8, 10, 11, 15, 16, 17, 31, 32, 33, 100, 255, 256,
               360, 1000, 1024, 4096, 65535]
    pick = []
    for s in SEEDS:
        r = rngmod.Rng(s)
        calls, out = [], []
        for i in range(400):
            n = PICK_NS[i % len(PICK_NS)]
            calls.append(n)
            out.append(r.pick(n))
        pick.append({"seed": s, "ns": calls, "out": out})

    # chance(num, den)
    CHANCE = [(1, 2), (1, 3), (30, 100), (50, 100), (99, 100), (1, 1000), (7, 16)]
    chance = []
    for s in SEEDS:
        r = rngmod.Rng(s)
        calls, out = [], []
        for i in range(300):
            num, den = CHANCE[i % len(CHANCE)]
            calls.append([num, den])
            out.append(bool(r.chance(num, den)))
        chance.append({"seed": s, "calls": calls, "out": out})

    # uniform(a, b): exact double (pure MT arithmetic; must match bit-for-bit).
    UNIF = [(0.0, 1.0), (0.0, 360.0), (-1.0, 1.0), (0.0, 1000.0), (10.5, 99.25),
            (-180.0, 180.0)]
    uniform = []
    for s in SEEDS:
        r = rngmod.Rng(s)
        calls, out = [], []
        for i in range(300):
            a, b = UNIF[i % len(UNIF)]
            calls.append([a, b])
            out.append(r.uniform(a, b))
        uniform.append({"seed": s, "calls": calls, "out": out})

    # roulette(weights): uses uniform -> random -> two MT words per call.
    WEIGHTS = [[1, 2, 3], [5, 5], [1, 1, 1, 1], [10, 0, 5], [0, 0, 7],
               [3, 1, 4, 1, 5, 9, 2, 6]]
    roulette = []
    for s in SEEDS:
        r = rngmod.Rng(s)
        calls, out = [], []
        for i in range(300):
            w = WEIGHTS[i % len(WEIGHTS)]
            calls.append(w)
            out.append(r.roulette(list(w)))
        roulette.append({"seed": s, "calls": calls, "out": out})

    return _write("rng", {
        "module": "rng",
        "raw": raw,
        "pick": pick,
        "chance": chance,
        "uniform": uniform,
        "roulette": roulette,
    })


DUMPERS = {
    "rng": dump_rng,
}


def main():
    which = sys.argv[1:] or list(DUMPERS)
    total = 0
    print(f"Oracle: dumping {', '.join(which)} (port = {_SCORCH_PY})")
    for name in which:
        if name not in DUMPERS:
            print(f"  ! unknown module: {name}", file=sys.stderr)
            continue
        total += DUMPERS[name]()
    print(f"Done. ~{total} golden assertions across {len(which)} module(s).")


if __name__ == "__main__":
    main()
