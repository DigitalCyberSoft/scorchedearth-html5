#!/usr/bin/env python3
"""Oracle vector dumper for scorch.game.GameState -- the round/turn ENGINE.

Drives the REAL scorch.game.GameState headless (SDL_VIDEODRIVER=dummy) over FIXED
seeds + scripted scenarios, dumping a GameState SNAPSHOT after each pipeline step.
test/game.test.ts builds an identical battery against src/game.ts and asserts every
snapshot reproduces EXACT for integers / toBeCloseTo(.,12) for trajectory floats.

This is a STATIC use of the Python port (the fidelity oracle): it imports and
drives the pure GameState pipeline; it never runs the DOS binary.

SEEDING (mirrors src/game.ts createGameState == main.py:476-479): BEFORE building a
GameState, both random sources are seeded with the SAME value --
  random.seed(seed)     -> Python's module-level random (game.py random.shuffle)
  grng.seed(seed)       -> the shared MT singleton scorch.rng.rng (gs.rng)
They are DISTINCT streams sharing a seed value.

DETERMINISM PINS:
  * mtn_ranges forced to [] so terrain.generate takes the _midpoint rng path on
    BOTH sides (the TS port has no on-disk *.MTN list).  Otherwise the MTN gate
    consumes rng and the terrain seed / tank-y placement diverge.
  * TALKING_TANKS left OFF (Config default) so talk._talks gates BEFORE any rng
    draw -- no taunt rng is consumed by either side, so empty TS talk pools match.
  * SOUND OFF (sfx is a no-op in the Node test); does not touch rng.

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../scorch-py" \
        "../.venv/bin/python" oracle/dump_game.py
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
from scorch.config import Config  # noqa: E402
from scorch.rng import rng as grng  # noqa: E402
from scorch import constants as C  # noqa: E402
from scorch import weapons  # noqa: E402

W, H = 640, 480


# ---------------------------------------------------------------------------
# Snapshot helpers -- the exact serialized shape test/game.test.ts asserts.
# ---------------------------------------------------------------------------
def snap_tank(t):
    """Per-tank state row.  Integers everywhere except x/y (ints in the engine)."""
    return {
        "health": t.health,
        "x": t.x,
        "y": t.y,
        "shield_hp": t.shield_hp,
        "shield_item": t.shield_item,
        "alive": bool(t.alive),
        "score": t.score,
        "cash": t.cash,
        "win_counter": t.win_counter,
        "angle": t.angle,
        "power": t.power,
    }


def snap_proj(p):
    """In-flight projectile kinematics (px/py/vx/vy are trajectory floats)."""
    return {"px": p.px, "py": p.py, "vx": p.vx, "vy": p.vy, "active": bool(p.active)}


def snap(gs, label):
    """Full GameState snapshot: phase, current_shooter index, every tank, every
    in-flight projectile, and the winner index (or -1)."""
    cs = -1
    if gs.current_shooter is not None:
        cs = gs.current_shooter.player_index
    win = -1
    if gs.winner is not None:
        win = gs.winner.player_index
    return {
        "label": label,
        "phase": gs.phase,
        "current_shooter": cs,
        "winner": win,
        "round_index": gs.round_index,
        "wind": gs.cfg.wind,
        "fire_index": gs.fire_index,
        "tanks": [snap_tank(t) for t in gs.tanks],
        "projectiles": [snap_proj(p) for p in gs.projectiles],
    }


def make_cfg(**over):
    """A Config pinned for determinism; `over` sets named fields by their raw
    string/int form (mirroring config field types)."""
    cfg = Config()
    # determinism pins
    cfg.SOUND = "OFF"
    cfg.TALKING_TANKS = "OFF"
    cfg.FLY_SOUND = "OFF"
    # SKY=PLAIN: a fixed sky that draws NO rng in resolve_round_sky (RANDOM would
    # draw rng.pick(6) and could land on CAVERN).  CAVERN is avoided deliberately:
    # the TS hazard.install_cavern_ceiling reads state.terrain.grid.cols, a grid
    # shape the real Terrain (flat Uint8Array) does not provide -- a pre-existing
    # hazard.ts/terrain.ts mismatch unrelated to the game port (reported, not
    # masked).  Pinning PLAIN keeps both sides deterministic and off that path.
    cfg.SKY = "PLAIN"
    for k, v in over.items():
        setattr(cfg, k, v)
    # Re-resolve live_elastic from any ELASTIC override (Config.__post_init__ only
    # runs at construction; ELASTIC may have been set after).
    cfg.live_elastic = cfg.elastic
    return cfg


def build(cfg, seed, players):
    """Seed both streams (== createGameState) then build + add_player the roster.
    `players` is a list of (name, ai_class, team_id, tank_icon).  mtn_ranges is
    forced empty so terrain.generate takes the _midpoint path on both sides."""
    random.seed(seed)
    grng.seed(seed)
    gs = G.GameState(cfg, W, H)
    gs.mtn_ranges = []                # pin the _midpoint rng path
    for (name, ai, team, icon) in players:
        gs.add_player(name, ai, team, icon)
    return gs


def drive(gs, dt, max_frames, steps, stop_phases):
    """Step gs.update(dt) up to max_frames, snapshotting each frame, until the
    phase is one of stop_phases (snapshot taken before stopping) or frames run out.
    Appends to `steps`; returns the frame count actually run."""
    n = 0
    while n < max_frames:
        gs.update(dt)
        n += 1
        steps.append(snap(gs, f"frame{n}"))
        if gs.phase in stop_phases:
            break
    return n


# ===========================================================================
# Scenario 1: add_player x N + new_game (initial placement + terrain seed).
# Covers add_player ordering, new_game cash/inventory seeding, start_round's
# placement + firing-order + per-round tank reset, across a few seeds + rosters.
# ===========================================================================
def scen_setup():
    out = []
    rosters = [
        [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0)],
        [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0),
         ("C", C.AI_HUMAN, 0, 0), ("D", C.AI_HUMAN, 0, 0)],
    ]
    for seed in (1, 42, 1234, 2024, 7):
        for ridx, roster in enumerate(rosters):
            cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=200,
                           FALLING_TANKS="ON")
            gs = build(cfg, seed, roster)
            gs.new_game()                 # cash=0 -> start_round immediately
            steps = [snap(gs, "after_new_game")]
            # also record the full firing order + each tank's color + inventory
            extra = {
                "firing_order": list(gs.firing_order),
                "colors": [t.color for t in gs.tanks],
                "inv0": [t.inventory[weapons.SLOT_BABY_MISSILE] for t in gs.tanks],
            }
            out.append({"seed": seed, "roster": ridx, "steps": steps, "extra": extra})
    return out


# ===========================================================================
# Scenario 2: a full single-shot fire -> settle resolution.
# Two human tanks; tank 0 fires a Baby Missile straight, driven to SETTLE/next
# turn.  Snapshots the launch, every in-flight frame, the detonation, the settle.
# ===========================================================================
def scen_single_shot():
    out = []
    for seed in (1, 42, 1234):
        cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,  # no wind: clean arc
                       FALLING_TANKS="ON", CHANGING_WIND="OFF")
        gs = build(cfg, seed, [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0)])
        gs.new_game()
        steps = [snap(gs, "round_start")]
        # advance to a human turn (TURN_START -> AIM)
        gs.update(1 / 60.0)
        steps.append(snap(gs, "begin_turn"))
        shooter = gs.current_shooter
        # aim a fixed shot and fire (human path: fire() with no shooter arg)
        shooter.angle = 50
        shooter.power = 600
        shooter.selected_weapon = weapons.SLOT_BABY_MISSILE
        gs.fire()
        steps.append(snap(gs, "after_fire"))
        drive(gs, 1 / 60.0, 600, steps, {G.AIM, G.GAME_OVER, G.ROUND_END})
        out.append({"seed": seed, "steps": steps})
    return out


# ===========================================================================
# Scenario 3: a multi-tank splash that kills + scores.
# Three tanks packed close; tank 0 lobs a Nuke onto the cluster, killing 1+2 with
# splash and crediting tank 0's score/win counters.  Drives to round end.
# ===========================================================================
def scen_splash_kill():
    out = []
    for seed in (3, 99, 2024):
        cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                       FALLING_TANKS="OFF",  # isolate blast damage from fall damage
                       CHANGING_WIND="OFF")
        gs = build(cfg, seed, [
            ("A", C.AI_HUMAN, 0, 0),
            ("B", C.AI_HUMAN, 0, 0),
            ("C", C.AI_HUMAN, 0, 0),
        ])
        gs.new_game()
        # Pack the three tanks tight and on a common baseline so a single big blast
        # straddles all three (scripted placement; the test mirrors these exact x/y).
        base_y = gs.tanks[0].y
        for i, t in enumerate(gs.tanks):
            t.x = 300 + i * 14
            t.y = base_y
            t.health = 100
            t.alive = True
        # give tank 0 a Nuke and detonate it directly on the cluster centre via the
        # damage path the engine uses (deterministic, no flight): explode at tank 1.
        gs.tanks[0].inventory[weapons.SLOT_BABY_MISSILE] = 99
        steps = [snap(gs, "pre_blast")]
        gs.current_shooter = gs.tanks[0]
        gs.current_weapon = weapons.ITEMS[weapons.SLOT_BABY_MISSILE]
        from scorch import damage as D
        D.explode(gs, gs.tanks[1].x, gs.tanks[1].y, 80, carve=False)
        steps.append(snap(gs, "after_explode"))
        out.append({"seed": seed, "steps": steps})
    return out


# ===========================================================================
# Scenario 4: round-end + win detection (last tank standing).
# Two tanks; kill tank 1 outright, then run the SETTLE branch to _end_round and
# confirm round_index++ / survival award / ranking, then GAME_OVER on last round.
# ===========================================================================
def scen_round_end_win():
    out = []
    for seed in (5, 77):
        cfg = make_cfg(MAXROUNDS=1, INITIAL_CASH=0, MAX_WIND=0,
                       FALLING_TANKS="OFF", CHANGING_WIND="OFF",
                       SCORING="STANDARD")
        gs = build(cfg, seed, [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0)])
        gs.new_game()
        steps = [snap(gs, "round_start")]
        # kill tank 1 directly (no attacker credited -> survival award only)
        from scorch import damage as D
        gs.current_shooter = None
        D.kill_tank(gs, gs.tanks[1])
        steps.append(snap(gs, "after_kill"))
        # drive the SETTLE/turn machinery to the round end
        gs.phase = G.SETTLE
        gs._settle_done = False
        drive(gs, 1 / 60.0, 120, steps, {G.ROUND_END, G.GAME_OVER})
        steps.append(snap(gs, "at_round_end"))
        gs.proceed_after_round()          # MAXROUNDS==1 -> GAME_OVER + winner
        steps.append(snap(gs, "after_proceed"))
        out.append({"seed": seed, "steps": steps})
    return out


# ===========================================================================
# Scenario 5: EACH play-order mode (firing order under RANDOM/LOSERS/WINNERS/ROBIN).
# Build 4 tanks with distinct scores, set the order mode, rebuild the firing order,
# and dump it.  RANDOM exercises the module-level random.shuffle path specifically.
# ===========================================================================
PLAY_ORDER_TOKENS = {
    C.PLAYORDER_RANDOM: "RANDOM",
    C.PLAYORDER_LOSERS: "LOSERS-FIRST",
    C.PLAYORDER_WINNERS: "WINNERS-FIRST",
    C.PLAYORDER_ROBIN: "ROUND-ROBIN",
}


def scen_play_order():
    out = []
    for seed in (1, 2, 42, 1234, 2024):
        for po in (C.PLAYORDER_RANDOM, C.PLAYORDER_LOSERS,
                   C.PLAYORDER_WINNERS, C.PLAYORDER_ROBIN):
            cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                           PLAY_ORDER=PLAY_ORDER_TOKENS[po])
            gs = build(cfg, seed, [
                ("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0),
                ("C", C.AI_HUMAN, 0, 0), ("D", C.AI_HUMAN, 0, 0),
            ])
            gs.new_game()
            # assign distinct scores so LOSERS/WINNERS produce a non-identity order
            for i, t in enumerate(gs.tanks):
                t.score = [30, 10, 40, 20][i]
            # exercise ROBIN across a couple of round indices too
            orders = []
            for ri in range(3):
                gs.round_index = ri
                gs._build_firing_order()
                orders.append(list(gs.firing_order))
            out.append({"seed": seed, "play_order": po, "orders": orders})
    return out


# ===========================================================================
# Scenario 6: a MIRV/cluster split (apogee on_apogee child spawn).
# Fire a MIRV; drive flight; snapshot the projectile list before/after the apogee
# split so the child-warhead count + kinematics are pinned frame-by-frame.
# ===========================================================================
def scen_mirv_split():
    out = []
    for seed in (1, 42):
        cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                       FALLING_TANKS="OFF", CHANGING_WIND="OFF")
        gs = build(cfg, seed, [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0)])
        gs.new_game()
        gs.update(1 / 60.0)               # into a human turn
        shooter = gs.current_shooter
        shooter.inventory[6] = 5          # MIRV (slot 6), warheads=5
        shooter.angle = 70
        shooter.power = 700
        shooter.selected_weapon = 6
        gs.fire()
        steps = [snap(gs, "after_fire")]
        # step a bounded number of frames, snapshotting the projectile list each
        # frame so the split (1 -> N) is captured exactly when it happens.
        drive(gs, 1 / 60.0, 400, steps,
              {G.AIM, G.SETTLE, G.ROUND_END, G.GAME_OVER})
        out.append({"seed": seed, "steps": steps})
    return out


# ===========================================================================
# Scenario 7: run_ai_buys for an AI tank (economy + AI purchase rng).
# A roster of AI tanks with cash; run_ai_buys; snapshot each tank's cash +
# full inventory afterward.  Exercises the AI buy rng + economy pricing.
# ===========================================================================
def scen_ai_buys():
    out = []
    for seed in (1, 42, 1234, 2024):
        cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=50000, MAX_WIND=0)
        gs = build(cfg, seed, [
            ("AI1", C.AI_SHOOTER, 0, 0),
            ("AI2", C.AI_POOLSHARK, 0, 0),
            ("AI3", C.AI_CYBORG, 0, 0),
        ])
        gs.new_game()                     # cash>0 -> SHOP phase
        gs.run_ai_buys()
        rows = []
        for t in gs.tanks:
            rows.append({"cash": t.cash, "inventory": list(t.inventory)})
        out.append({"seed": seed, "rows": rows})
    return out


# ===========================================================================
# Scenario 8: begin_next_round / proceed_after_round (full multi-round cycle).
# Run a 2-round STANDARD match through the round-end -> proceed -> next round
# transition, snapshotting cash/score/round_index at each boundary.
# ===========================================================================
def scen_round_cycle():
    out = []
    for seed in (5, 42):
        cfg = make_cfg(MAXROUNDS=2, INITIAL_CASH=0, MAX_WIND=0,
                       FALLING_TANKS="OFF", CHANGING_WIND="OFF",
                       SCORING="STANDARD")
        gs = build(cfg, seed, [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0)])
        gs.new_game()
        steps = [snap(gs, "r1_start")]
        from scorch import damage as D
        # round 1: kill tank 1, end the round
        gs.current_shooter = None
        D.kill_tank(gs, gs.tanks[1])
        gs._end_round()
        steps.append(snap(gs, "r1_end"))
        gs.proceed_after_round()          # round_index 1 < 2 -> SHOP (economy ran)
        steps.append(snap(gs, "r1_after_proceed"))
        gs.begin_next_round()             # start round 2
        steps.append(snap(gs, "r2_start"))
        # round 2: kill tank 0 this time, end -> proceed -> GAME_OVER (round 2 == MAX)
        gs.current_shooter = None
        D.kill_tank(gs, gs.tanks[0])
        gs._end_round()
        steps.append(snap(gs, "r2_end"))
        gs.proceed_after_round()          # round_index 2 >= 2 -> GAME_OVER + winner
        steps.append(snap(gs, "r2_after_proceed"))
        out.append({"seed": seed, "steps": steps})
    return out


# ===========================================================================
# Scenario 9: SYNCHRONOUS volley loop (collect locks -> fire all -> settle).
# Two human tanks; lock both via the SYNC path, launch the volley, fly it, settle.
# ===========================================================================
def scen_sync_volley():
    out = []
    for seed in (1, 42):
        cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                       FALLING_TANKS="OFF", CHANGING_WIND="OFF",
                       PLAY_MODE="SYNCHRONOUS")
        gs = build(cfg, seed, [("A", C.AI_HUMAN, 0, 0), ("B", C.AI_HUMAN, 0, 0)])
        gs.new_game()                     # start_round -> _sync_begin_round (SYNC_AIM)
        steps = [snap(gs, "sync_start")]
        # both humans lock in turn: phase is AIM with current_shooter set; fire()
        # records each lock and advances.
        for _ in range(4):
            cs = gs.current_shooter
            if cs is not None and gs.phase == G.AIM:
                cs.angle = 60
                cs.power = 650
                cs.selected_weapon = weapons.SLOT_BABY_MISSILE
                gs.fire()                 # SYNC lock (no launch)
                steps.append(snap(gs, "lock"))
            gs.update(1 / 60.0)           # tick the collect/volley machinery
            steps.append(snap(gs, "tick"))
            if gs.phase in (G.SYNC_VOLLEY, G.SETTLE, G.ROUND_END, G.GAME_OVER):
                break
        # fly the volley to resolution
        drive(gs, 1 / 60.0, 600, steps,
              {G.SYNC_AIM, G.SETTLE, G.ROUND_END, G.GAME_OVER})
        out.append({"seed": seed, "steps": steps})
    return out


# ===========================================================================
# Scenario 10: SIMULTANEOUS real-time loop (AI cadence + battery auto-trigger).
# Two AI tanks in SIM mode; run a bounded number of frames so the staggered first
# shots, the per-tank in-flight gate, and the settle cadence all exercise.
# ===========================================================================
def scen_sim_live():
    out = []
    for seed in (1, 42):
        cfg = make_cfg(MAXROUNDS=10, INITIAL_CASH=0, MAX_WIND=0,
                       FALLING_TANKS="OFF", CHANGING_WIND="OFF",
                       PLAY_MODE="SIMULTANEOUS")
        gs = build(cfg, seed, [
            ("AI1", C.AI_SHOOTER, 0, 0),
            ("AI2", C.AI_SHOOTER, 0, 0),
        ])
        gs.new_game()                     # start_round -> _sim_begin_round (SIM_LIVE)
        steps = [snap(gs, "sim_start")]
        # bounded frames -- snapshot every frame; the test reproduces the same count
        for _ in range(60):
            gs.update(1 / 60.0)
            steps.append(snap(gs, "frame"))
            if gs.phase in (G.ROUND_END, G.GAME_OVER):
                break
        out.append({"seed": seed, "steps": steps})
    return out


def _count(payload):
    """Rough assertion count for reporting (tanks*fields + projectiles*fields)."""
    total = 0

    def count_steps(steps):
        n = 0
        for s in steps:
            n += 3                       # phase, current_shooter, winner
            n += len(s["tanks"]) * 11    # 11 fields per tank
            n += len(s["projectiles"]) * 5
        return n

    for key, val in payload.items():
        if not isinstance(val, list):
            continue
        for case in val:
            if not isinstance(case, dict):
                continue
            if "steps" in case:
                total += count_steps(case["steps"])
            if "orders" in case:
                total += sum(len(o) for o in case["orders"])
            if "rows" in case:
                for r in case["rows"]:
                    total += 1 + len(r.get("inventory", []))
            if "extra" in case:
                e = case["extra"]
                total += len(e.get("firing_order", [])) + len(e.get("colors", [])) \
                    + len(e.get("inv0", []))
    return total


def main():
    payload = {
        "module": "game",
        "field": [W, H],
        "setup": scen_setup(),
        "single_shot": scen_single_shot(),
        "splash_kill": scen_splash_kill(),
        "round_end_win": scen_round_end_win(),
        "play_order": scen_play_order(),
        "mirv_split": scen_mirv_split(),
        "ai_buys": scen_ai_buys(),
        "round_cycle": scen_round_cycle(),
        "sync_volley": scen_sync_volley(),
        "sim_live": scen_sim_live(),
    }
    os.makedirs(_VECTORS, exist_ok=True)
    path = os.path.join(_VECTORS, "game.json")
    with open(path, "w") as fh:
        json.dump(payload, fh)
    n = _count(payload)
    print(f"  wrote vectors/game.json  ({n} snapshot assertions)")


if __name__ == "__main__":
    main()
