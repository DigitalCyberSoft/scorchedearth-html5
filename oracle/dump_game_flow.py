#!/usr/bin/env python3
"""Oracle vector dumper for scorch.game.GameState FLOW paths NOT exercised by
dump_game.py -- the real-game weapon/death/retreat/economy/shield/effect paths.

Like dump_game.py, this drives the REAL scorch.game.GameState headless
(SDL_VIDEODRIVER=dummy) over FIXED seeds + scripted scenarios and dumps a rich
GameState SNAPSHOT (tanks + projectiles + visual-effect arrays + a terrain
column-top signature + a live-LUT band sample + wind + last_landing) after each
pipeline step.  test/game_flow.test.ts builds an identical battery against
src/game.ts and asserts every snapshot reproduces EXACT for integers /
toBeCloseTo(.,12) for trajectory floats.

This is a STATIC use of the Python port (the fidelity oracle): it imports and
drives the pure GameState pipeline; it never runs the DOS binary.

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../scorch-py" \
        "../.venv/bin/python" oracle/dump_game_flow.py
"""
import json
import os
import sys

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

_HERE = os.path.dirname(os.path.abspath(__file__))
_VECTORS = os.path.join(_HERE, "vectors")
_SCORCH_PY = os.path.normpath(os.path.join(_HERE, "..", "..", "scorch-py"))
if _SCORCH_PY not in sys.path:
    sys.path.insert(0, _SCORCH_PY)

import random  # noqa: E402

from scorch import game as G  # noqa: E402
from scorch import damage as D  # noqa: E402
from scorch.config import Config  # noqa: E402
from scorch.rng import rng as grng  # noqa: E402
from scorch import constants as C  # noqa: E402
from scorch import weapons  # noqa: E402

W, H = 640, 480

# Live-LUT band sample indices (palette band heads): sky/lightning (120),
# explosion band lo (200), explosion ring base (221), digger band lo/hi (175/184).
LUT_IDX = [120, 200, 221, 175, 184]
# terrain column-top signature sample columns.
TERR_X = [80, 160, 240, 320, 400, 480, 560]


# ---------------------------------------------------------------------------
# Snapshot helpers.
# ---------------------------------------------------------------------------
def snap_tank(t):
    return {
        "health": t.health, "x": t.x, "y": t.y,
        "shield_hp": t.shield_hp, "shield_item": t.shield_item,
        "alive": bool(t.alive), "score": t.score, "cash": t.cash,
        "win_counter": t.win_counter, "angle": t.angle, "power": t.power,
        "color": t.color,
    }


def snap_proj(p):
    return {"px": p.px, "py": p.py, "vx": p.vx, "vy": p.vy, "active": bool(p.active),
            "behavior": p.weapon.behavior}


def snap_explosion(e):
    return {"x": e["x"], "y": e["y"], "maxr": e["maxr"], "style": e["style"],
            "dirt": bool(e["dirt"]), "step": e["step"], "flash": bool(e["flash"]),
            "phase": e["phase"], "frame": e["frame"]}


def snap_throe(e):
    return {"kind": e["kind"], "frame": e["frame"], "life": e["life"],
            "n_parts": len(e.get("parts", []))}


def snap_fx(gs):
    return {
        "explosions": [snap_explosion(e) for e in gs.explosions],
        "plasma_rings": [dict(r) for r in gs.plasma_rings],
        "death_fountains": [dict(f) for f in gs.death_fountains],
        "throe_fx": [snap_throe(e) for e in gs.throe_fx],
        "flashes": [{"up": f["up"], "down": f["down"], "frame": f["frame"],
                     "rgb": list(f["rgb"])} for f in gs.flashes],
        "firewalls": [dict(fw) for fw in gs.firewalls],
        "beams": [len(b["pts"]) for b in gs.beams],
        "trace_marks": len(gs.trace_marks),
    }


def lut_sample(gs):
    return [[int(v) for v in gs.lut.table[i]] for i in LUT_IDX]


def terr_sig(gs):
    return [gs.terrain.column_top(x) for x in TERR_X]


def snap(gs, label):
    cs = gs.current_shooter.player_index if gs.current_shooter is not None else -1
    win = gs.winner.player_index if gs.winner is not None else -1
    ll = list(gs.last_landing) if gs.last_landing is not None else None
    return {
        "label": label, "phase": gs.phase,
        "current_shooter": cs, "winner": win,
        "round_index": gs.round_index, "wind": gs.cfg.wind,
        "fire_index": gs.fire_index,
        "tanks": [snap_tank(t) for t in gs.tanks],
        "projectiles": [snap_proj(p) for p in gs.projectiles],
        "fx": snap_fx(gs),
        "lut": lut_sample(gs),
        "terr": terr_sig(gs),
        "last_landing": ll,
    }


def make_cfg(**over):
    cfg = Config()
    cfg.SOUND = "OFF"
    cfg.TALKING_TANKS = "OFF"
    cfg.FLY_SOUND = "OFF"
    cfg.SKY = "PLAIN"
    for k, v in over.items():
        setattr(cfg, k, v)
    cfg.live_elastic = cfg.elastic
    return cfg


def build(cfg, seed, players):
    random.seed(seed)
    grng.seed(seed)
    gs = G.GameState(cfg, W, H)
    gs.mtn_ranges = []
    for (name, ai, team, icon) in players:
        gs.add_player(name, ai, team, icon)
    return gs


DT = 1 / 60.0


# ===========================================================================
# Scenario A: full fire -> flight -> impact -> detonation per weapon behavior.
# Each weapon: 2 human tanks, tank 0 fires the weapon at a fixed aim, driven a
# bounded number of frames so the launch, flight, detonation, and the start of
# the effect animation are all snapshotted.  Exercises fire() per-behavior
# branches, _step_flight (roller/digger/sandhog/mirv split/off-field), detonate,
# add_explosion (grow/nuke/stamp), plasma ring, laser beam, and the live-LUT
# explosion/digger band animators (read via the lut sample each frame).
# ===========================================================================
# Aims pinned so each shell LANDS on the terrain (or detonates at the muzzle for
# the instant weapons) -- so the per-behavior detonate/damage paths actually run,
# not just the off-field-lost branch.  The shooter (seed 42) sits at x=182, so an
# ~80deg arc at modest power comes down on the field; the mirv gets more power for
# a clean apogee split; laser/plasma are instant.  Verified each produces its
# expected effect (grow / nuke / beam / plasma ring / scatter / mirv children /
# tunnel) by probe before locking.
WEAPONS = [
    # (slot, label, angle, power)
    (1, "missile", 80, 320),
    (3, "nuke", 80, 320),
    (13, "roller", 80, 320),
    (20, "digger", 80, 320),
    (23, "sandhog", 80, 320),
    (4, "leapfrog", 80, 320),
    (5, "funky", 80, 320),
    (26, "dirt_ball", 80, 320),
    (7, "deaths_head", 80, 520),
    (32, "laser", 45, 600),
    (31, "plasma", 60, 500),
    (10, "tracer", 80, 320),
]


def scen_weapon_fire():
    out = []
    for (slot, label, angle, power) in WEAPONS:
        cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                       FALLING_TANKS="OFF", CHANGING_WIND="OFF", TRACE="OFF")
        gs = build(cfg, 42, [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0)])
        gs.new_game()
        gs.update(DT)                       # into tank 0's human turn
        shooter = gs.current_shooter
        shooter.inventory[slot] = 20
        shooter.angle = angle
        shooter.power = power
        shooter.selected_weapon = slot
        gs.fire()
        steps = [snap(gs, "after_fire")]
        # drive until the shell(s) clear (detonated / tunnelled-out / lost), then a
        # short tail so the start of the effect animation is captured.  Hard cap is
        # a safety net (the longest weapon -- the 3-hop leapfrog -- clears ~f205).
        n = 0
        empty_at = None
        while n < 250:
            gs.update(DT)
            n += 1
            steps.append(snap(gs, f"f{n}"))
            if gs.phase in (G.ROUND_END, G.GAME_OVER):
                break
            if empty_at is None and len(gs.projectiles) == 0:
                empty_at = n
            if empty_at is not None and n >= empty_at + 10:
                break
        out.append({"slot": slot, "label": label, "angle": angle,
                    "power": power, "steps": steps})
    return out


# ===========================================================================
# Scenario B: the death sequence (on_tank_destroyed -> death.death_sequence).
# Place tank 1 adjacent to tank 0, latch a killing weapon, and run a real lethal
# kill (damage.explode large enough to drop tank 1 to 0) so kill_tank ->
# on_tank_destroyed fires.  Snapshot the populated death FX (fountains/throes/
# explosions) the moment the kill lands and over the next few animation frames.
# The test asserts these are populated with FINITE integers (the regression the
# options-object fix addressed) AND reproduce the Python content exactly.
# ===========================================================================
def scen_death_fx():
    out = []
    for seed in (1, 7, 42, 99):
        cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                       FALLING_TANKS="OFF", CHANGING_WIND="OFF")
        gs = build(cfg, seed, [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0)])
        gs.new_game()
        base_y = gs.tanks[0].y
        gs.tanks[0].x, gs.tanks[0].y = 300, base_y
        gs.tanks[1].x, gs.tanks[1].y = 314, base_y
        for t in gs.tanks:
            t.health = 100
            t.alive = True
        gs.current_shooter = gs.tanks[0]
        gs.current_weapon = weapons.ITEMS[3]          # Nuke latched as killer
        steps = [snap(gs, "pre_kill")]
        # a big blast centred on tank 1 -> lethal -> kill_tank -> on_tank_destroyed
        D.explode(gs, gs.tanks[1].x, gs.tanks[1].y, 80, carve=True)
        steps.append(snap(gs, "after_kill"))
        for k in range(6):
            gs._animate_effects()
            steps.append(snap(gs, f"anim{k}"))
        out.append({"seed": seed, "steps": steps})
    return out


# ===========================================================================
# Scenario C: retreat (SEQUENTIAL).  Drive to a human turn, retreat the current
# shooter, then drive the SETTLE machinery.  The retreating tank dies (death
# path) with NO points, current_shooter cleared so no kill is credited.
# ===========================================================================
def scen_retreat():
    out = []
    for seed in (3, 5, 42):
        cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                       FALLING_TANKS="OFF", CHANGING_WIND="OFF")
        gs = build(cfg, seed, [
            ("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0),
            ("C", C.AI_HUMAN, 0, 0),
        ])
        gs.new_game()
        gs.update(DT)                       # into tank 0's turn (phase AIM)
        steps = [snap(gs, "turn_start")]
        gs.retreat()                        # current shooter flees
        steps.append(snap(gs, "after_retreat"))
        n = 0
        while n < 200:
            gs.update(DT)
            n += 1
            if gs.phase in (G.AIM, G.ROUND_END, G.GAME_OVER):
                break
        steps.append(snap(gs, "after_settle"))
        out.append({"seed": seed, "steps": steps})
    return out


def scen_retreat_win():
    """A 2-tank retreat: the survivor is the last tank -> _win_check True ->
    _end_round (retreat that ENDS the round, the SEQUENTIAL win path)."""
    out = []
    for seed in (3, 42):
        cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                       FALLING_TANKS="OFF", CHANGING_WIND="OFF", SCORING="STANDARD")
        gs = build(cfg, seed, [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0)])
        gs.new_game()
        gs.update(DT)
        steps = [snap(gs, "turn_start")]
        gs.retreat()                        # current shooter flees -> 1 left -> round end
        steps.append(snap(gs, "after_retreat"))
        out.append({"seed": seed, "steps": steps})
    return out


# ===========================================================================
# Scenario D: mass_kill -- kill EVERY tank, split the survival pool equally with
# NO win credit, end the round.  STANDARD and BASIC scoring, with non-zero
# starting cash/score to verify the share math and the max(0, ...) cash floor.
# ===========================================================================
def scen_mass_kill():
    out = []
    for (seed, scoring, roster_n, cash0, score0) in [
        (1, "STANDARD", 2, 1000, 50),
        (2, "STANDARD", 4, 0, 0),
        (3, "BASIC", 3, 200, 10),
        (4, "BASIC", 5, 7777, 100),
    ]:
        cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=cash0, MAX_WIND=0, SCORING=scoring)
        players = [(chr(65 + i), C.AI_HUMAN, 0, 0) for i in range(roster_n)]
        gs = build(cfg, seed, players)
        gs.new_game()
        for t in gs.tanks:
            t.score = score0
            t.cash = cash0
        gs.mass_kill()
        out.append({"seed": seed, "scoring": scoring, "roster_n": roster_n,
                    "cash0": cash0, "score0": score0,
                    "steps": [snap(gs, "after_mass_kill")]})
    return out


# ===========================================================================
# Scenario E: win / loss elimination -- 4 tanks, kill them off one by one and
# verify _win_check, survival award, round end, then proceed_after_round to a
# GAME_OVER + winner (last tank standing).
# ===========================================================================
def scen_win_loss():
    out = []
    for seed in (5, 42):
        cfg = make_cfg(MAXROUNDS=1, INITIAL_CASH=0, MAX_WIND=0,
                       FALLING_TANKS="OFF", CHANGING_WIND="OFF", SCORING="STANDARD")
        gs = build(cfg, seed, [
            ("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0),
            ("C", C.AI_HUMAN, 0, 0), ("D", C.AI_HUMAN, 0, 0),
        ])
        gs.new_game()
        steps = [snap(gs, "round_start")]
        gs.current_shooter = None
        # eliminate tanks 1, 2, 3 -> tank 0 is the last standing
        for idx in (1, 2, 3):
            D.kill_tank(gs, gs.tanks[idx])
            steps.append(snap(gs, f"kill{idx}"))
        gs.phase = G.SETTLE
        gs._settle_done = False
        n = 0
        while n < 240:
            gs.update(DT)
            n += 1
            if gs.phase in (G.ROUND_END, G.GAME_OVER):
                break
        steps.append(snap(gs, "round_end"))
        gs.proceed_after_round()            # MAXROUNDS==1 -> GAME_OVER + winner
        steps.append(snap(gs, "game_over"))
        out.append({"seed": seed, "steps": steps})
    return out


# ===========================================================================
# Scenario F: the shop / economy cycle.  cash>0 new_game -> SHOP, run AI buys,
# begin the round, kill to end it, proceed_after_round (interest + annuity +
# market), then begin the next round.  Snapshot cash/inventory/round_index/phase
# at each boundary so the economy entry points game exposes are pinned.
# ===========================================================================
def scen_shop_cycle():
    out = []
    for seed in (1, 42):
        cfg = make_cfg(MAXROUNDS=3, INITIAL_CASH=20000, MAX_WIND=0,
                       FALLING_TANKS="OFF", CHANGING_WIND="OFF", SCORING="STANDARD")
        gs = build(cfg, seed, [
            ("H", C.AI_HUMAN, 0, 0),
            ("AI1", C.AI_SHOOTER, 0, 0),
            ("AI2", C.AI_POOLSHARK, 0, 0),
        ])
        gs.new_game()                       # cash>0 -> SHOP
        rows = [{"label": "after_new_game", "phase": gs.phase,
                 "round_index": gs.round_index,
                 "cash": [t.cash for t in gs.tanks],
                 "inv": [list(t.inventory) for t in gs.tanks]}]
        gs.run_ai_buys()
        rows.append({"label": "after_ai_buys", "phase": gs.phase,
                     "round_index": gs.round_index,
                     "cash": [t.cash for t in gs.tanks],
                     "inv": [list(t.inventory) for t in gs.tanks]})
        gs.begin_next_round()               # start round 1
        rows.append({"label": "round1_start", "phase": gs.phase,
                     "round_index": gs.round_index,
                     "cash": [t.cash for t in gs.tanks],
                     "inv": [list(t.inventory) for t in gs.tanks]})
        gs.current_shooter = None
        D.kill_tank(gs, gs.tanks[1])
        D.kill_tank(gs, gs.tanks[2])
        gs._end_round()
        rows.append({"label": "round1_end", "phase": gs.phase,
                     "round_index": gs.round_index,
                     "cash": [t.cash for t in gs.tanks],
                     "inv": [list(t.inventory) for t in gs.tanks]})
        gs.proceed_after_round()            # economy: interest + annuity + market
        rows.append({"label": "after_proceed", "phase": gs.phase,
                     "round_index": gs.round_index,
                     "cash": [t.cash for t in gs.tanks],
                     "inv": [list(t.inventory) for t in gs.tanks]})
        out.append({"seed": seed, "rows": rows})
    return out


# ===========================================================================
# Scenario G: CHANGING_WIND per-turn jitter.  MAX_WIND>0 + CHANGING_WIND ON;
# step through several AI turns and record the wind after each perturbation.
# ===========================================================================
def scen_changing_wind():
    out = []
    for seed in (1, 7, 42, 2024):
        cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=100,
                       FALLING_TANKS="OFF", CHANGING_WIND="ON")
        gs = build(cfg, seed, [
            ("AI1", C.AI_SHOOTER, 0, 0), ("AI2", C.AI_SHOOTER, 0, 0),
        ])
        gs.new_game()
        winds = [gs.cfg.wind]
        # drive a bounded number of frames; record wind whenever it changes turn
        last_fi = gs.fire_index
        n = 0
        while n < 400 and len(winds) < 8:
            gs.update(DT)
            n += 1
            if gs.fire_index != last_fi:
                winds.append(gs.cfg.wind)
                last_fi = gs.fire_index
            if gs.phase in (G.ROUND_END, G.GAME_OVER):
                break
        out.append({"seed": seed, "winds": winds})
    return out


# ===========================================================================
# Scenario H: shields in flight -- a shooter lobs a shell PAST a shielded enemy.
# Mag Deflector (push) bumps the shell up; Force Shield (deflect) mirror-reflects
# it once and chips the ring.  Snapshot the projectile kinematics + shield_hp so
# the deflect/mag-push math (_mag_deflect / _force_deflect / _sgn / pyRound) is
# pinned frame-by-frame.
# ===========================================================================
def scen_shields():
    out = []
    configs = [
        ("mag", {"push": True}),
        ("force", {"deflect": True}),
    ]
    for (label, flags) in configs:
        for seed in (42, 1234):
            cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                           FALLING_TANKS="OFF", CHANGING_WIND="OFF", TRACE="OFF")
            gs = build(cfg, seed, [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0)])
            gs.new_game()
            gs.update(DT)
            shooter = gs.current_shooter            # tank 0
            target = gs.tanks[1]
            # pin both tanks so the arc passes over the shielded target
            base_y = gs.tanks[0].y
            shooter.x, shooter.y = 200, base_y
            target.x, target.y = 380, base_y
            target.shield_hp = 200
            target.shield_item = weapons.SLOT_FORCE_SHIELD
            target.shield_push = flags.get("push", False)
            target.shield_deflect = flags.get("deflect", False)
            shooter.angle = 45
            shooter.power = 520
            shooter.selected_weapon = weapons.SLOT_BABY_MISSILE
            gs.fire()
            steps = [snap(gs, "after_fire")]
            n = 0
            while n < 90:
                gs.update(DT)
                n += 1
                steps.append(snap(gs, f"f{n}"))
                if gs.phase in (G.ROUND_END, G.GAME_OVER, G.AIM):
                    break
            out.append({"label": label, "seed": seed, "steps": steps})
    return out


# ===========================================================================
# Scenario I: SYNCHRONOUS AI volley -- AI tanks auto-lock, the whole volley
# fires at once, flies together, settles, and survivors re-aim (a SECOND volley).
# Exercises _sync_launch_volley / _sync_volley / _sync_start_volley.
# ===========================================================================
def scen_sync_ai_volley():
    out = []
    for seed in (1, 42):
        cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                       FALLING_TANKS="OFF", CHANGING_WIND="OFF",
                       PLAY_MODE="SYNCHRONOUS")
        gs = build(cfg, seed, [
            ("AI1", C.AI_SHOOTER, 0, 0), ("AI2", C.AI_SHOOTER, 0, 0),
        ])
        gs.new_game()
        steps = [snap(gs, "sync_start")]
        n = 0
        volleys = 0
        prev_phase = gs.phase
        while n < 800:
            gs.update(DT)
            n += 1
            if gs.phase == G.SYNC_VOLLEY and prev_phase != G.SYNC_VOLLEY:
                volleys += 1
                steps.append(snap(gs, f"volley{volleys}_launch"))
            prev_phase = gs.phase
            if gs.phase in (G.ROUND_END, G.GAME_OVER):
                break
            if volleys >= 2 and gs.phase == G.SYNC_AIM:
                steps.append(snap(gs, "second_reaim"))
                break
        steps.append(snap(gs, "sync_final"))
        out.append({"seed": seed, "steps": steps, "volleys": volleys})
    return out


# ===========================================================================
# Scenario J: SIMULTANEOUS human fire -- a human + an AI in SIM mode; the human
# fires via fire() (no shooter) which routes to _sim_human_fire (launch only
# when no own shell is in flight).  Verify the launch + the re-fire gate.
# ===========================================================================
def scen_sim_human():
    out = []
    for seed in (1, 42):
        cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                       FALLING_TANKS="OFF", CHANGING_WIND="OFF",
                       PLAY_MODE="SIMULTANEOUS")
        gs = build(cfg, seed, [
            ("H", C.AI_HUMAN, 0, 0), ("AI", C.AI_SHOOTER, 0, 0),
        ])
        gs.new_game()
        gs.update(DT)                      # SIM frame: current_shooter <- the human
        human = gs.tanks[0]
        human.angle = 50
        human.power = 600
        human.selected_weapon = weapons.SLOT_BABY_MISSILE
        steps = [snap(gs, "sim_start")]
        before = len([p for p in gs.projectiles if p.owner is human])
        gs.fire()                          # human fire -> _sim_human_fire (launch)
        after_first = len([p for p in gs.projectiles if p.owner is human])
        steps.append(snap(gs, "after_human_fire"))
        gs.fire()                          # gated: own shell still out -> no launch
        gated = len([p for p in gs.projectiles if p.owner is human])
        steps.append(snap(gs, "after_gated_fire"))
        out.append({"seed": seed, "steps": steps,
                    "human_launched": after_first - before, "gated_count": gated})
    return out


# ===========================================================================
# Scenario K: isolated effect/animation helpers + edge engine paths that have no
# in-flight trigger (vestigial/scaffold), driven directly and snapshotted:
#   * add_firewall + _tick_firewall_band  (scaffold; no item spawns one)
#   * _discharge_batteries                (defined, engine-unwired)
#   * add_flash + _step_flashes + _tick_lightning_band (lightning band)
#   * start_digger_cycle + _tick_digger_band + _rollRows (digger band rotate)
#   * add_throe per kind + _step_throe_fx (each throe animation)
#   * add_plasma_ring/add_beam direct + their step
#   * the mayhem cheat + Unknown-class re-roll + arm-best-shield + SIM auto-defense
# ===========================================================================
def scen_effects():
    rows = {}

    # --- firewall ---
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0)
    gs = build(cfg, 1, [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    gs.add_firewall(120, 100, 300)
    fw = [{"firewalls": [dict(x) for x in gs.firewalls],
           "counter": gs._firewall_counter, "active": bool(gs._firewall_band_active),
           "lut": lut_sample(gs)}]
    for _ in range(5):
        gs._tick_firewall_band(3)
        fw.append({"firewalls": [dict(x) for x in gs.firewalls],
                   "counter": gs._firewall_counter,
                   "active": bool(gs._firewall_band_active), "lut": lut_sample(gs)})
    rows["firewall"] = fw

    # --- discharge batteries ---
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0)
    gs = build(cfg, 1, [("A", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    t = gs.tanks[0]
    t.inventory[weapons.SLOT_BATTERY] = 4
    disc = [{"batteries": t.batteries}]
    gs._discharge_batteries(t, 2)
    disc.append({"batteries": t.batteries})
    gs._discharge_batteries(t)               # default count = remaining
    disc.append({"batteries": t.batteries})
    rows["discharge"] = disc

    # --- battery auto-trigger (SIM recharge) ---
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0)
    gs = build(cfg, 1, [("A", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    t = gs.tanks[0]
    t.health = 55
    t.inventory[weapons.SLOT_BATTERY] = 10
    used = gs._battery_auto_trigger(t)
    rows["battery_auto"] = {"used": used, "health": t.health,
                            "batteries": t.batteries}

    # --- flash + lightning band ---
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0)
    gs = build(cfg, 1, [("A", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    gs.add_flash(5, 10, (255, 255, 235), 0)
    gs.add_flash(3, 6, (200, 220, 255), 4)
    fl = []
    for _ in range(8):
        gs._step_flashes()
        gs._tick_lightning_band()
        fl.append({"flashes": [{"up": f["up"], "down": f["down"],
                                "frame": f["frame"]} for f in gs.flashes],
                   "lut": lut_sample(gs)})
    rows["flash"] = fl

    # --- digger cycle band rotate ---
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0)
    gs = build(cfg, 1, [("A", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    gs.start_digger_cycle()
    dg = [{"cycle": gs._digger_cycle, "step": gs._digger_step, "lut": lut_sample(gs)}]
    for s in (1, 2, 1, 3):
        gs._tick_digger_band(s)
        dg.append({"cycle": gs._digger_cycle, "step": gs._digger_step,
                   "lut": lut_sample(gs)})
    rows["digger_band"] = dg

    # --- digger cycle EXPIRY (200-frame cycle runs to 0 -> band reset + trail clear) ---
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0)
    gs = build(cfg, 1, [("A", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    gs.start_digger_cycle()
    for _ in range(201):                         # 200 ticks drains the cycle to 0
        gs._tick_digger_band(1)
    rows["digger_expire"] = {"cycle": gs._digger_cycle, "step": gs._digger_step,
                             "lut": lut_sample(gs)}

    # --- throes (each kind) + step ---
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0)
    gs = build(cfg, 7, [("A", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    throws = {}
    for kind in ("spiral", "ring", "geyser", "sparkle", "sink"):
        # fresh gs per kind so the rng stream for sparkle parts is pinned
        gs2 = build(make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0), 7,
                    [("A", C.AI_HUMAN, 0, 0)])
        gs2.new_game()
        gs2.add_throe(kind, 100, 200, 15)
        seq = [snap_throe(gs2.throe_fx[0])]
        for _ in range(5):
            gs2._step_throe_fx()
            if gs2.throe_fx:
                seq.append(snap_throe(gs2.throe_fx[0]))
            else:
                seq.append(None)
        throws[kind] = {"seq": seq, "terr_after": terr_sig(gs2)}
    rows["throes"] = throws

    # --- plasma ring + beam direct ---
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0)
    gs = build(cfg, 1, [("A", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    gs.add_plasma_ring(100, 100, 12)
    gs.add_beam([(10, 10), (20, 20), (30, 25)])
    pr = [{"rings": [dict(r) for r in gs.plasma_rings],
           "beams": [len(b["pts"]) for b in gs.beams]}]
    for _ in range(30):
        gs._step_plasma_rings()
        pr.append({"rings": [dict(r) for r in gs.plasma_rings]})
    rows["plasma_ring"] = pr

    # --- mayhem cheat ---
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0)
    cfg.mayhem = True
    gs = build(cfg, 1, [("A", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    rows["mayhem"] = {"inv": list(gs.tanks[0].inventory)}

    # --- Unknown-class re-roll (per-turn, latched once) ---
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0)
    gs = build(cfg, 11, [("U", C.AI_UNKNOWN, 0, 0), ("B", C.AI_SHOOTER, 0, 0)])
    gs.new_game()
    t = gs.tanks[0]
    pre = {"ai_class": t.ai_class, "reveal_type": t.reveal_type}
    gs._resolve_unknown_class(t)
    post1 = {"ai_class": t.ai_class, "reveal_type": t.reveal_type}
    gs._resolve_unknown_class(t)             # latched: no further change
    post2 = {"ai_class": t.ai_class, "reveal_type": t.reveal_type}
    rows["unknown_class"] = {"pre": pre, "post1": post1, "post2": post2}

    # --- arm best shield from inventory ---
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0)
    gs = build(cfg, 1, [("A", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    t = gs.tanks[0]
    t.shield_hp = 0
    t.inventory[weapons.SLOT_SHIELD] = 1
    t.inventory[weapons.SLOT_FORCE_SHIELD] = 1
    slot = gs._arm_best_shield(t, announce=True)
    rows["arm_shield"] = {"slot": slot, "shield_hp": t.shield_hp,
                          "shield_item": t.shield_item,
                          "inv_shield": t.inventory[weapons.SLOT_SHIELD],
                          "inv_force": t.inventory[weapons.SLOT_FORCE_SHIELD]}

    return rows


# ===========================================================================
# Scenario L: FALLING_TANKS settle -- carve the ground out from under a tank and
# settle it.  Covers the fall path (_settle_tank): a parachute deploy + wind drift
# (chute branch), a plain fall (apply_fall_damage), and a faller landing on an
# enemy (_tank_under -> both take damage), plus the SETTLE chute-hold in update().
# ===========================================================================
def _drive_settle(gs, steps, maxn=80):
    n = 0
    while n < maxn:
        gs.update(DT)
        n += 1
        steps.append(snap(gs, f"s{n}"))
        if gs.phase != G.SETTLE:
            break


def scen_falling():
    out = []

    # A: chute deploy + wind drift (threshold 0 forces deploy; wind 50 drives drift)
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                   FALLING_TANKS="ON", CHANGING_WIND="OFF")
    gs = build(cfg, 3, [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    t0 = gs.tanks[0]
    gs.cfg.wind = 50
    t0.parachute_deployed = True
    t0.parachute_threshold = 0
    t0.inventory[weapons.SLOT_PARACHUTE] = 2
    gs.terrain.carve_circle(t0.x, t0.y + 30, 60)     # deep hole under the tank
    gs.phase = G.SETTLE
    gs._settle_done = False
    steps = [snap(gs, "pre_settle")]
    _drive_settle(gs, steps)
    out.append({"label": "chute", "steps": steps})

    # B: plain fall (no chute) -> fall damage
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                   FALLING_TANKS="ON", CHANGING_WIND="OFF")
    gs = build(cfg, 5, [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    t0 = gs.tanks[0]
    t0.parachute_deployed = False
    t0.inventory[weapons.SLOT_PARACHUTE] = 0
    gs.terrain.carve_circle(t0.x, t0.y + 25, 50)
    gs.phase = G.SETTLE
    gs._settle_done = False
    steps = [snap(gs, "pre_settle")]
    _drive_settle(gs, steps)
    out.append({"label": "plain", "steps": steps})

    # C: faller lands on an enemy directly below -> both take damage (_tank_under)
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                   FALLING_TANKS="ON", CHANGING_WIND="OFF")
    gs = build(cfg, 9, [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    t0, t1 = gs.tanks[0], gs.tanks[1]
    t0.parachute_deployed = False
    t0.inventory[weapons.SLOT_PARACHUTE] = 0
    t0.x = 300
    t0.y = gs.terrain.column_top(300) - 40            # suspended above
    t1.x = 300
    t1.y = gs.terrain.column_top(300) - 1             # on the ground below
    gs.terrain.carve_circle(300, t0.y + 10, 30)       # ensure t0 unsupported
    gs.phase = G.SETTLE
    gs._settle_done = False
    steps = [snap(gs, "pre_settle")]
    _drive_settle(gs, steps)
    out.append({"label": "land_on_enemy", "steps": steps})

    # D: FALLING_TANKS OFF settle (the snap-to-surface branch)
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                   FALLING_TANKS="OFF", CHANGING_WIND="OFF")
    gs = build(cfg, 5, [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    gs.terrain.carve_circle(gs.tanks[0].x, gs.tanks[0].y + 20, 40)
    gs.phase = G.SETTLE
    gs._settle_done = False
    steps = [snap(gs, "pre_settle")]
    _drive_settle(gs, steps)
    out.append({"label": "no_fall", "steps": steps})

    return out


# ===========================================================================
# Scenario M: _resolve_hit tank-collision variants -- fire a FLAT shot into an
# adjacent tank so the shell strikes the tank bbox (not terrain).  Shielded
# (chip, no detonation), digger (fizzle), dirt (no damage), and a plain instakill.
# ===========================================================================
def scen_resolve_hit():
    out = []
    variants = [
        ("shielded", weapons.SLOT_BABY_MISSILE, True),
        ("digger_on_tank", 20, False),
        ("dirt_on_tank", 26, False),
        ("instakill", weapons.SLOT_BABY_MISSILE, False),
    ]
    for (label, slot, shielded) in variants:
        cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                       FALLING_TANKS="OFF", CHANGING_WIND="OFF", TRACE="OFF")
        gs = build(cfg, 42, [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0)])
        gs.new_game()
        gs.update(DT)
        gs.current_shooter = gs.tanks[0]            # the CPU-picked order is irrelevant
        shooter = gs.tanks[0]
        target = gs.tanks[1]
        yy = 200
        shooter.x, shooter.y = 250, yy             # both elevated above the terrain
        target.x, target.y = 310, yy               # 60px in front, same height
        # carve a clear air lane so the FLAT shell reaches the floating target's
        # bbox before any terrain (otherwise it buries at the muzzle).
        for cx in range(230, 340, 12):
            gs.terrain.carve_circle(cx, yy + 6, 18)
        if shielded:
            target.shield_hp = 100
            target.shield_item = weapons.SLOT_SHIELD
        shooter.inventory[slot] = 20
        shooter.angle = 0                           # flat
        shooter.power = 300
        shooter.selected_weapon = slot
        gs.fire()
        steps = [snap(gs, "after_fire")]
        n = 0
        empty_at = None
        while n < 120:
            gs.update(DT)
            n += 1
            steps.append(snap(gs, f"f{n}"))
            if gs.phase in (G.ROUND_END, G.GAME_OVER, G.AIM):
                break
            if empty_at is None and len(gs.projectiles) == 0:
                empty_at = n
            if empty_at is not None and n >= empty_at + 6:
                break
        out.append({"label": label, "slot": slot, "shielded": shielded, "steps": steps})
    return out


# ===========================================================================
# Scenario N: CPU-only triple-turret fires THREE fanned Missiles at once.
# ===========================================================================
def scen_triple():
    out = []
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                   FALLING_TANKS="OFF", CHANGING_WIND="OFF", TRACE="OFF")
    # tank_icon 6 == TANK_ICON_CPU_ONLY (the triple-turret emplacement)
    gs = build(cfg, 42, [("A", C.AI_HUMAN, 0, 6), ("B", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    gs.update(DT)
    gs.current_shooter = gs.tanks[0]                 # force the CPU-icon (triple) tank
    shooter = gs.tanks[0]
    shooter.angle = 80
    shooter.power = 300
    shooter.selected_weapon = weapons.SLOT_MISSILE
    shooter.inventory[weapons.SLOT_MISSILE] = 9
    spawned = gs.fire()
    out.append({
        "icon": shooter.tank_icon,
        "n_spawned": len(spawned),
        "after_fire": snap(gs, "after_fire"),
    })
    return out


# ===========================================================================
# Scenario O: fire() ammo fallback -- selecting a weapon with 0 inventory falls
# back to the Baby Missile (slot 0), and an emptied weapon auto-switches off.
# ===========================================================================
def scen_ammo_fallback():
    out = []
    # (a) fire a weapon owned 0 -> falls back to baby missile
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                   FALLING_TANKS="OFF", CHANGING_WIND="OFF")
    gs = build(cfg, 1, [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    gs.update(DT)
    sh = gs.current_shooter
    sh.inventory[weapons.SLOT_MISSILE] = 0
    sh.selected_weapon = weapons.SLOT_MISSILE
    sh.angle = 80
    sh.power = 300
    spawned = gs.fire()
    out.append({"label": "fallback", "behavior": spawned[0].weapon.behavior if spawned else None,
                "selected_after": sh.selected_weapon})
    # (b) fire the LAST of a weapon -> selection auto-switches back to baby missile
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                   FALLING_TANKS="OFF", CHANGING_WIND="OFF")
    gs = build(cfg, 1, [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    gs.update(DT)
    sh = gs.current_shooter
    sh.inventory[weapons.SLOT_MISSILE] = 1            # exactly one left
    sh.selected_weapon = weapons.SLOT_MISSILE
    sh.angle = 80
    sh.power = 300
    spawned = gs.fire()
    out.append({"label": "autoswitch", "behavior": spawned[0].weapon.behavior if spawned else None,
                "selected_after": sh.selected_weapon,
                "missile_left": sh.inventory[weapons.SLOT_MISSILE]})
    return out


# ===========================================================================
# Scenario P: ELASTIC RANDOM / ERRATIC -- the per-round / per-shot live-wall roll.
# ===========================================================================
def scen_elastic():
    out = []
    for (tok, label) in [("RANDOM", "random"), ("ERRATIC", "erratic")]:
        for seed in (1, 42, 1234):
            cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                           FALLING_TANKS="OFF", CHANGING_WIND="OFF", ELASTIC=tok)
            gs = build(cfg, seed, [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0)])
            gs.new_game()
            after_round = gs.cfg.live_elastic
            gs.update(DT)
            sh = gs.current_shooter
            sh.angle = 80
            sh.power = 300
            sh.selected_weapon = weapons.SLOT_BABY_MISSILE
            gs.fire()                                # ERRATIC re-rolls here
            out.append({"token": tok, "seed": seed,
                        "after_round": after_round,
                        "after_fire": gs.cfg.live_elastic})
    return out


# ===========================================================================
# Scenario Q: team win -- TEAM_MODE STANDARD; the round ends when one team is left.
# ===========================================================================
def scen_team_win():
    out = []
    for seed in (5, 42):
        cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                       FALLING_TANKS="OFF", CHANGING_WIND="OFF",
                       TEAM_MODE="STANDARD", SCORING="STANDARD")
        gs = build(cfg, seed, [
            ("A", C.AI_HUMAN, 1, 0), ("B", C.AI_HUMAN, 1, 0),
            ("C", C.AI_HUMAN, 2, 0), ("D", C.AI_HUMAN, 2, 0),
        ])
        gs.new_game()
        steps = [snap(gs, "start")]
        gs.current_shooter = None
        # kill both of team 2 -> team 1 (A,B) both survive -> _win_check True
        D.kill_tank(gs, gs.tanks[2])
        steps.append(snap(gs, "kill_c"))
        win_before = gs._win_check()
        D.kill_tank(gs, gs.tanks[3])
        steps.append(snap(gs, "kill_d"))
        win_after = gs._win_check()
        out.append({"seed": seed, "steps": steps,
                    "win_before": bool(win_before), "win_after": bool(win_after)})
    return out


# ===========================================================================
# Scenario R: arm-shield edges -- already-up returns None; SIMULTANEOUS arms only
# with an Auto-Defense System owned.
# ===========================================================================
def scen_arm_edges():
    out = {}
    # already-up: _arm_best_shield returns None and leaves the shield intact
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0)
    gs = build(cfg, 1, [("A", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    t = gs.tanks[0]
    t.shield_hp = 80
    t.shield_item = weapons.SLOT_SHIELD
    t.inventory[weapons.SLOT_FORCE_SHIELD] = 1
    slot = gs._arm_best_shield(t, announce=True)
    out["already_up"] = {"slot": slot, "shield_hp": t.shield_hp,
                         "inv_force": t.inventory[weapons.SLOT_FORCE_SHIELD]}

    # SIM without auto-defense: shield is force-cleared
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0, PLAY_MODE="SIMULTANEOUS")
    gs = build(cfg, 1, [("A", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    t = gs.tanks[0]
    t.shield_hp = 0
    t.inventory[weapons.SLOT_SHIELD] = 1
    gs._arm_defenses(t)
    out["sim_no_autodef"] = {"shield_hp": t.shield_hp, "shield_item": t.shield_item,
                             "inv_shield": t.inventory[weapons.SLOT_SHIELD]}

    # SIM WITH auto-defense: arms the best owned shield
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0, PLAY_MODE="SIMULTANEOUS")
    gs = build(cfg, 1, [("A", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    t = gs.tanks[0]
    t.shield_hp = 0
    t.inventory[weapons.SLOT_AUTO_DEFENSE] = 1
    t.inventory[weapons.SLOT_SHIELD] = 1
    gs._arm_defenses(t)
    out["sim_autodef"] = {"shield_hp": t.shield_hp, "shield_item": t.shield_item,
                          "inv_shield": t.inventory[weapons.SLOT_SHIELD]}
    return out


# ===========================================================================
# Scenario S: mag-push step -- a shell hovering above a Mag-Deflector tank gets an
# upward velocity bump per step (_mag_deflect body, the narrow overhead box).
# ===========================================================================
def scen_mag_step():
    from scorch import physics
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                   FALLING_TANKS="OFF", CHANGING_WIND="OFF", TRACE="OFF")
    gs = build(cfg, 42, [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    gs.update(DT)
    shooter = gs.tanks[0]
    target = gs.tanks[1]
    gs.current_shooter = shooter
    shooter.x, shooter.y = 120, 240
    target.x, target.y = 300, 240               # mid-screen, room to hover
    target.shield_hp = 150
    target.shield_item = weapons.SLOT_MAG_DEFLECTOR
    target.shield_push = True
    target.shield_deflect = False
    proj = physics.launch(shooter, gs.cfg, weapons.ITEMS[weapons.SLOT_BABY_MISSILE])
    proj.px = float(target.x - 8)            # within the +-15px overhead column
    proj.py = float(target.y - 40)           # 40px above (inside (h-1)/4)
    proj.sx = int(round(proj.px))
    proj.sy = int(round(proj.py))
    proj.prev_px, proj.prev_py = proj.px, proj.py
    proj.vx = 1.0
    proj.vy = -0.5
    proj.owner = shooter
    proj.armed = True
    gs.projectiles = [proj]
    seq = [{"px": proj.px, "py": proj.py, "vx": proj.vx, "vy": proj.vy, "active": bool(proj.active)}]
    for _ in range(8):
        gs._step_flight()
        if gs.projectiles:
            p = gs.projectiles[0]
            seq.append({"px": p.px, "py": p.py, "vx": p.vx, "vy": p.vy, "active": bool(p.active)})
        else:
            seq.append(None)
    return {"seq": seq, "shield_hp": target.shield_hp}


# ===========================================================================
# Scenario T: explosion tail (expand->flash->shrink->done) + dirt stamp + the
# firewall-band restore on expiry.
# ===========================================================================
def scen_explo_tail():
    out = {}
    cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0)
    gs = build(cfg, 1, [("A", C.AI_HUMAN, 0, 0)])
    gs.new_game()
    gs.add_explosion(200, 200, 35)               # flash (R>=0x1f) grow explosion
    grow = []
    for _ in range(120):
        gs._animate_effects()
        if gs.explosions:
            e = gs.explosions[0]
            grow.append([e["phase"], e["frame"]])
        else:
            grow.append(None)
            break
    out["grow"] = grow

    gs2 = build(make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0), 1, [("A", C.AI_HUMAN, 0, 0)])
    gs2.new_game()
    gs2.add_explosion(150, 150, 18, dirt_only=True)   # stamp style
    stamp = []
    for _ in range(8):
        gs2._animate_effects()
        if gs2.explosions:
            e = gs2.explosions[0]
            stamp.append([e["phase"], e["frame"]])
        else:
            stamp.append(None)
            break
    out["stamp"] = stamp

    gs3 = build(make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0), 1, [("A", C.AI_HUMAN, 0, 0)])
    gs3.new_game()
    gs3.add_firewall(100, 100, 250)
    fw = []
    # _tick_firewall_band ages each wall +1 frame/tick; FIREWALL_FRAMES=120, so the
    # wall expires after 120 ticks and the next tick takes the restore branch.
    for _ in range(125):
        gs3._tick_firewall_band(3)
        fw.append({"n": len(gs3.firewalls), "active": bool(gs3._firewall_band_active)})
    out["firewall_expire"] = fw
    return out


def main():
    payload = {
        "module": "game_flow",
        "field": [W, H],
        "lut_idx": LUT_IDX,
        "terr_x": TERR_X,
        "weapon_fire": scen_weapon_fire(),
        "death_fx": scen_death_fx(),
        "retreat": scen_retreat(),
        "retreat_win": scen_retreat_win(),
        "mass_kill": scen_mass_kill(),
        "win_loss": scen_win_loss(),
        "shop_cycle": scen_shop_cycle(),
        "changing_wind": scen_changing_wind(),
        "shields": scen_shields(),
        "sync_ai_volley": scen_sync_ai_volley(),
        "sim_human": scen_sim_human(),
        "effects": scen_effects(),
        "falling": scen_falling(),
        "resolve_hit": scen_resolve_hit(),
        "triple": scen_triple(),
        "ammo_fallback": scen_ammo_fallback(),
        "elastic": scen_elastic(),
        "team_win": scen_team_win(),
        "arm_edges": scen_arm_edges(),
        "mag_step": scen_mag_step(),
        "explo_tail": scen_explo_tail(),
    }
    os.makedirs(_VECTORS, exist_ok=True)
    path = os.path.join(_VECTORS, "game_flow.json")
    with open(path, "w") as fh:
        json.dump(payload, fh)
    size = os.path.getsize(path)
    print(f"  wrote vectors/game_flow.json  ({size} bytes)")


if __name__ == "__main__":
    main()
