#!/usr/bin/env python3
"""Oracle vector dumper for the `config` module.

Drives scorch/config.py (the fidelity reference) over a deterministic input battery
and writes golden vectors to vectors/config.json. The TS differential gate
(test/config.test.ts) loads them and asserts src/config.ts reproduces every result
exactly (config has no transcendental math; all outputs are int/float/bool/string and
are matched exactly).

Standalone, mirrors dump_vectors.py structure. Static use of the port: imports and
calls pure functions headless (SDL_VIDEODRIVER=dummy). Never runs the DOS binary.

config.load/save are path-based (filesystem). The TS port is string-based (browser, no
fs). To keep the Python side UNMODIFIED, this dumper drives the real path API: it writes
each cfg body to a temp file, calls Config.load(path), and for save() it calls
cfg.save(path) then reads the file back -- yielding the exact string the TS load() input
/ save() output must equal.

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="/home/user/Scorched Earth/scorch-py" \
        "/home/user/Scorched Earth/.venv/bin/python" oracle/dump_config.py
"""
import json
import math
import os
import sys
import tempfile

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

_HERE = os.path.dirname(os.path.abspath(__file__))
_VECTORS = os.path.join(_HERE, "vectors")
_SCORCH_PY = os.path.normpath(os.path.join(_HERE, "..", "..", "scorch-py"))
if _SCORCH_PY not in sys.path:
    sys.path.insert(0, _SCORCH_PY)

# The real shipped scorch.cfg (scorch-py/scorch.cfg) -- a primary load fixture.
_REAL_CFG = os.path.join(_SCORCH_PY, "scorch.cfg")


def _jsonable(v):
    """Map a Python config value to a JSON-safe form the TS side can compare.

    floats inf/-inf/nan are not valid JSON; encode them as tagged strings the TS test
    decodes back to the same JS values. Everything else (int, finite float, str, bool)
    is JSON-native.
    """
    if isinstance(v, float):
        if math.isinf(v):
            return "Infinity" if v > 0 else "-Infinity"
        if math.isnan(v):
            return "NaN"
        return v
    return v


def _write(module, payload):
    os.makedirs(_VECTORS, exist_ok=True)
    path = os.path.join(_VECTORS, module + ".json")
    with open(path, "w") as fh:
        json.dump(payload, fh, indent=0)
    n = _count(payload)
    print(f"  wrote vectors/{module}.json  ({n} assertions)")
    return n


def _count(payload):
    """Count leaf assertions the TS gate will make (one per recorded expected value)."""
    total = 0

    def walk(x):
        nonlocal total
        if isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
        else:
            total += 1

    # Count only the "expected output" sub-trees, not the input echoes, to report a
    # realistic assertion number. Each section stores its expecteds under known keys.
    for section in payload.get("_assert_roots", []):
        walk(payload.get(section))
    return total


def _load_from_text(Config, text):
    """Drive the REAL path-based Config.load against an in-memory cfg body."""
    fd, p = tempfile.mkstemp(suffix=".cfg", dir="/tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
        return Config.load(p)
    finally:
        os.unlink(p)


def _save_to_text(cfg):
    """Drive the REAL path-based Config.save and read back the written body."""
    fd, p = tempfile.mkstemp(suffix=".cfg", dir="/tmp")
    try:
        os.close(fd)
        cfg.save(p)
        with open(p) as fh:
            return fh.read()
    finally:
        os.unlink(p)


def dump_config():
    from scorch import config as cfgmod
    from dataclasses import fields

    Config = cfgmod.Config

    # ---- 1. default field values (exact) --------------------------------------
    default_cfg = Config()
    defaults = {f.name: _jsonable(getattr(default_cfg, f.name)) for f in fields(Config)}
    # Field declaration order (== save() write order == TS CONFIG_FIELDS order).
    field_order = [f.name for f in fields(Config)]
    field_types = {f.name: f.type.__name__ for f in fields(Config)}
    # Live __post_init__ globals.
    post_init = {"wind": default_cfg.wind, "live_elastic": default_cfg.live_elastic}

    # ---- 2. enum maps (exact ordering) ----------------------------------------
    enum_maps = {
        "SCORING": cfgmod.SCORING,
        "TEAM_MODE": cfgmod.TEAM_MODE,
        "PLAY_MODE": cfgmod.PLAY_MODE,
        "PLAY_ORDER": cfgmod.PLAY_ORDER,
        "ELASTIC": cfgmod.ELASTIC,
        "EXPLOSION_SCALE": cfgmod.EXPLOSION_SCALE,
    }

    # ---- 3. derived enum-index properties, incl. unknown-token fallback -------
    # Each entry sets the underlying string field then reads the derived index. Covers
    # exact tokens, lowercase/mixedcase (.upper() path), and unknowns (-> default).
    prop_cases = []
    prop_specs = [
        ("SCORING", "scoring",
         ["BASIC", "STANDARD", "GREEDY", "basic", "Greedy", "bogus", "", "standard "]),
        ("TEAM_MODE", "team_mode",
         ["NONE", "STANDARD", "CORPORATE", "VICIOUS", "none", "Vicious", "xyz", ""]),
        ("PLAY_MODE", "play_mode",
         ["SEQUENTIAL", "SYNCHRONOUS", "SIMULTANEOUS", "sequential", "Simultaneous", "nope"]),
        ("PLAY_ORDER", "play_order",
         ["RANDOM", "LOSERS-FIRST", "WINNERS-FIRST", "ROUND-ROBIN",
          "random", "Round-Robin", "first"]),
        ("ELASTIC", "elastic",
         ["NONE", "WRAP", "PADDED", "RUBBER", "SPRING", "CONCRETE", "RANDOM", "ERRATIC",
          "concrete", "Wrap", "bounce", ""]),
        ("EXPLOSION_SCALE", "explosion_scale",
         ["NORMAL", "MEDIUM", "LARGE", "normal", "Large", "huge"]),
    ]
    for field_name, prop_name, tokens in prop_specs:
        for tok in tokens:
            c = Config()
            setattr(c, field_name, tok)
            prop_cases.append({
                "field": field_name,
                "prop": prop_name,
                "token": tok,
                "value": getattr(c, prop_name),
            })

    # ---- 4. is_on over ON/OFF/other-cased values ------------------------------
    is_on_cases = []
    ison_specs = [
        ("HOSTILE_ENVIRONMENT", ["ON", "OFF", "on", "Off", "oN", "anything", ""]),
        ("SOUND", ["ON", "off", "On"]),
        ("TRACE", ["OFF", "ON"]),
        ("FALLING_TANKS", ["ON", "OFF", " on ", "ON "]),  # str() then .upper(); no strip
    ]
    for field_name, vals in ison_specs:
        for v in vals:
            c = Config()
            setattr(c, field_name, v)
            is_on_cases.append({"field": field_name, "value": v, "out": c.is_on(field_name)})
    # is_on against a numeric field (str(int).upper() != "ON" always).
    for field_name in ("MAXPLAYERS", "FIRE_DELAY"):
        c = Config()
        is_on_cases.append({"field": field_name, "value": getattr(c, field_name),
                            "out": c.is_on(field_name)})

    # ---- 5. resolution parsing -------------------------------------------------
    res_cases = []
    RES_TOKENS = [
        "1024x768", "640x480", "800x600", "640X480", "1024X768", "1280x1024",
        "320x200", "100x200", " 100 x 200 ", "1x1",
        # malformed -> fallback (1024,768)
        "abc", "1024", "1024x768x32", "x", "12x", "x34", "1024x", "x768",
        "12.5x34", "10ax20", "0x10", "1e3x2", "1_024x768", "", "  ",
        "1024xx768", "-5x-6",
    ]
    for tok in RES_TOKENS:
        c = Config()
        c.GRAPHICS_MODE = tok
        res_cases.append({"GRAPHICS_MODE": tok, "out": list(c.resolution)})

    # ---- 6. viscosity_mult over full AIR_VISCOSITY range ----------------------
    visc_cases = []
    for v in list(range(0, 21)) + [-1, 50, 100, 10000, 5000, 9999, 12345]:
        c = Config()
        c.AIR_VISCOSITY = v
        visc_cases.append({"AIR_VISCOSITY": v, "out": _jsonable(c.viscosity_mult)})

    # ---- 7. _coerce string->value battery (the core fidelity surface) ---------
    # int and float parsing must match Python's int()/float() exactly (JS coercion
    # differs sharply). 0/0.0 fallback on reject.
    coerce_cases = []
    INT_INPUTS = [
        "0", "42", "-5", "  7  ", "007", "1000000", "abc", "12.5", "0x10", "1e3",
        "+9", "", "  ", "1_000", "_1", "1_", "1__0", "_", "1_2_3", "12_", "0_0",
        "- 5", "+ 5", "\t10\n", "10 ", "999999", "-0", "+0", "100", "0000", "1.0",
        "  -123  ", "9_8_7_6", "0b101", "  ", "true", "None",
    ]
    for s in INT_INPUTS:
        coerce_cases.append({"type": "int", "in": s,
                             "out": _jsonable(cfgmod._coerce(int, s))})
    FLOAT_INPUTS = [
        "0.05", "1", "-1.5", "  3.14 ", "1e3", "1E-2", "inf", "-inf", "nan", "abc",
        "", ".5", "5.", "1_000.5", "0x1p4", "+2.0", "Infinity", "INFINITY", "NaN",
        "+nan", "-NaN", "1.0e_3", "1.0_e3", ".", "e3", "1.0.0", "  inf  ", "_1.0",
        "1.0_", "1_.0", "1._0", "0.0", "-0.0", "2e10", "1.5E+3", "123.456", "0.000001",
        "1e-7", "1e20", "100000.0", "  -2.5e-3 ", "3.", ".3", "  ", "+inf", "1__0.0",
    ]
    for s in FLOAT_INPUTS:
        coerce_cases.append({"type": "float", "in": s,
                             "out": _jsonable(cfgmod._coerce(float, s))})
    # str type passthrough.
    for s in ["ON", "off", "Mouse", "talk1.cfg", "anything goes", "", "  spaced  "]:
        coerce_cases.append({"type": "str", "in": s,
                             "out": cfgmod._coerce(str, s)})

    # ---- 8. load() of cfg bodies (real shipped cfg + synthetics) --------------
    load_cases = []

    def add_load(label, text):
        cfg = _load_from_text(Config, text)
        parsed = {f.name: _jsonable(getattr(cfg, f.name)) for f in fields(Config)}
        load_cases.append({
            "label": label,
            "text": text,
            "parsed": parsed,
            "post_init": {"wind": cfg.wind, "live_elastic": cfg.live_elastic},
            # also capture derived props that depend on parsed string fields
            "derived": {
                "scoring": cfg.scoring,
                "team_mode": cfg.team_mode,
                "play_mode": cfg.play_mode,
                "play_order": cfg.play_order,
                "elastic": cfg.elastic,
                "explosion_scale": cfg.explosion_scale,
                "resolution": list(cfg.resolution),
                "viscosity_mult": _jsonable(cfg.viscosity_mult),
            },
        })

    # 8a. The real shipped scorch.cfg (primary fixture). Its STATUS_BAR=ON and
    # TALKING_TANKS=ALL differ from the dataclass defaults -> proves load overrides.
    if os.path.exists(_REAL_CFG):
        with open(_REAL_CFG) as fh:
            add_load("real_scorch.cfg", fh.read())

    # 8b. empty body -> all defaults.
    add_load("empty", "")
    # 8c. comments + blanks only -> all defaults.
    add_load("comments_only", "; header\n;another\n\n   \n")
    # 8d. case-insensitive keys, surrounding whitespace, mixed enums.
    add_load("mixed_case_ws", "\n".join([
        "maxplayers = 8",
        "  ARMS=2  ",
        "play_mode=simultaneous",
        "Team_Mode=Corporate",
        "ELASTIC=concrete",
        "gravity=10",
        "interest_rate=0.125",
        "Mtn_Percent=55.5",
        "air_viscosity=20",
        "graphics_mode=640x480",
        "scoring=greedy",
    ]))
    # 8e. unknown keys ignored; lines without '=' ignored; leading ';' ignored.
    add_load("unknown_and_noise", "\n".join([
        "BOGUS_KEY=123",
        "noequalshere",
        ";SOUND=OFF",
        "SOUND=OFF",
        "=emptkey",
        "MAXROUNDS=99",
    ]))
    # 8f. malformed numeric values -> _coerce 0/0.0 fallback.
    add_load("bad_numbers", "\n".join([
        "MAXPLAYERS=abc",
        "INITIAL_CASH=12.5",
        "GRAVITY=notanumber",
        "INTEREST_RATE=1e-2",
        "AIR_VISCOSITY=0x10",
        "MTN_PERCENT=inf",
        "FIRE_DELAY=1_000",
        "TALK_PROBABILITY=-50",
    ]))
    # 8g. inline-equals in value (partition keeps only first '='): KEY=a=b -> "a=b".
    add_load("equals_in_value", "\n".join([
        "POINTER=a=b=c",
        "ATTACK_COMMENTS=talk=weird.cfg",
        "DIE_COMMENTS=x",
    ]))
    # 8h. every string field set to a non-default to exercise full setattr coverage.
    add_load("all_strings", "\n".join([
        "PLAY_MODE=SYNCHRONOUS", "PLAY_ORDER=ROUND-ROBIN", "TEAM_MODE=VICIOUS",
        "HOSTILE_ENVIRONMENT=OFF", "TUNNELLING=ON", "USELESS_ITEMS=OFF",
        "EXPLOSION_SCALE=LARGE", "COMPUTERS_BUY=OFF", "FREE_MARKET=ON",
        "SCORING=BASIC", "CHANGING_WIND=ON", "ELASTIC=ERRATIC", "FALLING_TANKS=OFF",
        "DAMAGE_TANKS_ON_IMPACT=OFF", "FLATLAND=OFF", "RANDOM_LAND=OFF",
        "EXTRA_DIRT=ON", "SKY=BLUE", "GRAPHICS_MODE=800x600", "LOWMEM=ON",
        "STATUS_BAR=ON", "ICON_BAR=OFF", "BOMB_ICON=SMALL", "TRACE=ON",
        "FAST_COMPUTERS=ON", "BIOS_KEYBOARD=ON", "POINTER=Keyboard",
        "SOUND=OFF", "FLY_SOUND=ON", "TALKING_TANKS=ALL",
        "ATTACK_COMMENTS=a.cfg", "DIE_COMMENTS=b.cfg",
    ]))
    # 8i. \r\n line endings (readlines/strip must tolerate).
    add_load("crlf", "MAXPLAYERS=3\r\nMAXROUNDS=7\r\nSOUND=OFF\r\n")
    # 8j. trailing whitespace / tabs around key and value.
    add_load("tabs_and_spaces", "\tMAXPLAYERS\t=\t6\t\nARMS =\t1\n")

    # ---- 9. save() output (exact byte body) -----------------------------------
    save_cases = []

    def add_save(label, mutator):
        c = Config()
        mutator(c)
        body = _save_to_text(c)
        save_cases.append({"label": label, "body": body})

    # 9a. defaults.
    add_save("defaults", lambda c: None)

    # 9b. mutate a spread of int/float/str fields (checks float-vs-int rendering:
    # MTN_PERCENT stays a float -> "X.0"; LAND1 int -> "X").
    def _mut(c):
        c.MAXPLAYERS = 8
        c.MTN_PERCENT = 33.0
        c.INTEREST_RATE = 0.125
        c.GRAVITY = 5.5
        c.LAND1 = 99
        c.SOUND = "OFF"
        c.GRAPHICS_MODE = "640x480"
        c.MOUSE_RATE = 0.25
    add_save("mutated", _mut)

    # 9c. round-trip: load the real cfg then save -- the saved body is what TS save()
    # must produce from the loaded Config.
    if os.path.exists(_REAL_CFG):
        with open(_REAL_CFG) as fh:
            real_text = fh.read()
        loaded = _load_from_text(Config, real_text)
        save_cases.append({"label": "roundtrip_real", "body": _save_to_text(loaded)})

    # 9d. float-rendering stress: set float fields to values that probe CPython repr
    # vs JS toString thresholds (integer-valued float, small, exact, repeating).
    for label, fv in [
        ("float_20", 20.0), ("float_p05", 0.05), ("float_third", 1.0 / 3.0),
        ("float_big", 123456.789), ("float_tiny", 0.0001),
    ]:
        def make(fv):
            def m(c):
                c.MTN_PERCENT = fv
                c.INTEREST_RATE = fv
                c.GRAVITY = fv
                c.MOUSE_RATE = fv
            return m
        add_save(f"save_{label}", make(fv))

    payload = {
        "module": "config",
        "defaults": defaults,
        "field_order": field_order,
        "field_types": field_types,
        "post_init": post_init,
        "enum_maps": enum_maps,
        "prop_cases": prop_cases,
        "is_on_cases": is_on_cases,
        "res_cases": res_cases,
        "visc_cases": visc_cases,
        "coerce_cases": coerce_cases,
        "load_cases": load_cases,
        "save_cases": save_cases,
        # roots the _count walker treats as expected-value trees
        "_assert_roots": [
            "defaults", "post_init", "enum_maps", "prop_cases", "is_on_cases",
            "res_cases", "visc_cases", "coerce_cases", "load_cases", "save_cases",
        ],
    }
    return _write("config", payload)


DUMPERS = {
    "config": dump_config,
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
