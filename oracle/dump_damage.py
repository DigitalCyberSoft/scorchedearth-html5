#!/usr/bin/env python3
"""Oracle vector dumper for the `damage` module.

Drives the Python port's REAL scorch.damage functions (the fidelity reference,
itself byte-verified against 1.5/SCORCH.EXE) over a deterministic input battery
and writes golden vectors to vectors/damage.json. The TypeScript differential
gate (test/damage.test.ts) loads this JSON and asserts the TS port (src/damage.ts)
reproduces every result EXACTLY.

This is a STATIC use of the Python port: it imports scorch.damage headless
(SDL_VIDEODRIVER=dummy) and calls its pure functions against lightweight mock
Tank/Cfg/Terrain/State objects exposing exactly the duck-typed fields damage
reads (catalog 11 s.1/3/5). It never runs the DOS binary.

What is asserted, and why it is all EXACT (no float epsilon needed):
  * Every damage/health/shield/score/cash/hit-counter output is an INTEGER.
  * The one transcendental on the path is the blast distance math.hypot(dx,dy) in
    explode(); but the engine only measures distance between INTEGER pixel coords,
    so dx,dy are integers, dx*dx+dy*dy is exact, and a single correctly-rounded
    sqrt reproduces CPython's math.hypot bit-for-bit (the TS port uses
    Math.sqrt(dx*dx+dy*dy), MEASURED 0/441 grid mismatches vs the V8 Math.hypot
    split). The dumper STILL records the float d so the test can also assert it
    within a tight epsilon, but the load-bearing damage integers are exact.
  * round() in the damage law is banker's rounding; the TS port's pyRound matches
    CPython round bit-for-bit (MEASURED 0/1109). pyRound is dumped directly too.

Structure copies oracle/dump_scoring.py / oracle/dump_vectors.py.

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../scorch-py" \
        "../.venv/bin/python" oracle/dump_damage.py
"""
import json
import math
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
    """Assertion count for reporting: every leaf result field is one TS expect()."""
    total = 0
    for group in payload.values():
        if not isinstance(group, list):
            continue
        for v in group:
            if not isinstance(v, dict):
                continue
            for key, val in v.items():
                if key in ("fn", "label", "note"):
                    continue
                if isinstance(val, list):
                    # nested lists (tank snapshots, callback logs) -> sum leaves
                    total += _leaves(val)
                else:
                    total += 1
    return total


def _leaves(x):
    if isinstance(x, list):
        return sum(_leaves(i) for i in x)
    if isinstance(x, dict):
        return sum(_leaves(i) for i in x.values())
    return 1


# ---------------------------------------------------------------------------
# Mock structs: the minimal duck-typed shapes damage.py reads. The TS test
# (test/damage.test.ts) builds STRUCTURALLY IDENTICAL mocks so the only thing
# under differential test is damage's own arithmetic / control flow.
# ---------------------------------------------------------------------------
import scorch.constants as C  # noqa: E402


class MockCfg:
    def __init__(self, scoring=C.SCORING_STANDARD, team_mode=C.TEAM_NONE, sound=True):
        self.scoring = scoring
        self.team_mode = team_mode
        self._sound = sound

    def is_on(self, key):
        if key == "SOUND":
            return self._sound
        return False


class MockEconomy:
    # damage never calls net_worth, but State carries an economy for completeness.
    def unit_price(self, slot):
        return float(slot)


class MockTank:
    def __init__(self, tid, x=100, y=100, half_width=8, health=100,
                 shield_hp=0, shield_item=0, alive=True, player_index=0,
                 team_id=0, score=0, cash=0, win_counter=0, inventory=None,
                 parachute_deployed=False, parachutes=0, parachute_threshold=5):
        self.id = tid
        self.x = x
        self.y = y
        self.half_width = half_width
        self.health = health
        self.shield_hp = shield_hp
        self.shield_item = shield_item
        self.alive = alive
        self.player_index = player_index
        self.team_id = team_id
        self.score = score
        self.cash = cash
        self.win_counter = win_counter
        self.inventory = list(inventory) if inventory is not None else []
        self.hits_this_round = {}
        self.hits_career = {}
        self.parachute_deployed = parachute_deployed
        self.parachutes = parachutes
        self.parachute_threshold = parachute_threshold


class MockTerrain:
    """is_supported returns True once the tank's footprint top reaches
    support_y (simulates ground at a fixed depth). carve_circle is logged."""
    def __init__(self, h=480, support_y=None):
        self.h = h
        # If support_y is None the footprint is never supported -> falls to floor.
        self.support_y = support_y
        self.carves = []

    def carve_circle(self, cx, cy, radius):
        self.carves.append([cx, cy, radius])

    def is_supported(self, x, y, half_width):
        if self.support_y is None:
            return False
        return y >= self.support_y


class MockState:
    def __init__(self, cfg=None, tanks=None, terrain=None, current_shooter=None,
                 current_weapon=None):
        self.cfg = cfg if cfg is not None else MockCfg()
        self.tanks = tanks if tanks is not None else []
        self.terrain = terrain if terrain is not None else MockTerrain()
        self.current_shooter = current_shooter
        self.current_weapon = current_weapon
        self.economy = MockEconomy()
        self.explosions = []
        self.destroyed = []

    def add_explosion(self, cx, cy, radius):
        self.explosions.append([cx, cy, radius])

    def on_tank_destroyed(self, victim, weapon):
        # record the victim id and whether a weapon (non-None) was threaded through
        self.destroyed.append([victim.id, weapon is not None])


def _snap(t):
    """Full mutated-state snapshot of a tank, in a fixed order the TS reproduces.
    Order: health, shield_hp, shield_item, alive, score, cash, win_counter."""
    return [t.health, t.shield_hp, t.shield_item, bool(t.alive),
            t.score, t.cash, t.win_counter]


def _hitsnap(t):
    """hit-counter dicts as sorted [[k,v],...] for stable JSON/TS comparison."""
    return {
        "round": [[k, t.hits_this_round[k]] for k in sorted(t.hits_this_round)],
        "career": [[k, t.hits_career[k]] for k in sorted(t.hits_career)],
    }


# ---------------------------------------------------------------------------
# damage dumper
# ---------------------------------------------------------------------------
def dump_damage():
    from scorch import damage

    out = {
        "module": "damage",
        "consts": [],
        "pyround": [],
        "shield_gate": [],
        "apply_tank_damage": [],
        "health_direct": [],
        "direct_hit": [],
        "fall_damage": [],
        "kill_tank": [],
        "shield_chip": [],
        "explode": [],
        "predicted_fall": [],
        "chute_deploy": [],
    }

    # -- module constant: SHIELD_CHIP_FULL == FALLOFF_NUM == 100 --
    out["consts"].append({
        "fn": "const",
        "SHIELD_CHIP_FULL": damage.SHIELD_CHIP_FULL,
        "FALLOFF_NUM": C.FALLOFF_NUM,
        "FALL_DMG_PER_PIXEL": C.FALL_DMG_PER_PIXEL,
    })

    # -- pyRound: banker's rounding over exact halves + damage-law-shaped values.
    rvals = []
    for i in range(0, 401):
        rvals.append(i / 2.0)             # 0,0.5,...,200.0 (all exact halves)
    for R in (8, 10, 40, 200, 3, 7, 16, 33, 150, 100, 5, 9, 11, 15, 250):
        for d in range(0, R):
            rvals.append((R - d) * C.FALLOFF_NUM / R)
    for x in rvals:
        out["pyround"].append({"fn": "pyround", "x": x, "out": round(x)})

    # -- shield_gate(tank, amount): every regime --
    #    D=0; S=0; D<S absorb; D==S destroy-overflow0; D>S overflow; large.
    SG = [
        (0, 0), (0, 50), (50, 0),
        (30, 100), (99, 100), (1, 100),
        (100, 100),                         # D==S -> destroy, overflow 0, absorbed S
        (101, 100), (150, 100), (200, 55),
        (5, 5), (7, 200), (100, 1),
    ]
    for (amount, s_hp) in SG:
        t = MockTank("t", shield_hp=s_hp, shield_item=(1 if s_hp else 0))
        ov, ab = damage.shield_gate(t, amount)
        out["shield_gate"].append({
            "fn": "shield_gate", "amount": amount, "shield_hp_in": s_hp,
            "overflow": ov, "absorbed": ab,
            "shield_hp_out": t.shield_hp, "shield_item_out": t.shield_item,
        })

    # -- apply_tank_damage: shooter present/absent (hit counters); shield absorb
    #    / overflow / destroy / none; kill via overflow; every scoring mode;
    #    friendly vs enemy; sound on/off (no-op must not move numbers). --
    SCORINGS = [C.SCORING_BASIC, C.SCORING_STANDARD, C.SCORING_GREEDY]
    AMOUNTS = [0, -3, 1, 5, 10, 17, 50, 99, 100, 120, 250]
    SHIELDS = [0, 30, 100, 150]
    HEALTHS = [100, 30, 1]
    for sc in SCORINGS:
        for sound in (True, False):
            for has_shooter in (True, False):
                for friendly in (False, True):  # shooter same team as victim
                    for amount in AMOUNTS:
                        for s_hp in SHIELDS:
                            for hp in HEALTHS:
                                cfg = MockCfg(scoring=sc, team_mode=C.TEAM_STANDARD,
                                              sound=sound)
                                victim = MockTank("v", team_id=1, health=hp,
                                                  shield_hp=s_hp,
                                                  shield_item=(1 if s_hp else 0),
                                                  player_index=0)
                                shooter = None
                                tanks = [victim]
                                if has_shooter:
                                    shooter = MockTank(
                                        "s",
                                        team_id=(1 if friendly else 2),
                                        player_index=3)
                                    tanks = [shooter, victim]
                                st = MockState(cfg=cfg, tanks=tanks,
                                               current_shooter=shooter)
                                damage.apply_tank_damage(st, victim, amount)
                                rec = {
                                    "fn": "apply_tank_damage",
                                    "scoring": sc, "sound": bool(sound),
                                    "has_shooter": bool(has_shooter),
                                    "friendly": bool(friendly),
                                    "amount": amount, "shield_hp_in": s_hp,
                                    "health_in": hp,
                                    "victim": _snap(victim),
                                    "victim_hits": _hitsnap(victim),
                                    "destroyed": list(st.destroyed),
                                }
                                if has_shooter:
                                    rec["shooter"] = _snap(shooter)
                                out["apply_tank_damage"].append(rec)

    # -- _apply_health_direct: count_hit True/False; kill; guard amount<=0 and
    #    dead tank; scoring side-effect only when count_hit. --
    for sc in SCORINGS:
        for count_hit in (True, False):
            for amount in [0, -1, 5, 30, 100, 250]:
                for hp in [100, 30, 5]:
                    for alive in (True, False):
                        cfg = MockCfg(scoring=sc, team_mode=C.TEAM_STANDARD)
                        victim = MockTank("v", team_id=1, health=hp, alive=alive,
                                          player_index=0)
                        shooter = MockTank("s", team_id=2, player_index=2)
                        st = MockState(cfg=cfg, tanks=[shooter, victim],
                                       current_shooter=shooter)
                        damage._apply_health_direct(st, victim, amount, count_hit)
                        out["health_direct"].append({
                            "fn": "health_direct", "scoring": sc,
                            "count_hit": bool(count_hit), "amount": amount,
                            "health_in": hp, "alive_in": bool(alive),
                            "victim": _snap(victim),
                            "shooter": _snap(shooter),
                            "destroyed": list(st.destroyed),
                        })

    # -- direct_hit: removes full remaining health; alive gate; kill + score. --
    for sc in SCORINGS:
        for hp in [100, 1, 0, 250]:
            for alive in (True, False):
                cfg = MockCfg(scoring=sc, team_mode=C.TEAM_STANDARD)
                victim = MockTank("v", team_id=1, health=hp, alive=alive,
                                  player_index=0)
                shooter = MockTank("s", team_id=2, player_index=1)
                st = MockState(cfg=cfg, tanks=[shooter, victim],
                               current_shooter=shooter,
                               current_weapon="W")
                damage.direct_hit(st, victim)
                out["direct_hit"].append({
                    "fn": "direct_hit", "scoring": sc, "health_in": hp,
                    "alive_in": bool(alive),
                    "victim": _snap(victim), "shooter": _snap(shooter),
                    "destroyed": list(st.destroyed),
                })

    # -- apply_fall_damage: health-direct, no shield, no hit-counter, no shooter
    #    attribution (so NO score even in STANDARD/GREEDY). Shield must be
    #    ignored (a shielded victim still loses health). --
    for sc in SCORINGS:
        for amount in [0, 2, 10, 50, 100, 250]:
            for hp in [100, 40, 5]:
                for s_hp in [0, 100]:
                    cfg = MockCfg(scoring=sc, team_mode=C.TEAM_STANDARD)
                    # A shooter EXISTS in state but fall damage passes count_hit
                    # False, so no award and no hit counter.
                    shooter = MockTank("s", team_id=2, player_index=4)
                    victim = MockTank("v", team_id=1, health=hp, shield_hp=s_hp,
                                      shield_item=(1 if s_hp else 0),
                                      player_index=0)
                    st = MockState(cfg=cfg, tanks=[shooter, victim],
                                   current_shooter=shooter)
                    damage.apply_fall_damage(st, victim, amount)
                    out["fall_damage"].append({
                        "fn": "fall_damage", "scoring": sc, "amount": amount,
                        "health_in": hp, "shield_hp_in": s_hp,
                        "victim": _snap(victim), "shooter": _snap(shooter),
                        "victim_hits": _hitsnap(victim),
                        "destroyed": list(st.destroyed),
                    })

    # -- kill_tank: alive gate (dead -> no-op); double-kill; weapon explicit vs
    #    fallback to state.current_weapon vs both None; award_kill side-effect
    #    (self/teammate/enemy/no-shooter). --
    KILL_CASES = [
        # (alive, weapon_arg_is_set, state_weapon_set, shooter_rel)
        (True,  False, False, "none"),
        (True,  False, True,  "enemy"),
        (True,  True,  False, "enemy"),
        (True,  True,  True,  "enemy"),
        (True,  False, True,  "self"),
        (True,  False, True,  "teammate"),
        (False, True,  True,  "enemy"),   # already dead -> no-op
    ]
    for sc in SCORINGS:
        for (alive, warg, wstate, rel) in KILL_CASES:
            cfg = MockCfg(scoring=sc, team_mode=C.TEAM_STANDARD)
            victim = MockTank("v", team_id=1, alive=alive, health=50,
                              player_index=0)
            shooter = None
            tanks = [victim]
            if rel == "self":
                shooter = victim
            elif rel == "teammate":
                shooter = MockTank("s", team_id=1, player_index=5)
                tanks = [shooter, victim]
            elif rel == "enemy":
                shooter = MockTank("s", team_id=2, player_index=5)
                tanks = [shooter, victim]
            st = MockState(cfg=cfg, tanks=tanks, current_shooter=shooter,
                           current_weapon=("SW" if wstate else None))
            weapon = "AW" if warg else None
            damage.kill_tank(st, victim, weapon)
            rec = {
                "fn": "kill_tank", "scoring": sc, "alive_in": bool(alive),
                "warg": bool(warg), "wstate": bool(wstate), "rel": rel,
                "victim": _snap(victim),
                "destroyed": list(st.destroyed),
            }
            if shooter is not None and shooter is not victim:
                rec["shooter"] = _snap(shooter)
            out["kill_tank"].append(rec)

    # -- shield_chip: absorb; destroy-on-equal; zero-shield no-op; over-damage
    #    clamp (max(0, ...)); default damage (=SHIELD_CHIP_FULL=100). --
    CHIP = [
        (None, 0), (None, 30), (None, 100), (None, 150),   # default damage 100
        (10, 100), (100, 100), (101, 100), (50, 50), (75, 30), (0, 80),
    ]
    for (dmg, s_hp) in CHIP:
        t = MockTank("t", shield_hp=s_hp, shield_item=(1 if s_hp else 0))
        if dmg is None:
            damage.shield_chip(t)
            used = damage.SHIELD_CHIP_FULL
        else:
            damage.shield_chip(t, dmg)
            used = dmg
        out["shield_chip"].append({
            "fn": "shield_chip", "damage": (None if dmg is None else dmg),
            "used": used, "shield_hp_in": s_hp,
            "shield_hp_out": t.shield_hp, "shield_item_out": t.shield_item,
        })

    # -- explode: the radial damage law over EXACT-distance placements so every
    #    integer output is provably exact on both sides (no libm hypot noise).
    #    Placements: axis-aligned offsets (d == |k|) AND Pythagorean triples
    #    (d == integer hypotenuse). Many radii, the strict d<R gate, dead-tank
    #    skip, carve callbacks, multi-tank, scoring + kills, shield interaction,
    #    carve=False. The float d is recorded too (test asserts within epsilon).
    RADII = [1, 2, 5, 8, 10, 16, 25, 40, 75, 100, 150, 200, 250]
    # (dx, dy) with EXACT integer distance: axis-aligned and Pythagorean triples.
    EXACT_OFFSETS = [
        (0, 0),
        (1, 0), (0, 1), (-1, 0), (0, -1),
        (3, 0), (0, 5), (-7, 0), (0, -11),
        (10, 0), (0, -10), (40, 0), (0, 75),
        (3, 4), (4, 3), (-3, 4), (3, -4), (-3, -4),     # 5
        (6, 8), (-8, 6),                                # 10
        (5, 12), (-12, 5),                              # 13
        (8, 15), (15, -8),                              # 17
        (20, 21),                                       # 29
        (9, 12),                                        # 15
        (12, 16),                                       # 20
        (199, 0), (0, 199), (140, 0),                   # near/within big R edges
    ]
    cx, cy = 300, 300
    for R in RADII:
        for (dx, dy) in EXACT_OFFSETS:
            # single living victim at exact offset; enemy shooter; STANDARD scoring
            cfg = MockCfg(scoring=C.SCORING_STANDARD, team_mode=C.TEAM_STANDARD,
                          sound=True)
            victim = MockTank("v", x=cx + dx, y=cy + dy, team_id=1, health=100,
                              player_index=0)
            shooter = MockTank("s", x=10, y=10, team_id=2, player_index=7)
            st = MockState(cfg=cfg, tanks=[shooter, victim],
                           current_shooter=shooter, current_weapon="EXPL")
            damage.explode(st, cx, cy, R, True)
            d = math.hypot(dx, dy)
            in_range = d < R
            dmg = round((R - d) * C.FALLOFF_NUM / R) if in_range else None
            out["explode"].append({
                "fn": "explode", "R": R, "dx": dx, "dy": dy,
                "cx": cx, "cy": cy,
                "d": d, "in_range": bool(in_range),
                "expected_dmg": dmg,
                "victim": _snap(victim), "shooter": _snap(shooter),
                "victim_hits": _hitsnap(victim),
                "carves": list(st.terrain.carves),
                "explosions": list(st.explosions),
                "destroyed": list(st.destroyed),
            })

    # explode: radius<=0 early return (no carve, no damage); carve=False (no
    # crater/explosion, damage still applied); a kill inside the radial loop;
    # multiple tanks at different rings; a dead tank in the list is skipped;
    # shield absorbs/overflows under a blast.
    EDGE = []
    # radius <= 0
    cfg = MockCfg(scoring=C.SCORING_STANDARD, team_mode=C.TEAM_STANDARD)
    v = MockTank("v", x=cx, y=cy, team_id=1, health=100, player_index=0)
    s = MockTank("s", team_id=2, player_index=1)
    st = MockState(cfg=cfg, tanks=[s, v], current_shooter=s)
    damage.explode(st, cx, cy, 0, True)
    EDGE.append({"fn": "explode_edge", "case": "radius0",
                 "victim": _snap(v), "carves": list(st.terrain.carves),
                 "explosions": list(st.explosions), "destroyed": list(st.destroyed)})
    # negative radius
    v = MockTank("v", x=cx, y=cy, team_id=1, health=100, player_index=0)
    s = MockTank("s", team_id=2, player_index=1)
    st = MockState(cfg=cfg, tanks=[s, v], current_shooter=s)
    damage.explode(st, cx, cy, -5, True)
    EDGE.append({"fn": "explode_edge", "case": "radius_neg",
                 "victim": _snap(v), "carves": list(st.terrain.carves),
                 "explosions": list(st.explosions), "destroyed": list(st.destroyed)})
    # carve=False: no crater logged, damage still applied (point-blank -> 100 kill)
    v = MockTank("v", x=cx, y=cy, team_id=1, health=100, player_index=0)
    s = MockTank("s", team_id=2, player_index=1)
    st = MockState(cfg=cfg, tanks=[s, v], current_shooter=s, current_weapon="W")
    damage.explode(st, cx, cy, 50, False)
    EDGE.append({"fn": "explode_edge", "case": "no_carve",
                 "victim": _snap(v), "carves": list(st.terrain.carves),
                 "explosions": list(st.explosions), "destroyed": list(st.destroyed)})
    # multi-tank rings + a dead tank skipped + a shielded tank
    cfg = MockCfg(scoring=C.SCORING_STANDARD, team_mode=C.TEAM_STANDARD)
    t_center = MockTank("c", x=cx, y=cy, team_id=1, health=100, player_index=0)
    t_ring = MockTank("r", x=cx + 30, y=cy + 40, team_id=1, health=100,
                      player_index=0)  # d=50
    t_far = MockTank("f", x=cx + 300, y=cy, team_id=1, health=100, player_index=0)
    t_dead = MockTank("d", x=cx, y=cy, team_id=1, health=100, alive=False,
                      player_index=0)
    t_shield = MockTank("h", x=cx + 6, y=cy + 8, team_id=1, health=100,
                        shield_hp=40, shield_item=1, player_index=0)  # d=10
    s = MockTank("s", x=5, y=5, team_id=2, player_index=2)
    tanks = [s, t_center, t_ring, t_far, t_dead, t_shield]
    st = MockState(cfg=cfg, tanks=tanks, current_shooter=s, current_weapon="BIG")
    damage.explode(st, cx, cy, 100, True)
    EDGE.append({
        "fn": "explode_edge", "case": "multi",
        "tanks": {t.id: _snap(t) for t in [t_center, t_ring, t_far, t_dead, t_shield]},
        "shooter": _snap(s),
        "carves": list(st.terrain.carves), "explosions": list(st.explosions),
        "destroyed": list(st.destroyed),
    })
    out["explode"].extend(EDGE)

    # -- predicted_fall_damage: support at various depths; floor clamp (h-2);
    #    already-supported (0 px); free fall to floor. Returns 2*pixels. --
    for h in [480, 200, 50]:
        for start_y in [0, 50, 100, 198, 478]:
            for support_y in [None, 0, 50, 100, 150, 300, 478]:
                t = MockTank("t", x=100, y=start_y, half_width=8)
                terr = MockTerrain(h=h, support_y=support_y)
                pred = damage.predicted_fall_damage(terr, t)
                out["predicted_fall"].append({
                    "fn": "predicted_fall", "h": h, "start_y": start_y,
                    "support_y": (-1 if support_y is None else support_y),
                    "out": pred,
                    # tank not moved:
                    "tank_y_after": t.y,
                })

    # -- chute_should_deploy: deployed flag, chutes>=1, threshold==0 (always
    #    deploy), threshold < predicted vs >= predicted. --
    CHUTE = []
    for deployed in (True, False):
        for chutes in (0, 1, 3):
            for thr in (0, 5, 50, 1000):
                for support_y in (None, 100):
                    t = MockTank("t", x=100, y=0, half_width=8,
                                 parachute_deployed=deployed, parachutes=chutes,
                                 parachute_threshold=thr)
                    terr = MockTerrain(h=480, support_y=support_y)
                    pred = damage.predicted_fall_damage(terr, t)
                    res = damage.chute_should_deploy(terr, t)
                    CHUTE.append({
                        "fn": "chute_deploy", "deployed": bool(deployed),
                        "chutes": chutes, "threshold": thr,
                        "support_y": (-1 if support_y is None else support_y),
                        "predicted": pred, "out": bool(res),
                    })
    out["chute_deploy"].extend(CHUTE)

    return _write("damage", out)


DUMPERS = {
    "damage": dump_damage,
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
