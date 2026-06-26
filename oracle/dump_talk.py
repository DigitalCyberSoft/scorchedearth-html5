#!/usr/bin/env python3
"""Oracle vector dumper for the `talk` module (attack/die taunts + war quotes).

Drives the Python port (the fidelity reference, itself byte-verified against
1.5/SCORCH.EXE and the shipped 1.5/TALK1.CFG + 1.5/TALK2.CFG) over a
deterministic input battery and writes golden vectors to vectors/talk.json. The
TypeScript differential gate (test/talk.test.ts) loads this and asserts the TS
port reproduces every result: strings EXACT, pick indices EXACT, booleans EXACT.

Standalone copy of dump_vectors.py structure. Static use of the Python port --
imports and calls pure functions headless (SDL_VIDEODRIVER=dummy). Never runs
the DOS binary.

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../scorch-py" \
        "../.venv/bin/python" oracle/dump_talk.py
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

# The directory the shipped talk files live in (TALK1.CFG / TALK2.CFG).
_DATA_DIR = os.path.normpath(os.path.join(_HERE, "..", "..", "1.5"))


def _write(module, payload):
    os.makedirs(_VECTORS, exist_ok=True)
    path = os.path.join(_VECTORS, module + ".json")
    with open(path, "w") as fh:
        json.dump(payload, fh, ensure_ascii=False)
    n = _count(payload)
    print(f"  wrote vectors/{module}.json  ({n} assertions)")
    return n


def _count(payload):
    """Rough assertion count for reporting (one per list element + scalars)."""
    total = 0

    def walk(v):
        nonlocal total
        if isinstance(v, list):
            for item in v:
                walk(item)
        elif isinstance(v, dict):
            for item in v.values():
                walk(item)
        else:
            total += 1

    for v in payload.values():
        walk(v)
    return total


# ---------------------------------------------------------------------------
# talk -- parsed taunt pools (verbatim strings), the 15-entry war-quote table
# (verbatim), and seeded picker/taunt outputs over many fixed seeds.
# ---------------------------------------------------------------------------

# Fixed seeds; the TS side reproduces each via `new Rng(seed)`. Mix of small,
# boundary (2**16-1, 2**32-1, 2**32), and wide values to exercise CPython's
# init_by_array word-splitting (mirrors dump_vectors.py SEEDS).
SEEDS = [0, 1, 2, 3, 42, 99, 100, 1234, 2024, 65535, 0x12345678,
         0xFFFFFFFF, 0x100000000, 0xDEADBEEF, 123456789012345]


def dump_talk():
    from scorch import talk
    from scorch.config import Config
    from scorch import rng as rngmod

    # --- 1. Parsed taunt pools, verbatim, via the real loader (FUN_2144_02c7
    #     -> _resolve case-insensitive -> _read latin-1 -> _parse). base_dir is
    #     the shipped 1.5/ data dir.
    cfg = Config()
    tc = talk.load_from_config(cfg, _DATA_DIR)
    attack_lines = list(tc.attack)          # verbatim list[str], blanks+dups kept
    die_lines = list(tc.die)
    settings = {
        "talking": tc.talking,              # uppercased TALKING_TANKS
        "probability": tc.probability,      # int TALK_PROBABILITY
        "delay": tc.delay,                  # int TALK_DELAY
    }

    # --- 1b. _parse unit battery: prove the parser's CRLF/CR/LF + trailing-
    #     terminator + interior-blank + duplicate handling independent of files.
    parse_cases = [
        # (label, raw input, expected output list)
        "a\r\nb\r\nc\r\n",                  # CRLF + trailing term -> [a,b,c]
        "a\nb\nc\n",                        # LF + trailing term
        "a\rb\rc\r",                        # bare CR + trailing term
        "a\r\nb\r\nc",                      # no trailing term -> last kept
        "",                                 # empty -> []
        "\r\n",                             # one terminator only -> []
        "\n",                               # one LF only -> []
        "x",                                # single line, no term -> [x]
        "a\r\n\r\nb\r\n",                   # interior blank kept -> [a,'',b]
        "dup\r\ndup\r\ndup\r\n",            # duplicates kept -> [dup,dup,dup]
        "  spaced  \r\ntrail \r\n",         # whitespace NOT stripped
        "a\r\n\r\n",                        # trailing blank: only final term dropped -> [a,'']
        "line1\nline2\r\nline3\rline4",     # mixed terminators
        "\r\n\r\n\r\n",                     # all-blank -> ['',''] (3 terms, last dropped)
    ]
    parse = []
    for raw in parse_cases:
        parse.append({"raw": raw, "out": talk._parse(raw)})

    # --- 2. War-quote table, verbatim (15 {text, author} pairs).
    war_quotes = [[t, a] for (t, a) in talk.WAR_QUOTES]

    # --- 3. war_quote(seed): the picker. For each seed, drive a run of N calls
    #     on one Rng(seed) so the TS side reproduces the SAME consumed stream.
    #     Capture the chosen index (pick result) AND the returned (text, author).
    WQ = talk.WAR_QUOTES
    war_quote_runs = []
    for s in SEEDS:
        r = rngmod.Rng(s)
        idxs, picks = [], []
        for _ in range(200):
            t, a = talk.war_quote(r)
            # recover the index by identity (entries are unique objects).
            idx = next(i for i, q in enumerate(WQ) if q[0] == t and q[1] == a)
            idxs.append(idx)
            picks.append([t, a])
        war_quote_runs.append({"seed": s, "idx": idxs, "picks": picks})

    # --- 4. _draw(pool, rng): uniform line from a pool. Drive runs on the real
    #     attack & die pools and on synthetic pools (incl. empty -> None, blanks
    #     and duplicates) to cover the branch space.
    EMPTY = []
    SINGLE = ["only"]
    BLANKS = ["a", "", "b", "", ""]        # blank entries are valid draws
    DUPS = ["x", "x", "y", "x"]            # duplication biases the draw
    DRAW_POOLS = {
        "attack": attack_lines,
        "die": die_lines,
        "empty": EMPTY,
        "single": SINGLE,
        "blanks": BLANKS,
        "dups": DUPS,
    }
    draw_runs = []
    for name, pool in DRAW_POOLS.items():
        for s in SEEDS:
            r = rngmod.Rng(s)
            out = []
            for _ in range(120):
                v = talk._draw(list(pool), r)
                out.append(v)               # str or None
            draw_runs.append({"pool": name, "seed": s, "out": out})

    # --- 5. maybe_attack_taunt / die_taunt: full gate-then-roll-then-draw.
    #     Build TalkConfigs spanning every branch:
    #       talking in {OFF, COMPUTERS, ALL, junk-token}
    #       probability in {0, 1, 50, 99, 100}
    #       tank.ai_class in {AI_HUMAN(0), some AI class(2)}
    #     Each (talking, probability, ai_class) combo gets a seeded run; the TS
    #     side reproduces the identical RNG consumption (gate consumes nothing;
    #     a failed roll consumes one pick(100); a passed roll consumes pick(100)
    #     then pick(len(pool))).
    class _Tank:
        def __init__(self, ai_class):
            self.ai_class = ai_class

    def _mk_cfg(talking, probability):
        # minimal cfg-like object carrying the keys TalkConfig reads.
        class _Cfg:
            TALKING_TANKS = talking
            TALK_PROBABILITY = probability
            TALK_DELAY = 50
        return talk.TalkConfig(list(attack_lines), list(die_lines), _Cfg())

    TALKINGS = ["OFF", "COMPUTERS", "ALL", "all", "Computers", "BOGUS"]
    PROBS = [0, 1, 50, 99, 100]
    AI_CLASSES = [0, 2]                     # AI_HUMAN, and a computer class
    taunt_runs = []
    for talking in TALKINGS:
        for prob in PROBS:
            tcfg = _mk_cfg(talking, prob)
            for ai in AI_CLASSES:
                tank = _Tank(ai)
                for s in SEEDS:
                    ra = rngmod.Rng(s)
                    rd = rngmod.Rng(s)
                    a_out, d_out = [], []
                    for _ in range(60):
                        a_out.append(talk.maybe_attack_taunt(tank, tcfg, ra))
                        d_out.append(talk.die_taunt(tank, tcfg, rd))
                    taunt_runs.append({
                        "talking": talking,
                        "prob": prob,
                        "ai_class": ai,
                        "seed": s,
                        "attack_out": a_out,    # list[str|None]
                        "die_out": d_out,
                    })

    # --- 6. _talks gate truth table (no RNG): every (talking, ai_class) combo.
    talks_table = []
    for talking in TALKINGS:
        tcfg = _mk_cfg(talking, 100)
        for ai in [0, 1, 2, 5, 7]:          # human + several AI classes
            tank = _Tank(ai)
            talks_table.append({
                "talking": talking,
                "ai_class": ai,
                "result": bool(talk._talks(tank, tcfg)),
            })

    return _write("talk", {
        "module": "talk",
        "data_dir": _DATA_DIR,
        "attack": attack_lines,
        "die": die_lines,
        "settings": settings,
        "parse": parse,
        "war_quotes": war_quotes,
        "war_quote_runs": war_quote_runs,
        "draw_runs": draw_runs,
        "taunt_runs": taunt_runs,
        "talks_table": talks_table,
    })


DUMPERS = {
    "talk": dump_talk,
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
