#!/usr/bin/env python3
"""Oracle vector dumper for the `savegame` module (Save / Restore game).

Drives scorch-py/scorch/savegame.py (the fidelity reference, itself verified
against 1.5/SCORCH.EXE's file framing) over a deterministic battery of
GameStates and writes golden vectors to vectors/savegame.json. The TypeScript
differential gate (test/savegame.test.ts) loads them and asserts src/savegame.ts:

  * serialize(state) byte-stream identity: save() produces bytes IDENTICAL to
    Python's `savegame.save(state, path)` (6-byte magic + u16 LE version + the
    UTF-8 `json.dumps(serialize(state), separators=(",",":"))` body). This is the
    heart of the task: the FULL header+body bytes are recorded (hex) and the TS
    serializer must reproduce them byte-for-byte.
  * load(bytes) round-trip: the recorded blob, fed to the TS loader + applied to a
    matching-roster host, restores to the SAME field values the Python apply()
    produced (asserted exactly: int/index/bool/string/bytes).
  * the header guards: short blob / bad magic / bad version / corrupt body raise
    SaveError with the verbatim guard messages (catalog 18 s3.1).

INT-KEYED DICT ORDER (documented): a victim's hits_this_round / hits_career are
Python dicts keyed by attacker player_index, preserving INSERTION order. The TS
port's live data model (damage.ts) holds them as plain JS objects, which force
ASCENDING integer-key order. So the TS port can only ever serialize these maps in
ascending-key order. This dumper therefore builds the byte-identity battery with
hit maps in ascending insertion order (the order the TS port actually holds), so
the byte assertion exercises the real achievable state space. A separate
non-ascending case is recorded for the ROUND-TRIP assertion only (values restore
correctly regardless of key order); its serialized byte order is a known JS-vs-
CPython divergence reported by the test, not a TS bug.

This is a STATIC use of the port -- it imports and calls pure functions headless
(SDL_VIDEODRIVER=dummy). It never runs the DOS binary.

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="/home/user/Scorched Earth/scorch-py" \
        "/home/user/Scorched Earth/.venv/bin/python" oracle/dump_savegame.py
"""
import json
import os
import sys
import tempfile

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

import numpy as np  # noqa: E402

_HERE = os.path.dirname(os.path.abspath(__file__))
_VECTORS = os.path.join(_HERE, "vectors")
_SCORCH_PY = os.path.normpath(os.path.join(_HERE, "..", "..", "scorch-py"))
if _SCORCH_PY not in sys.path:
    sys.path.insert(0, _SCORCH_PY)

from scorch import savegame, weapons  # noqa: E402
from scorch.config import Config  # noqa: E402
from scorch.game import GameState  # noqa: E402


def _write(module, payload):
    os.makedirs(_VECTORS, exist_ok=True)
    path = os.path.join(_VECTORS, module + ".json")
    with open(path, "w") as fh:
        json.dump(payload, fh)
    n = payload.get("_assertions", 0)
    print(f"  wrote vectors/{module}.json  ({n} assertions)")
    return n


def _save_bytes(state):
    """Exact bytes savegame.save writes, captured from a real temp-file write."""
    fd, path = tempfile.mkstemp(suffix=".sav")
    os.close(fd)
    try:
        savegame.save(state, path)
        with open(path, "rb") as fh:
            return fh.read()
    finally:
        os.remove(path)


def _state_snapshot(gs):
    """The applied-state fields the TS round-trip asserts. Mirrors what apply()
    restores; everything int/index/bool/string/list. The terrain grid is recorded
    as its raw bytes (hex) + shape so byte equality is checked end-to-end."""
    grid = np.ascontiguousarray(gs.terrain.grid, dtype=np.uint8)

    def tank_snap(t):
        gt = getattr(t, "guidance_target", None)
        return {
            "player_index": t.player_index,
            "name": t.name,
            "ai_class": t.ai_class,
            "reveal_type": t.reveal_type,
            "team_id": t.team_id,
            "color": t.color,
            "tank_icon": t.tank_icon,
            "mobile": bool(t.mobile),
            "x": int(t.x),
            "y": int(t.y),
            "half_width": t.half_width,
            "angle": int(t.angle),
            "power": int(t.power),
            "health": t.health,
            "alive": bool(t.alive),
            "shield_hp": t.shield_hp,
            "shield_item": t.shield_item,
            "shield_push": bool(t.shield_push),
            "shield_deflect": bool(t.shield_deflect),
            "shield_laserproof": bool(t.shield_laserproof),
            "shield_failproof": bool(t.shield_failproof),
            "parachute_deployed": bool(t.parachute_deployed),
            "parachute_threshold": t.parachute_threshold,
            "chute_up": t.chute_up,
            "contact_trigger": bool(t.contact_trigger),
            "selected_guidance": t.selected_guidance,
            "guidance_target_index": gt.player_index if gt is not None else None,
            "guidance_target_pt": list(t.guidance_target_pt)
                                  if t.guidance_target_pt is not None else None,
            "cash": t.cash,
            "cash_ceiling": t.cash_ceiling,
            "inventory": list(t.inventory),
            "selected_weapon": t.selected_weapon,
            "fuel_remainder": t.fuel_remainder,
            "score": t.score,
            "win_counter": t.win_counter,
            # sorted pairs so the TS test (whose JS map is ascending) compares the
            # SAME set/order; round-trip value equality is the point here, not the
            # serialized order (that is covered by the byte case).
            "hits_this_round": sorted([int(k), v] for k, v in t.hits_this_round.items()),
            "hits_career": sorted([int(k), v] for k, v in t.hits_career.items()),
            "fall_accum": t.fall_accum,
            "falling": bool(t.falling),
            "ai_tries": t.ai_tries,
            "sim_keys": list(getattr(t, "sim_keys", []) or []),
        }

    return {
        "round_index": gs.round_index,
        "phase": gs.phase,
        "timer": gs.timer,
        "message": gs.message,
        "fire_index": gs.fire_index,
        "firing_order": list(gs.firing_order),
        "current_shooter_index": gs.current_shooter.player_index
                                 if gs.current_shooter is not None else None,
        "last_landing": list(gs.last_landing) if gs.last_landing else None,
        "winner_index": gs.winner.player_index if gs.winner is not None else None,
        "ranking_indices": [t.player_index for t in gs.ranking],
        "w": gs.w,
        "h": gs.h,
        "cfg": {f.name: getattr(gs.cfg, f.name)
                for f in __import__("dataclasses").fields(Config)},
        "_wind": int(gs.cfg.wind),
        "_live_elastic": int(gs.cfg.live_elastic),
        "tanks": [tank_snap(t) for t in gs.tanks],
        "economy": {
            "price": list(gs.economy.price),
            "demand_tally": list(gs.economy.demand_tally),
            "nobuy": list(gs.economy.nobuy),
            "demand_ema": list(gs.economy.demand_ema),
            "ratio_ema": list(gs.economy.ratio_ema),
            "available": [bool(b) for b in gs.economy.available],
        },
        "terrain": {"w": int(grid.shape[0]), "h": int(grid.shape[1]),
                    "hex": grid.tobytes().hex()},
    }


def _mk(cfg_kw, w, h, roster, mutate=None):
    """Build a GameState: cfg overrides, dims, roster of (name,ai,team,icon)."""
    cfg = Config(**cfg_kw)
    gs = GameState(cfg, w, h)
    for (name, ai, team, icon) in roster:
        gs.add_player(name, ai, team, icon)
    if mutate is not None:
        mutate(gs)
    return gs


def _ascending_grid(w, h, mod=251, off=0):
    return ((np.arange(w * h, dtype=np.uint64) + off) % mod).astype(np.uint8).reshape((w, h))


# ===========================================================================
# Battery of GameStates exercising the encoder + framing.
# ===========================================================================
def _battery():
    cases = []

    # --- (1) minimal: defaults, 2 tanks, tiny grid -------------------------
    def m1(gs):
        gs.terrain.grid = _ascending_grid(16, 12)
    cases.append(("minimal_defaults", _mk({}, 16, 12,
                  [("Alice", 0, 0, 0), ("Bob", 2, 1, 1)], m1)))

    # --- (2) floats everywhere: non-default cfg floats + economy EMAs ------
    def m2(gs):
        gs.timer = 0.6                       # AI_TURN_DELAY (Python float)
        # economy float EMAs to messy doubles
        gs.economy.demand_ema = [0.1 + i * 0.013 for i in range(weapons.NUM_ITEMS)]
        gs.economy.ratio_ema = [(i + 1) / 7.0 for i in range(weapons.NUM_ITEMS)]
        gs.terrain.grid = _ascending_grid(20, 15, off=3)
    cases.append(("cfg_floats_economy", _mk(
        {"INTEREST_RATE": 0.07, "GRAVITY": 0.35, "MTN_PERCENT": 12.5,
         "MOUSE_RATE": 0.25, "FREE_MARKET": "ON"},
        20, 15, [("P1", 1, 0, 0), ("P2", 0, 0, 1), ("P3", 8, 2, 2)], m2)))

    # --- (3) unicode + control-char + escape-bearing names -----------------
    def m3(gs):
        gs.message = 'round "1" \\ done\n\t<\x01\x1f\x7f ☃\U0001f600>'
        gs.terrain.grid = _ascending_grid(12, 10, off=100)
    cases.append(("unicode_escapes", _mk({}, 12, 10, [
        ("Zoë", 3, 1, 2),
        ('ctrl\x01\x1f"\\name', 0, 0, 0),
        ("emoji\U0001f600tank", 5, 0, 1),
        ("☃snow man", 7, 1, 2),
    ], m3)))

    # --- (4) populated mid-game: hits maps (ascending insertion), guidance,
    #         ranking, firing order, last_landing, inventory, shields ---------
    def m4(gs):
        gs.round_index = 4
        gs.phase = "settle"
        gs.timer = 0.0
        gs.fire_index = 2
        gs.firing_order = [2, 0, 3, 1]
        gs.last_landing = (123, 45)
        gs.current_shooter = gs.tanks[1]
        gs.winner = None
        gs.ranking = [gs.tanks[3], gs.tanks[1], gs.tanks[0], gs.tanks[2]]
        t0 = gs.tanks[0]
        # ascending insertion order (matches the TS plain-object ordering)
        t0.hits_this_round = {0: 3, 1: 1, 2: 5}
        t0.hits_career = {0: 9, 1: 2, 3: 7}
        t0.guidance_target = gs.tanks[2]
        t0.guidance_target_pt = (10, 20)
        t0.shield_hp = 100
        t0.shield_item = weapons.SHIELD_SLOTS[0]
        t0.shield_push = True
        t0.inventory[weapons.SLOT_MISSILE] = 17
        t0.inventory[5] = 99
        t0.cash = 123456
        t0.cash_ceiling = 5000
        t0.score = -2000
        t0.win_counter = 3
        t0.health = 42
        t0.fall_accum = 0
        t0.angle = 137
        t0.power = 814
        t0.x = 200
        t0.y = 350
        gs.tanks[2].alive = False
        gs.terrain.grid = _ascending_grid(40, 30, off=7)
    cases.append(("midgame_populated", _mk(
        {"ARMS": 4, "TEAM_MODE": "STANDARD", "PLAY_MODE": "SEQUENTIAL"},
        40, 30, [("A", 0, 0, 0), ("B", 1, 1, 1), ("C", 2, 0, 2), ("D", 8, 1, 3)], m4)))

    # --- (5) single tank, empty grid edge (w*h not a multiple of 3 b64) -----
    def m5(gs):
        gs.terrain.grid = _ascending_grid(1, 1)   # 1 byte -> b64 "AA=="
    cases.append(("single_tank_1px", _mk({}, 1, 1, [("Solo", 0, 0, 0)], m5)))

    # --- (6) b64 length classes: grids whose byte count % 3 == 0,1,2 --------
    for (w, h, tag) in [(3, 1, "mod0"), (4, 1, "mod1"), (5, 1, "mod2")]:
        def m6(gs, w=w, h=h):
            # values include 251..255 so base64 hits the +/ alphabet chars
            gs.terrain.grid = ((np.arange(w * h, dtype=np.uint64) + 250)
                               % 256).astype(np.uint8).reshape((w, h))
        cases.append((f"b64_{tag}", _mk({}, w, h, [("g", 0, 0, 0), ("h", 0, 0, 0)], m6)))

    # --- (7) all-cfg-non-default: every enum/int/float field off its default
    def m7(gs):
        gs.terrain.grid = _ascending_grid(8, 8, off=42)
    cases.append(("cfg_all_nondefault", _mk({
        "MAXPLAYERS": 4, "MAXROUNDS": 25, "ARMS": 2, "PLAY_MODE": "SIMULTANEOUS",
        "PLAY_ORDER": "ROUND-ROBIN", "TEAM_MODE": "VICIOUS",
        "HOSTILE_ENVIRONMENT": "OFF", "TUNNELLING": "ON", "USELESS_ITEMS": "OFF",
        "EXPLOSION_SCALE": "LARGE", "INITIAL_CASH": 50000, "INTEREST_RATE": 0.123,
        "COMPUTERS_BUY": "OFF", "FREE_MARKET": "ON", "SCORING": "GREEDY",
        "GRAVITY": 9.81, "AIR_VISCOSITY": 17, "MAX_WIND": 150, "CHANGING_WIND": "ON",
        "ELASTIC": "ERRATIC", "FALLING_TANKS": "OFF", "EDGES_EXTEND": 120,
        "DAMAGE_TANKS_ON_IMPACT": "OFF", "LAND1": 55, "LAND2": 80, "FLATLAND": "OFF",
        "RANDOM_LAND": "OFF", "MTN_PERCENT": 33.75, "SUSPEND_DIRT": 10,
        "EXTRA_DIRT": "ON", "SKY": "PLAIN", "GRAPHICS_MODE": "640x480",
        "LOWMEM": "ON", "FIRE_DELAY": 250, "FALLING_DELAY": 25, "STATUS_BAR": "ON",
        "ICON_BAR": "OFF", "BOMB_ICON": "SMALL", "TRACE": "ON", "FAST_COMPUTERS": "ON",
        "BIOS_KEYBOARD": "ON", "POINTER": "Keyboard", "MOUSE_RATE": 0.875,
        "SOUND": "OFF", "FLY_SOUND": "ON", "TALKING_TANKS": "ON",
        "TALK_PROBABILITY": 75, "TALK_DELAY": 30, "ATTACK_COMMENTS": "custom1.cfg",
        "DIE_COMMENTS": "custom2.cfg",
    }, 8, 8, [("w", 0, 0, 0), ("x", 0, 0, 0)], m7)))

    return cases


# ===========================================================================
# Non-ascending hit-map case: round-trip ONLY (value equality), to document the
# JS-vs-CPython key-order divergence. The TS test asserts the restored values
# match (order-independent) and records the byte-order divergence.
# ===========================================================================
def _nonascending_case():
    gs = _mk({}, 8, 6, [("A", 0, 0, 0), ("B", 0, 1, 1), ("C", 0, 0, 2), ("D", 0, 1, 3)])
    t = gs.tanks[0]
    t.hits_this_round = {3: 2, 0: 1, 2: 4}     # non-ascending insertion
    t.hits_career = {2: 9, 0: 3, 1: 1}
    gs.terrain.grid = _ascending_grid(8, 6)
    blob = _save_bytes(gs)
    # what the Python serializer actually emits (insertion order) -- the TS
    # serializer for the equivalent JS state emits ascending; recorded for the
    # divergence note, NOT asserted as equal.
    py_body = json.dumps(savegame.serialize(gs), separators=(",", ":"))
    # the restored snapshot (apply into a fresh matching-roster GameState).
    # load() is path-based; reproduce its parse from the blob directly here.
    body = blob[savegame._HEADER_LEN:]
    restored_data = json.loads(body.decode("utf-8"))
    gs2 = _mk({}, 8, 6, [("a", 0, 0, 0), ("b", 0, 0, 1), ("c", 0, 0, 2), ("d", 0, 0, 3)])
    savegame.apply(restored_data, gs2)
    return {
        "blob_hex": blob.hex(),
        "py_body": py_body,
        "restored": _state_snapshot(gs2),
    }


def dump_savegame():
    bytes_cases = []
    roundtrip_cases = []
    n = 0
    for (name, gs) in _battery():
        blob = _save_bytes(gs)
        # presave: the snapshot of the ORIGINAL state, so the TS test can
        # reconstruct the exact pre-save host and re-serialize it to the SAME
        # bytes. This differs from the round-trip snapshot wherever the Python
        # apply() is asymmetric with save() -- notably _live_elastic, which save()
        # writes from cfg.live_elastic but _cfg_from_dict never reads back (it
        # looks for "_live_elastic" in the INNER cfg dict, where it is absent), so
        # a restored state carries live_elastic from the rebuilt Config's
        # __post_init__ (default 0), NOT the saved value. The byte test must use
        # the PRE-save state; the round-trip test must use the POST-apply state.
        bytes_cases.append({"name": name, "blob_hex": blob.hex(),
                            "presave": _state_snapshot(gs)})
        # the applied snapshot, via a fresh matching-roster host
        body = blob[savegame._HEADER_LEN:]
        data = json.loads(body.decode("utf-8"))
        roster = [(t.name, t.ai_class, t.team_id, t.tank_icon) for t in gs.tanks]
        gs2 = _mk({}, gs.w, gs.h, [(f"slot{i}", 0, 0, 0) for i in range(len(roster))])
        savegame.apply(data, gs2)
        roundtrip_cases.append({"name": name, "restored": _state_snapshot(gs2)})
        n += 2

    # header guard fixtures: build off a known-good blob, then corrupt it.
    good = _save_bytes(_mk({}, 4, 4, [("a", 0, 0, 0), ("b", 0, 0, 0)]))
    short = good[:5]
    bad_magic = bytearray(good)
    bad_magic[0] = ord("X")
    bad_version = bytearray(good)
    bad_version[6] = 0x99           # version word low byte != 1
    corrupt_body = good[:savegame._HEADER_LEN] + b"\xff\xfe not json \x80"
    guards = {
        "good_hex": good.hex(),
        "short_hex": bytes(short).hex(),
        "bad_magic_hex": bytes(bad_magic).hex(),
        "bad_version_hex": bytes(bad_version).hex(),
        "corrupt_body_hex": bytes(corrupt_body).hex(),
        # the verbatim guard messages with name="" (the TS test calls load(bytes))
        "msg_not_saved": '"" is not a saved game.',
        "msg_diff_version": 'File "" was created by a different version.',
        "msg_corrupt": '"" is a corrupt saved game.',
    }
    n += 4

    # constants the TS module must agree on
    consts = {
        "MAGIC": list(savegame.MAGIC),         # bytes -> list of ints
        "SAVE_VERSION": savegame.SAVE_VERSION,
        "HEADER_LEN": savegame._HEADER_LEN,
        "NUM_ITEMS": weapons.NUM_ITEMS,
    }
    n += len(consts)

    non_asc = _nonascending_case()
    n += 1

    return _write("savegame", {
        "module": "savegame",
        "_assertions": n,
        "consts": consts,
        "bytes": bytes_cases,
        "roundtrip": roundtrip_cases,
        "guards": guards,
        "nonascending": non_asc,
    })


DUMPERS = {"savegame": dump_savegame}


def main():
    which = sys.argv[1:] or list(DUMPERS)
    total = 0
    print(f"Oracle: dumping {', '.join(which)} (port = {_SCORCH_PY})")
    for nm in which:
        if nm not in DUMPERS:
            print(f"  ! unknown module: {nm}", file=sys.stderr)
            continue
        total += DUMPERS[nm]()
    print(f"Done. ~{total} golden assertions across {len(which)} module(s).")


if __name__ == "__main__":
    main()
