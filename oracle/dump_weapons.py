#!/usr/bin/env python3
"""Oracle vector dumper for the `weapons` module (the 48-record equipment table
DAT_5f38_1200, named-slot constants, MORON_WEIGHTS, and the by_name helper).

Standalone sibling of dump_vectors.py: imports the Python port (the fidelity
reference, itself byte-verified against 1.5/SCORCH.EXE) headless and writes
golden vectors to vectors/weapons.json. The TS differential gate
(test/weapons.test.ts) loads these and asserts src/weapons.ts reproduces every
field exactly. This is a STATIC use of the port; it never runs the DOS binary.

The weapons module is pure static data + a string lookup -- NO rng, NO
transcendental math -- so every emitted value is an int / string / bool / float
that is exactly representable, and the gate asserts all of them with exact
equality (no epsilon needed; see test/weapons.test.ts header).

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../scorch-py" \
        "../.venv/bin/python" oracle/dump_weapons.py
"""
import dataclasses
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
    """Count of leaf assertions the TS gate will make: every scalar field of
    every item, every offensive flag, every slot, every weight entry, and every
    by_name probe (1 hit/miss bool plus the resolved idx when a hit)."""
    total = 0
    items = payload["items"]
    # Per item: idx, name, cost, bundle, arms, category, blast, behavior,
    # warheads, fan, heat, enabled, offensive = 13 scalar fields, plus one
    # assertion per params key (deep-compared) and the params-key-set itself.
    for it in items:
        total += 13
        total += 1                      # params object equality
        total += len(it["params"])      # each params entry
    total += len(payload["slots"])      # named slot constants
    total += 1                          # NUM_ITEMS
    total += 1                          # shield_slots array
    total += len(payload["moron_weights"])  # each weight pair
    for probe in payload["by_name"]:
        total += 1                      # found / not-found
        if probe["idx"] is not None:
            total += 1                  # resolved idx
    return total


# ---------------------------------------------------------------------------
# weapons -- the 48-item equipment table + slot constants + MORON_WEIGHTS +
# by_name. Emit every field of every Item verbatim from the port so the TS side
# is checked against the actual Python values (no hand-transcription).
# ---------------------------------------------------------------------------
def dump_weapons():
    from scorch import weapons as w

    field_names = [f.name for f in dataclasses.fields(w.Item)]

    items = []
    for it in w.ITEMS:
        rec = {fn: getattr(it, fn) for fn in field_names}
        # offensive is a computed @property, not a field; pin it too.
        rec["offensive"] = bool(it.offensive)
        # params is a per-record dict (ints/bools); JSON-serialize as-is.
        rec["params"] = dict(it.params)
        items.append(rec)

    slots = {
        "SLOT_BABY_MISSILE": w.SLOT_BABY_MISSILE,
        "SLOT_MISSILE": w.SLOT_MISSILE,
        "SLOT_PARACHUTE": w.SLOT_PARACHUTE,
        "SLOT_BATTERY": w.SLOT_BATTERY,
        "SLOT_MAG_DEFLECTOR": w.SLOT_MAG_DEFLECTOR,
        "SLOT_SHIELD": w.SLOT_SHIELD,
        "SLOT_FORCE_SHIELD": w.SLOT_FORCE_SHIELD,
        "SLOT_HEAVY_SHIELD": w.SLOT_HEAVY_SHIELD,
        "SLOT_SUPER_MAG": w.SLOT_SUPER_MAG,
        "SLOT_AUTO_DEFENSE": w.SLOT_AUTO_DEFENSE,
        "SLOT_FUEL": w.SLOT_FUEL,
        "SLOT_CONTACT_TRIGGER": w.SLOT_CONTACT_TRIGGER,
    }

    # MORON_WEIGHTS keys are ints; JSON object keys become strings, so emit a
    # list of [idx, weight] pairs to keep the int key + float value exact.
    moron_weights = [[int(k), w.MORON_WEIGHTS[k]] for k in sorted(w.MORON_WEIGHTS)]

    # by_name battery: every exact name, an UPPER and lower and mixed-case
    # variant of each (case-insensitivity is the contract: it.name.lower() ==
    # name.lower()), plus leading/trailing-space and known-miss probes. Each
    # probe records the resolved idx (None on miss).
    probe_names = []
    for it in w.ITEMS:
        probe_names.append(it.name)            # exact
        probe_names.append(it.name.upper())    # all caps
        probe_names.append(it.name.lower())    # all lower
        probe_names.append(it.name.swapcase()) # mixed
    # explicit misses + whitespace sensitivity (by_name does NOT strip)
    probe_names += [
        "", " ", "Missile ", " Missile", "missilE", "Nuke", "nuke",
        "Plasma", "Plasma Laser", "Popcorn", "Dirt Tower", "Death's head",
        "DEATH'S HEAD", "baby missile", "Baby  Missile", "Shield",
        "Force shield", "Super Mag", "super mag", "ContactTrigger",
        "not a weapon", "Tracer\n", "Laser ",
    ]
    by_name = []
    for nm in probe_names:
        hit = w.by_name(nm)
        by_name.append({
            "name": nm,
            "found": hit is not None,
            "idx": (None if hit is None else hit.idx),
        })

    return _write("weapons", {
        "module": "weapons",
        "num_items": w.NUM_ITEMS,
        "field_names": field_names,
        "items": items,
        "slots": slots,
        "shield_slots": list(w.SHIELD_SLOTS),
        "moron_weights": moron_weights,
        "by_name": by_name,
    })


DUMPERS = {
    "weapons": dump_weapons,
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
