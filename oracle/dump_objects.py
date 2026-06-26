#!/usr/bin/env python3
"""Oracle vector dumper for the `objects` module (Projectile + Tank/Player models,
struct strides 0x6c / 0xca).

Standalone sibling of dump_vectors.py: imports the Python port (the fidelity
reference, itself byte-verified against 1.5/SCORCH.EXE) headless and writes golden
vectors to vectors/objects.json. The TS differential gate (test/objects.test.ts)
loads these and asserts src/objects.ts reproduces every field / method output.
This is a STATIC use of the port; it never runs the DOS binary.

The objects module has NO transcendental math (no sin/cos/pow/sqrt/atan2) and NO
rng of its own. Every emitted value is an int / exactly-representable float / bool
/ string / structural descriptor, so the gate asserts ALL of them with EXACT
equality (no epsilon; see test/objects.test.ts header).

THE ONE NUMERIC GOTCHA: Projectile.__init__ does sx=int(round(px)), sy=int(round(py)).
Python 3 round() is round-half-to-EVEN. The px/py battery below DELIBERATELY hits
exact .5 ties (0.5, 1.5, 2.5, 99.5, 100.5, ...) plus near-tie doubles so the TS
port's pyRound() is exercised against CPython's banker's rounding, where JS
Math.round would diverge.

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../scorch-py" \
        "../.venv/bin/python" oracle/dump_objects.py
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
    """Leaf-assertion count the TS gate will make."""
    total = 0
    # pyRound battery: one per value.
    total += len(payload["pyround"])
    # Projectiles: 27 emitted leaves per record (see _proj_record keys).
    for rec in payload["projectiles"]:
        total += len(rec)
    # Tanks: every emitted leaf per record.
    for rec in payload["tanks"]:
        total += _count_leaves(rec)
    # has_ammo probes.
    for rec in payload["has_ammo"]:
        total += len(rec["out"])
    # consume sequences: one inventory-snapshot vector per step.
    for rec in payload["consume"]:
        for step in rec["steps"]:
            total += 1                       # the slot value after consume
            total += 1                       # has_ammo after
    # fuel / parachutes / batteries property battery.
    for rec in payload["props"]:
        total += 3
    return total


def _count_leaves(rec):
    n = 0
    for v in rec.values():
        if isinstance(v, list):
            n += len(v) if v else 1
        else:
            n += 1
    return n


def _proj_record(p):
    """Serialize every Projectile field. Scalars verbatim; references reduced to
    structural descriptors the TS side can re-derive and assert."""
    return {
        # floats (exact; pure assignment, no transcendental)
        "vx": p.vx,
        "vy": p.vy,
        "px": p.px,
        "py": p.py,
        # THE rounded ints (banker's rounding -- the gotcha)
        "sx": p.sx,
        "sy": p.sy,
        "prev_px": p.prev_px,
        "prev_py": p.prev_py,
        "saved_vx": p.saved_vx,
        "saved_vy": p.saved_vy,
        "weapon_idx": p.weapon.idx,          # weapon reference -> idx
        "weapon_type": p.weapon_type,
        "owner_index": p.owner_index,
        "owner_is_none": p.owner is None,
        "active": bool(p.active),
        "mode": p.mode,
        "flags": p.flags,
        "bounce_energy": p.bounce_energy,
        "bounce_count": p.bounce_count,
        "spring_armed": bool(p.spring_armed),
        "warheads_left": p.warheads_left,
        "guidance_is_none": p.guidance is None,
        "target_is_none": p.target is None,
        "state_empty": (p.state == {}),
        "trail_len": len(p.trail),
        "armed": bool(p.armed),
        "split_done": bool(p.split_done),
        "contact": bool(p.contact),
    }


def _tank_record(t):
    """Serialize every Tank field. Scalars verbatim; references reduced to
    structural descriptors. Field NAMES are part of the contract (downstream
    physics/ai/weapons read them), so the key set is asserted too."""
    return {
        "player_index": t.player_index,
        "name": t.name,
        "ai_class": t.ai_class,
        "reveal_type": t.reveal_type,
        "team_id": t.team_id,
        "color": t.color,
        "tank_icon": t.tank_icon,
        "mobile": bool(t.mobile),
        "x": t.x,
        "y": t.y,
        "half_width": t.half_width,
        "angle": t.angle,
        "power": t.power,
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
        "selected_guidance_is_none": t.selected_guidance is None,
        "guidance_target_is_none": t.guidance_target is None,
        "guidance_target_pt_is_none": t.guidance_target_pt is None,
        "cash": t.cash,
        "cash_ceiling": t.cash_ceiling,
        "inventory": list(t.inventory),       # full per-item count vector
        "inventory_len": len(t.inventory),
        "selected_weapon": t.selected_weapon,
        "fuel_remainder": t.fuel_remainder,
        "score": t.score,
        "win_counter": t.win_counter,
        "hits_this_round_empty": (t.hits_this_round == {}),
        "hits_career_empty": (t.hits_career == {}),
        "fall_accum": t.fall_accum,
        "falling": bool(t.falling),
        "ai_tries": t.ai_tries,
        "ai_saved_tactic_is_none": t.ai_saved_tactic is None,
        # the computed properties at construction time (default inventory)
        "fuel": t.fuel,
        "parachutes": t.parachutes,
        "batteries": t.batteries,
    }


def dump_objects():
    from scorch import rng as rngmod
    from scorch import objects
    from scorch import weapons as w

    # -----------------------------------------------------------------------
    # pyRound oracle: the Projectile sx/sy rounding is int(round(x)). Emit a
    # dense battery of round(x) so the TS pyRound() is proven == CPython round
    # over ties (.5 -> even), near-ties, negatives, and large magnitudes.
    # -----------------------------------------------------------------------
    pyround_vals = []
    # exact half-integer ties across a wide signed range (even/odd floor both)
    for i in range(-20, 21):
        pyround_vals.append(i + 0.5)
        pyround_vals.append(float(i))
    # near-tie doubles (the largest double strictly below .5 and above .5)
    for base in (0, 1, 2, 3, 4, 99, 100, 101, 1000, 12345, 12346):
        for off in (0.49999999999999994, 0.5, 0.5000000000000001,
                    0.25, 0.75, 0.1, 0.9, 0.0):
            pyround_vals.append(base + off)
            pyround_vals.append(-(base + off))
    # a deterministic rng-driven spread (mix of integers and fractions) so the
    # battery is broad, seeded so TS (new Rng(seed)) reproduces it identically.
    r = rngmod.Rng(20240626)
    for _ in range(300):
        v = r.uniform(-2000.0, 2000.0)
        pyround_vals.append(v)
    pyround = [{"x": x, "round": round(x)} for x in pyround_vals]

    # -----------------------------------------------------------------------
    # Projectiles: cover the full owner/weapon/px-py/vx-vy space. Especially the
    # sx/sy rounding (px,py chosen to land on .5 ties). owner=None and owner=Tank
    # both exercised (owner_index branch). Every weapon idx used (warheads_left).
    # -----------------------------------------------------------------------
    # A pool of distinct owners with distinct player_index values.
    owners = [None]
    for pidx in (0, 1, 2, 3, 7):
        owners.append(objects.Tank(pidx, f"P{pidx}", ai_class=pidx % 4))

    # px/py battery: deliberate .5 ties + near-ties + ordinary fractions, signed.
    coords = [
        0.0, 0.5, 1.5, 2.5, 3.5, 4.5, 99.5, 100.5, 511.5, 512.5,
        -0.5, -1.5, -2.5, -99.5, -100.5,
        0.49999999999999994, 0.5000000000000001, 2.4999999999999996,
        123.25, 123.75, 320.0, 200.0, 640.4, 384.6, 1023.5, 1024.5,
        7.0, 8.0, -7.0, -8.0, 0.1, 0.9, -0.1, -0.9, 159.5, 160.5,
    ]
    # velocity battery (vx, vy): raw floats, including negatives and zero.
    vels = [
        (0.0, 0.0), (1.0, -1.0), (-3.25, 4.75), (500.0, 500.0),
        (-500.0, -250.0), (0.5, -0.5), (1000.0, 0.0), (0.0, 1000.0),
        (123.456, -789.012), (-0.001, 0.001),
    ]

    projectiles = []
    # Drive a deterministic walk over (owner, weapon, coord pair, vel) so the set
    # is large (hundreds of records) and every branch is hit. Seed the indexer.
    ri = rngmod.Rng(99887766)
    NWEAP = w.NUM_ITEMS
    for ci in range(len(coords)):
        for cj in range(len(coords)):
            # subsample the cross product deterministically to keep it dense but
            # bounded; always include the diagonal (ci==cj) for tie-on-both.
            if ci != cj and ri.pick(4) != 0:
                continue
            px = coords[ci]
            py = coords[cj]
            owner = owners[ri.pick(len(owners))]
            weapon = w.ITEMS[ri.pick(NWEAP)]
            vx, vy = vels[ri.pick(len(vels))]
            p = objects.Projectile(owner, weapon, px, py, vx, vy)
            projectiles.append(_proj_record(p))

    # Also: one projectile per weapon idx with owner=None at integer coords, so
    # warheads_left / weapon_type are checked across the WHOLE catalog.
    for idx in range(NWEAP):
        p = objects.Projectile(None, w.ITEMS[idx], 100.0, 200.0, 0.0, 0.0)
        projectiles.append(_proj_record(p))

    # -----------------------------------------------------------------------
    # Tanks: every (ai_class, team_id, tank_icon) combination that matters,
    # default field dump. reveal_type = ai_class-1 if ai_class else -1 is the
    # one computed default to check across the AI-class range.
    # -----------------------------------------------------------------------
    tanks = []
    AI_CLASSES = [0, 1, 2, 3, 4, 5, 6, 7, 8]   # human + all AI ids
    TEAMS = [0, 1, 2, 3]
    ICONS = [0, 1, 2, 3, 4, 5, 6]
    ti = rngmod.Rng(55667788)
    pcounter = 0
    for ac in AI_CLASSES:
        for tm in TEAMS:
            for ic in ICONS:
                # subsample to stay bounded but always cover the AI range fully
                # for team 0 / icon 0 (the reveal_type axis).
                if not (tm == 0 and ic == 0) and ti.pick(3) != 0:
                    continue
                t = objects.Tank(pcounter, f"Tank{pcounter}",
                                 ai_class=ac, team_id=tm, tank_icon=ic)
                tanks.append(_tank_record(t))
                pcounter += 1
    # Default-argument tanks (ai_class/team_id/tank_icon omitted) -- the defaults
    # 0/0/0 path.
    tanks.append(_tank_record(objects.Tank(100, "Default")))
    tanks.append(_tank_record(objects.Tank(101, "")))  # empty name

    # -----------------------------------------------------------------------
    # has_ammo over a battery of slots and inventory states.
    # Slot 0 (Baby Missile) is ALWAYS True regardless of count; every other slot
    # is True iff inventory[slot] > 0. Mutate inventory then probe.
    # -----------------------------------------------------------------------
    has_ammo = []
    SLOTS_TO_PROBE = list(range(w.NUM_ITEMS))
    # state A: fresh tank (only slot 0 == 99).
    tA = objects.Tank(0, "A")
    has_ammo.append({
        "label": "fresh",
        "slots": SLOTS_TO_PROBE,
        "out": [bool(tA.has_ammo(s)) for s in SLOTS_TO_PROBE],
    })
    # state B: give a handful of slots nonzero counts.
    tB = objects.Tank(0, "B")
    for s in (1, 5, 10, 38, 40, 46, 47):
        tB.inventory[s] = s  # arbitrary positive
    tB.inventory[0] = 0       # slot 0 emptied: has_ammo STILL True (the contract)
    has_ammo.append({
        "label": "mixed_slot0_zeroed",
        "slots": SLOTS_TO_PROBE,
        "out": [bool(tB.has_ammo(s)) for s in SLOTS_TO_PROBE],
    })
    # state C: slot 0 = 1 (still True), everything else 0.
    tC = objects.Tank(0, "C")
    for s in range(w.NUM_ITEMS):
        tC.inventory[s] = 0
    tC.inventory[0] = 1
    has_ammo.append({
        "label": "only_slot0_one",
        "slots": SLOTS_TO_PROBE,
        "out": [bool(tC.has_ammo(s)) for s in SLOTS_TO_PROBE],
    })

    # -----------------------------------------------------------------------
    # consume sequences: the Baby Missile (slot 0) zero-crossing refill and the
    # ordinary slot decrement-to-zero floor. Record inventory[slot] and has_ammo
    # after EVERY consume so the full trajectory is pinned.
    # -----------------------------------------------------------------------
    consume = []

    # Slot 0: start at the seeded 99, consume far past 99 so the 1->99 refill
    # fires multiple times (the divergence note in objects.py).
    tS0 = objects.Tank(0, "S0")
    steps0 = []
    for _ in range(210):
        tS0.consume(0)
        steps0.append({"slot_val": tS0.inventory[0], "has_ammo": bool(tS0.has_ammo(0))})
    consume.append({"label": "slot0_refill", "slot": 0, "start": 99, "steps": steps0})

    # Slot 0 starting from a small count: 3 -> 2 -> 99 (refill at the 1 boundary).
    tS0b = objects.Tank(0, "S0b")
    tS0b.inventory[0] = 3
    steps0b = []
    for _ in range(6):
        tS0b.consume(0)
        steps0b.append({"slot_val": tS0b.inventory[0], "has_ammo": bool(tS0b.has_ammo(0))})
    consume.append({"label": "slot0_small_start", "slot": 0, "start": 3, "steps": steps0b})

    # Slot 0 starting at 1: 1 -> 99 immediately (the zero-crossing branch).
    tS0c = objects.Tank(0, "S0c")
    tS0c.inventory[0] = 1
    steps0c = []
    for _ in range(3):
        tS0c.consume(0)
        steps0c.append({"slot_val": tS0c.inventory[0], "has_ammo": bool(tS0c.has_ammo(0))})
    consume.append({"label": "slot0_one_start", "slot": 0, "start": 1, "steps": steps0c})

    # Slot 0 starting at 0: 0 -> 99 (the count<=1 branch with count==0).
    tS0d = objects.Tank(0, "S0d")
    tS0d.inventory[0] = 0
    steps0d = []
    for _ in range(3):
        tS0d.consume(0)
        steps0d.append({"slot_val": tS0d.inventory[0], "has_ammo": bool(tS0d.has_ammo(0))})
    consume.append({"label": "slot0_zero_start", "slot": 0, "start": 0, "steps": steps0d})

    # Ordinary slots: decrement to 0 then STAY at 0 (no refill, no underflow).
    for slot, start in [(1, 5), (10, 3), (40, 1), (46, 10), (47, 2), (5, 0)]:
        tN = objects.Tank(0, f"N{slot}")
        tN.inventory[slot] = start
        stepsN = []
        for _ in range(start + 4):      # consume past empty to prove the floor
            tN.consume(slot)
            stepsN.append({"slot_val": tN.inventory[slot],
                           "has_ammo": bool(tN.has_ammo(slot))})
        consume.append({"label": f"slot{slot}_floor", "slot": slot,
                        "start": start, "steps": stepsN})

    # -----------------------------------------------------------------------
    # fuel / parachutes / batteries properties across inventory + remainder.
    #   fuel = inventory[SLOT_FUEL]*10 + fuel_remainder
    #   parachutes = inventory[SLOT_PARACHUTE]
    #   batteries = inventory[SLOT_BATTERY]
    # -----------------------------------------------------------------------
    props = []
    PROP_CASES = [
        # (fuel_tanks, fuel_remainder, parachutes, batteries)
        (0, 0, 0, 0),
        (1, 0, 0, 0),
        (0, 5, 0, 0),
        (3, 7, 2, 4),
        (10, 9, 8, 10),
        (99, 9, 99, 99),
        (5, 0, 1, 0),
        (0, 9, 0, 1),
        (7, 3, 0, 0),
        (2, 10, 5, 5),   # remainder=10 (over a "tank"); property just sums raw
    ]
    for (ft, rem, par, bat) in PROP_CASES:
        t = objects.Tank(0, "Pp")
        t.inventory[w.SLOT_FUEL] = ft
        t.fuel_remainder = rem
        t.inventory[w.SLOT_PARACHUTE] = par
        t.inventory[w.SLOT_BATTERY] = bat
        props.append({
            "fuel_tanks": ft, "fuel_remainder": rem,
            "parachutes_inv": par, "batteries_inv": bat,
            "fuel": t.fuel, "parachutes": t.parachutes, "batteries": t.batteries,
        })

    # The exact key set of a Tank record and a Projectile record (so the TS side
    # asserts the field SHAPE -- a renamed/missing field is caught).
    proj_keys = sorted(_proj_record(
        objects.Projectile(None, w.ITEMS[0], 0.0, 0.0, 0.0, 0.0)).keys())
    tank_keys = sorted(_tank_record(objects.Tank(0, "k")).keys())

    return _write("objects", {
        "module": "objects",
        "constants": {
            "TANK_DEFAULT_HEALTH": __import__("scorch.constants", fromlist=["x"]).TANK_DEFAULT_HEALTH,
            "PARACHUTE_THRESHOLD_DEFAULT": __import__("scorch.constants", fromlist=["x"]).PARACHUTE_THRESHOLD_DEFAULT,
            "BOUNCE_ENERGY": __import__("scorch.constants", fromlist=["x"]).BOUNCE_ENERGY,
            "NUM_ITEMS": w.NUM_ITEMS,
            "SLOT_BABY_MISSILE": w.SLOT_BABY_MISSILE,
            "SLOT_FUEL": w.SLOT_FUEL,
            "SLOT_PARACHUTE": w.SLOT_PARACHUTE,
            "SLOT_BATTERY": w.SLOT_BATTERY,
        },
        "proj_keys": proj_keys,
        "tank_keys": tank_keys,
        "pyround": pyround,
        "projectiles": projectiles,
        "tanks": tanks,
        "has_ammo": has_ammo,
        "consume": consume,
        "props": props,
    })


DUMPERS = {
    "objects": dump_objects,
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
