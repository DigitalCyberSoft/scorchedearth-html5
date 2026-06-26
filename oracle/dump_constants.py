#!/usr/bin/env python3
"""Oracle vector dumper for the `constants` module (+ a sanity probe of the
`sfx` public surface from sound.py).

Mirrors dump_vectors.py: imports the Python port (the fidelity reference) headless
(SDL_VIDEODRIVER=dummy), reads every public constant straight off the live module
object (no value is hand-transcribed here -- getattr is the source of truth), and
writes golden vectors to vectors/constants.json. The TS differential gate
(test/constants.test.ts) loads this and asserts src/constants.ts reproduces each
value exactly.

This module is pure data + is_dirt()/is_solid(); there is no transcendental math,
so every emitted value is asserted with EXACT equality on the TS side.

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../scorch-py" \
        "../.venv/bin/python" oracle/dump_constants.py
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
    """Assertion count: one per scalar, one per dict entry, one per is_dirt and
    is_solid index. Matches what the TS test actually checks."""
    total = 0
    total += len(payload.get("scalars", {}))
    for d in ("wall_coef", "ai_names"):
        total += len(payload.get(d, {}))
    for arr in ("is_dirt", "is_solid"):
        total += len(payload.get(arr, []))
    total += len(payload.get("sfx_methods", []))
    total += len(payload.get("sfx_attrs", {}))
    return total


# ---------------------------------------------------------------------------
# The scalar contract surface. These names MUST each be an export of
# src/constants.ts; the test imports the TS namespace and asserts
# ns[name] === value for every one. Listed explicitly (the surface IS the
# contract) but every VALUE is read off the live module via getattr below, so
# the golden numbers are never hand-copied here.
# ---------------------------------------------------------------------------
SCALAR_NAMES = [
    # struct strides
    "PROJECTILE_STRIDE", "TANK_STRIDE", "ITEM_STRIDE",
    # physics force model
    "GRAVITY_DEFAULT", "GRAVITY_MIN", "GRAVITY_SCALE", "WIND_SCALE_DIV",
    "FIREDELAY_NORM", "EFF_GRAVITY_FACTOR", "EFF_WIND_FACTOR", "SPEED_CLAMP",
    "SPEED_CLAMP_SQ", "VISCOSITY_DIV", "BOUNCE_ENERGY", "MAX_WIND_DEFAULT",
    # launch
    "POWER_SCALE",
    # timestep
    "DT", "PHYSICS_SUBSTEPS", "PHYSICS_DT",
    # palette cycle
    "PALETTE_CYCLE_HZ",
    # damage / terrain
    "FALLOFF_NUM", "FALL_DMG_PER_PIXEL", "FALL_ON_ENEMY_VICTIM_BONUS",
    "FALL_ON_ENEMY_FALLER_BASE", "PARACHUTE_THRESHOLD_DEFAULT",
    "TANK_FALL_SUPPORT_PIXELS", "DIRECT_HIT_MARKER_DAMAGE", "TANK_DEFAULT_HEALTH",
    # shields
    "MAG_PUSH_VY_NUM", "MAG_PUSH_HALF_W", "MAG_PUSH_HEIGHT_DIV",
    "FORCE_REFLECT_ANGLE_K", "FORCE_REFLECT_RESTITUTION", "FORCE_SHIELD_RING_PAD",
    "SHIELD_FAILURE_CHANCE",
    # palette index bands
    "COL_SKY", "COL_DIRT", "DIRT_SHADE_LO", "DIRT_SHADE_HI", "COL_TANK_BASE",
    "EXPLOSION_LO", "EXPLOSION_HI", "EXPLOSION_RING_BASE", "COL_LASER",
    "COL_TRACER",
    # scoring
    "SCORE_KILL_BASIC", "SCORE_KILL_STD", "SCORE_SELF_KILL",
    "SCORE_TEAMMATE_KILL", "SCORE_SURVIVAL_BASIC_PER", "SCORE_SURVIVAL_STD",
    "SCORE_SHIELD_HIT_MULT",
    # economy
    "INVENTORY_CAP", "FREE_MARKET_DEMAND_DECAY", "FREE_MARKET_NEW",
    "FREE_MARKET_PRICE_STEP", "FREE_MARKET_ACC_RESET", "SELLBACK_MULT_NORMAL",
    "SELLBACK_MULT_FREEMARKET", "INTEREST_RATE_DEFAULT",
    # enums
    "SCORING_BASIC", "SCORING_STANDARD", "SCORING_GREEDY",
    "PLAYORDER_RANDOM", "PLAYORDER_LOSERS", "PLAYORDER_WINNERS", "PLAYORDER_ROBIN",
    "TEAM_NONE", "TEAM_STANDARD", "TEAM_CORPORATE", "TEAM_VICIOUS",
    "PLAYMODE_SEQUENTIAL", "PLAYMODE_SYNCHRONOUS", "PLAYMODE_SIMULTANEOUS",
    "AI_HUMAN", "AI_MORON", "AI_SHOOTER", "AI_POOLSHARK", "AI_TOSSER",
    "AI_CHOOSER", "AI_SPOILER", "AI_CYBORG", "AI_UNKNOWN",
]


def _json_scalar(v):
    """Map a Python scalar to a JSON-safe form. None stays null (TS asserts the
    export === null). Everything else is int/float/bool already, JSON-native."""
    return v


def dump_constants():
    from scorch import constants as c

    # Guard: the contract list must cover every public scalar export of the
    # module so the gate can never silently miss a new constant. A non-callable,
    # non-dunder, UPPER-or-mixed module attribute that is an int/float/bool/None
    # and is NOT one of the dicts/functions we handle separately MUST be listed.
    handled = set(SCALAR_NAMES) | {"WALL_COEF", "AI_NAMES", "is_dirt", "is_solid"}
    missing = []
    for name in dir(c):
        if name.startswith("_"):
            continue
        val = getattr(c, name)
        if callable(val):
            continue
        if isinstance(val, dict):
            if name not in ("WALL_COEF", "AI_NAMES"):
                missing.append(name)
            continue
        if isinstance(val, (int, float, bool)) or val is None:
            if name not in handled:
                missing.append(name)
    if missing:
        # Fail loud: an unported constant would otherwise pass unnoticed.
        raise SystemExit(
            f"dump_constants: module exports not in the contract surface: {missing!r}. "
            f"Add them to SCALAR_NAMES and to src/constants.ts."
        )

    scalars = {}
    for name in SCALAR_NAMES:
        if not hasattr(c, name):
            raise SystemExit(f"dump_constants: constants.{name} missing from the Python module")
        scalars[name] = _json_scalar(getattr(c, name))

    # WALL_COEF: string -> float. Keys preserved as-is.
    wall_coef = {str(k): v for k, v in c.WALL_COEF.items()}

    # AI_NAMES: int -> string. JSON forces string keys; the TS test parses them
    # back to int when indexing the TS dict.
    ai_names = {str(k): v for k, v in c.AI_NAMES.items()}

    # is_dirt / is_solid over the full palette-index range 0..255.
    is_dirt = [bool(c.is_dirt(i)) for i in range(256)]
    is_solid = [bool(c.is_solid(i)) for i in range(256)]

    return _write("constants", {
        "module": "constants",
        "scalars": scalars,
        "wall_coef": wall_coef,
        "ai_names": ai_names,
        "is_dirt": is_dirt,
        "is_solid": is_solid,
        "sfx_methods": _sfx_methods(),
        "sfx_attrs": _sfx_attrs(),
    })


def _sfx_methods():
    """Public callable names on the sfx singleton -- the no-op surface src/sound.ts
    must provide so logic modules can import sfx. The TS test asserts each name is
    a function on the TS sfx."""
    from scorch.sound import sfx
    return sorted(
        n for n in dir(sfx)
        if not n.startswith("_") and callable(getattr(sfx, n))
    )


def _sfx_attrs():
    """Public non-callable attrs on the sfx singleton (enabled / fly_mode /
    field_height) and their default values, asserted exactly on the TS sfx."""
    from scorch.sound import sfx
    out = {}
    for n in dir(sfx):
        if n.startswith("_"):
            continue
        v = getattr(sfx, n)
        if callable(v):
            continue
        out[n] = v
    return out


DUMPERS = {
    "constants": dump_constants,
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
