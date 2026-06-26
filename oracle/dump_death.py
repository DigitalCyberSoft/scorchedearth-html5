#!/usr/bin/env python3
"""Oracle vector dumper for the `death` module (tank death sequence + throes).

Drives the Python port's REAL scorch.death functions (the fidelity reference,
itself byte-verified against 1.5/SCORCH.EXE) over deterministic, rng-seeded input
batteries and writes golden vectors to vectors/death.json.  The TypeScript
differential gate (test/death.test.ts) loads this JSON and asserts the TS port
(src/death.ts) reproduces every result EXACTLY (integers / indices / pixels /
booleans / strings).

death.py is integer-only itself (radius truncation + throe/fountain params); the
ONE transcendental dependency is inside damage.explode (the radial-damage law's
math.hypot), which is measured between INTEGER pixel coordinates and so is
bit-exact in the TS port (damage.ts NUMERIC NOTES, already a green gate).  Every
value dumped here is therefore asserted EXACT.

This is a STATIC use of the Python port: it imports scorch.death headless
(SDL_VIDEODRIVER=dummy) and calls its functions against lightweight mock
Tank/Cfg/Terrain/Rng/State objects exposing exactly the duck-typed fields the
sequence reads (catalog 11/20).  It never runs the DOS binary.

DETERMINISM: every battery that touches rng seeds a fresh scorch.rng.Rng(seed)
with a fixed seed, so the TS side (new Rng(seed)) reproduces the same MT19937
stream value-for-value (the rng linchpin is already a green differential gate).

THE DEATH CHAIN: death_sequence -> _spawn_throe (add_explosion / add_throe) ->
_debris_fountain (add_death_fountain, or the fallback add_explosion when the
emitter is absent) -> _final_blast (damage.explode -> carve_circle +
add_explosion + the per-tank radial damage -> apply_tank_damage -> shield gate /
health / kill_tank -> on_tank_destroyed + scoring).  The dumper snapshots EVERY
observable: the throe int returned, the ordered explosion log, the throe-emitter
log, the fountain log, the carve log, the destroyed log, and the post-state of
every tank (health/shield/alive/score/cash).  The TS test rebuilds an identical
mock and asserts each.

Structure copies oracle/dump_weapon_behaviors.py.

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../scorch-py" \
        "../.venv/bin/python" oracle/dump_death.py
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
    """Assertion count for reporting: every leaf result field is one TS expect()."""
    total = 0
    for group in payload.values():
        if not isinstance(group, list):
            continue
        for v in group:
            if not isinstance(v, dict):
                continue
            for key, val in v.items():
                if key in ("fn", "label", "note", "name", "behavior"):
                    continue
                if isinstance(val, list):
                    total += _leaves(val)
                else:
                    total += 1
    return total


def _leaves(x):
    if isinstance(x, list):
        return sum(_leaves(i) for i in x) if x else 1
    if isinstance(x, dict):
        return sum(_leaves(i) for i in x.values()) if x else 1
    return 1


# ---------------------------------------------------------------------------
# Mock structs: the minimal duck-typed shapes scorch.death reads. The TS test
# (test/death.test.ts) builds STRUCTURALLY IDENTICAL mocks so the only thing
# under differential test is the death-sequence arithmetic / control flow.
# These mirror oracle/dump_weapon_behaviors.py's mocks (same field order, same
# callback logging), extended with add_throe / add_death_fountain and state.w.
# ---------------------------------------------------------------------------
import scorch.constants as C  # noqa: E402
from scorch.rng import Rng  # noqa: E402


class MockCfg:
    def __init__(self, sound=True):
        # scoring/team_mode read by damage.explode -> scoring.award_*; pin to
        # values that make the awards deterministic (STANDARD, no teams).
        self.scoring = C.SCORING_STANDARD
        self.team_mode = C.TEAM_NONE
        self._sound = sound

    def is_on(self, key):
        if key == "SOUND":
            return self._sound
        return False


class MockEconomy:
    def unit_price(self, slot):
        return float(slot)


class MockTank:
    def __init__(self, tid, x=200, y=300, color=15, half_width=7, health=100,
                 shield_hp=0, shield_item=0, alive=True, player_index=0,
                 team_id=0):
        self.id = tid
        self.x = x
        self.y = y
        self.color = color
        self.half_width = half_width
        self.health = health
        self.shield_hp = shield_hp
        self.shield_item = shield_item
        self.alive = alive
        self.player_index = player_index
        self.team_id = team_id
        self.score = 0
        self.cash = 0
        self.win_counter = 0
        self.inventory = []
        self.hits_this_round = {}
        self.hits_career = {}


class MockTerrain:
    """The death module only calls terrain.carve_circle (via damage.explode);
    is_supported is on the fall path (never reached here).  Both are LOGGED /
    no-op'd -- the sequence never reads terrain back."""

    def __init__(self, w=360, h=480):
        self.w = w
        self.h = h
        self.carve_circles = []

    def carve_circle(self, cx, cy, r):
        self.carve_circles.append([int(cx), int(cy), int(r)])

    def is_supported(self, x, y, half_width):
        return False


class MockState:
    """The death-sequence game-state surface.  Exposes:
      - the damage-chain fields (cfg/economy/tanks/terrain/current_shooter/
        current_weapon) so damage.explode -> apply_tank_damage -> scoring works,
      - `w` (playfield width) read by the _debris_fountain FALLBACK clamp,
      - rng for the rand(11) throe roulette,
      - explosion_scale for _blast_radius,
      - add_explosion / add_throe / add_death_fountain emitters (logged), and
        on_tank_destroyed (logged).
    `with_fountain=False` DROPS add_death_fountain so the _debris_fountain
    fallback branch (state.add_explosion dirt-puff) is exercised."""

    def __init__(self, cfg=None, tanks=None, terrain=None, rng=None,
                 explosion_scale=1.0, current_shooter=None, current_weapon=None,
                 w=360, with_fountain=True):
        self.cfg = cfg if cfg is not None else MockCfg()
        self.tanks = tanks if tanks is not None else []
        self.terrain = terrain if terrain is not None else MockTerrain(w=w)
        self.rng = rng if rng is not None else Rng(0)
        self.explosion_scale = explosion_scale
        self.current_shooter = current_shooter
        self.current_weapon = current_weapon
        self.economy = MockEconomy()
        self.w = w
        # observable callback logs
        self.explosions = []
        self.throes = []
        self.fountains = []
        self.destroyed = []
        self._with_fountain = with_fountain
        if with_fountain:
            # bind the method only when requested (so hasattr is False otherwise,
            # exactly like a GameState stub lacking the emitter)
            self.add_death_fountain = self._add_death_fountain

    def add_explosion(self, x, y, r, dirt_only=False, nuke=False):
        self.explosions.append([int(x), int(y), int(r), bool(dirt_only),
                                bool(nuke)])

    def add_throe(self, kind, x, y, color):
        self.throes.append([kind, x, y, color])

    def _add_death_fountain(self, x, y, top, color=15, stride=6, scatter=1):
        self.fountains.append([x, y, top, color, stride, scatter])

    def on_tank_destroyed(self, victim, weapon):
        self.destroyed.append([victim.id, weapon is not None])


def _tank_snap(t):
    """Mutated-state snapshot of a tank, in a fixed order the TS reproduces
    (mirrors dump_weapon_behaviors._tank_snap)."""
    return [t.health, t.shield_hp, t.shield_item, bool(t.alive),
            t.score, t.cash, t.win_counter]


def _state_snap(st):
    """Observable game-state callback logs after a death sequence."""
    return {
        "explosions": list(st.explosions),
        "throes": list(st.throes),
        "fountains": list(st.fountains),
        "destroyed": list(st.destroyed),
        "carve_circles": list(st.terrain.carve_circles),
        "current_weapon_name": (st.current_weapon.name
                                if st.current_weapon is not None else None),
    }


# ---------------------------------------------------------------------------
# death dumper
# ---------------------------------------------------------------------------
def dump_death():
    import scorch.death as death
    import scorch.weapons as weapons

    out = {
        "module": "death",
        "consts": [],
        "blast_radius": [],
        "throe_pick": [],
        "spawn_throe": [],
        "debris_fountain": [],
        "debris_fountain_fallback": [],
        "final_blast": [],
        "effect_standard": [],
        "death_sequence": [],
    }

    # -- module constants (each one expect()) --
    out["consts"].append({
        "fn": "const",
        "DEBRIS_PUFF_RADIUS": death.DEBRIS_PUFF_RADIUS,
        "DEBRIS_ROW_STRIDE": death.DEBRIS_ROW_STRIDE,
        "DEBRIS_TOP_MARGIN": death.DEBRIS_TOP_MARGIN,
        "DEATH_BLAST_FALLBACK": death.DEATH_BLAST_FALLBACK,
        "PLAYFIELD_TOP": death.PLAYFIELD_TOP,
        "STANDARD": death.STANDARD,
    })

    # -----------------------------------------------------------------------
    # _blast_radius: int(abs(blast)*scale) for a weapon (every offensive item x
    # every scale), and int(DEATH_BLAST_FALLBACK*scale) for no-weapon / blast-0.
    # Pins the int() truncation toward zero at fractional scales.
    # -----------------------------------------------------------------------
    SCALES = [1.0, 1.5, 2.0, 0.75, 1.33, 2.5]
    for sc in SCALES:
        st = MockState(explosion_scale=sc)
        # weapon path over the whole table (includes tracer blast=0 -> falls to
        # the fallback because eff_radius == 0)
        for it in weapons.ITEMS:
            out["blast_radius"].append({
                "fn": "blast_radius", "idx": it.idx, "name": it.name,
                "blast": it.blast, "scale": sc,
                "out": death._blast_radius(st, it),
            })
        # no-weapon path (weapon=None -> fallback)
        out["blast_radius"].append({
            "fn": "blast_radius", "idx": -1, "name": "None", "blast": 0,
            "scale": sc, "out": death._blast_radius(st, None),
        })
    # explosion_scale ABSENT (getattr default 1.0): a state object built without
    # explosion_scale -- but our MockState always sets it; emulate the default by
    # passing weapon=None on scale 1.0 (already covered) and additionally a state
    # with explosion_scale=1.0 to lock the default-equivalent value.
    out["blast_radius"].append({
        "fn": "blast_radius", "idx": -1, "name": "None_default", "blast": 0,
        "scale": 1.0, "out": death._blast_radius(MockState(explosion_scale=1.0),
                                                 None),
    })

    # -----------------------------------------------------------------------
    # The rand(11) throe roulette stream itself: for each seed, the first N
    # picks of rng.pick(11).  This is the SELECTION the death sequence consumes;
    # asserting the raw stream pins the seeded throe choice exactly (integers).
    # -----------------------------------------------------------------------
    SEEDS = [0, 1, 2, 3, 7, 11, 42, 99, 123, 1234, 2024, 65535, 0xDEADBEEF,
             123456789]
    for s in SEEDS:
        r = Rng(s)
        picks = [r.pick(11) for _ in range(60)]
        out["throe_pick"].append({"fn": "throe_pick", "seed": s, "out": picks})

    # -----------------------------------------------------------------------
    # _spawn_throe: drive EVERY throe value 0..10 over several radii / tank
    # positions / colors, snapshotting the explosion + throe-emitter logs.  Pins
    # case 3 (triple, max(4, r-5) radius), case 4 (r+8 ball), 5-10 (named
    # throes), and 0/1/2 (no flourish).
    # -----------------------------------------------------------------------
    THROE_RADII = [0, 1, 3, 4, 5, 6, 9, 10, 18, 20, 40, 75]
    THROE_TANKS = [
        ("origin", 0, 0, 0),
        ("mid", 200, 300, 7),
        ("neg", -10, -10, 3),
        ("big", 355, 470, 15),
        ("c2", 123, 88, 2),
    ]
    for throe in range(11):
        for (tname, tx, ty, tcol) in THROE_TANKS:
            for radius in THROE_RADII:
                st = MockState()
                tk = MockTank("t", x=tx, y=ty, color=tcol)
                death._spawn_throe(st, tk, throe, radius)
                out["spawn_throe"].append({
                    "fn": "spawn_throe", "throe": throe, "tank": tname,
                    "x": tx, "y": ty, "col": tcol, "radius": radius,
                    "explosions": list(st.explosions),
                    "throes": list(st.throes),
                })

    # -----------------------------------------------------------------------
    # _debris_fountain WITH the emitter present: the add_death_fountain call
    # args (x, y, top, color, stride, scatter) over scatter False/True and
    # several tank positions / colors.  `top` is the constant ef40-7 analogue.
    # -----------------------------------------------------------------------
    for (tname, tx, ty, tcol) in THROE_TANKS:
        for scatter in (False, True):
            st = MockState(with_fountain=True)
            tk = MockTank("t", x=tx, y=ty, color=tcol)
            death._debris_fountain(st, tk, scatter=scatter)
            out["debris_fountain"].append({
                "fn": "debris_fountain", "tank": tname, "x": tx, "y": ty,
                "col": tcol, "scatter": bool(scatter),
                "fountains": list(st.fountains),
                "explosions": list(st.explosions),
            })

    # -----------------------------------------------------------------------
    # _debris_fountain FALLBACK (no add_death_fountain): the dirt-puff
    # add_explosion at the clamped tank X.  Exercise the clamp boundaries
    # max(0, min(w-1, x)) over several widths.
    # -----------------------------------------------------------------------
    for w in (360, 320, 100):
        for tx in (-50, -1, 0, 1, 50, w - 2, w - 1, w, w + 50):
            st = MockState(w=w, with_fountain=False)
            tk = MockTank("t", x=tx, y=250, color=9)
            death._debris_fountain(st, tk, scatter=False)
            out["debris_fountain_fallback"].append({
                "fn": "debris_fountain_fallback", "w": w, "x": tx,
                "explosions": list(st.explosions),
                "fountains": list(st.fountains),
            })

    # -----------------------------------------------------------------------
    # _final_blast: damage.explode at the tank center over several radii, with a
    # battery of tanks at known integer distances so the linear (R-d)*100/R law
    # (round-half-to-even) + kills + scoring all exercise.  The dying tank is
    # placed alive here so the blast at its own center kills it (the re-entrant
    # path the real game produces, since kill_tank already cleared alive before
    # on_tank_destroyed -- both alive and pre-dead variants are covered in
    # death_sequence below).
    # -----------------------------------------------------------------------
    for radius in (10, 18, 20, 40):
        # tanks spread at integer x-offsets so d is exact-integer-grid
        victim = MockTank("v", x=200, y=300, color=7, team_id=2,
                          player_index=0, health=100)
        n1 = MockTank("n1", x=205, y=300, team_id=2, player_index=1,
                      health=100)
        n2 = MockTank("n2", x=215, y=300, team_id=2, player_index=2,
                      health=100)
        n3 = MockTank("n3", x=200, y=312, team_id=2, player_index=3,
                      health=100, shield_hp=40, shield_item=1)
        far = MockTank("far", x=20, y=300, team_id=2, player_index=4,
                       health=100)
        shooter = MockTank("s", x=100, y=300, team_id=1, player_index=5)
        st = MockState(tanks=[victim, n1, n2, n3, far], rng=Rng(1),
                       explosion_scale=1.0, current_shooter=shooter)
        death._final_blast(st, victim, radius)
        out["final_blast"].append({
            "fn": "final_blast", "radius": radius,
            "victim": _tank_snap(victim), "n1": _tank_snap(n1),
            "n2": _tank_snap(n2), "n3": _tank_snap(n3), "far": _tank_snap(far),
            "shooter": _tank_snap(shooter),
            "state": _state_snap(st),
        })

    # -----------------------------------------------------------------------
    # _effect_standard: the byte-confirmed (no-throe) effect = fountain + blast.
    # Snapshot the full ordered logs over a couple radii.
    # -----------------------------------------------------------------------
    for radius in (18, 20):
        for with_fountain in (True, False):
            victim = MockTank("v", x=200, y=300, color=5, team_id=2,
                              player_index=0, health=100)
            shooter = MockTank("s", x=100, y=300, team_id=1, player_index=5)
            st = MockState(tanks=[victim], rng=Rng(2), explosion_scale=1.0,
                           current_shooter=shooter, with_fountain=with_fountain)
            death._effect_standard(st, victim, radius)
            out["effect_standard"].append({
                "fn": "effect_standard", "radius": radius,
                "with_fountain": with_fountain,
                "victim": _tank_snap(victim),
                "state": _state_snap(st),
            })

    # -----------------------------------------------------------------------
    # death_sequence: the full public entry point.  Cover the cross product of:
    #   - many fixed seeds (the throe roulette picks 0..10 across them),
    #   - weapon = a representative item (drives the weapon-scaled radius) AND
    #     weapon = None (the fallback radius 18*scale),
    #   - explosion_scale in {1.0, 2.0},
    #   - the dying tank ALIVE (re-entrant self-kill via the blast) AND pre-dead
    #     (alive=False, the real kill_tank call convention),
    #   - bystanders at known integer distances (killed / damaged / untouched),
    #   - with and without the fountain emitter.
    # Snapshot the returned throe + every tank post-state + the full logs.
    # -----------------------------------------------------------------------
    DS_SEEDS = [0, 1, 2, 3, 7, 11, 42, 99, 1234, 2024, 65535]
    # weapon indices spanning small/large blast: Baby Missile(10), Missile(20),
    # Baby Nuke(40), Nuke(75), and None (fallback).
    DS_WEAPONS = [0, 1, 2, 3, None]
    for seed in DS_SEEDS:
        for widx in DS_WEAPONS:
            for sc in (1.0, 2.0):
                for victim_alive in (True, False):
                    for with_fountain in (True, False):
                        weapon = (weapons.ITEMS[widx]
                                  if widx is not None else None)
                        victim = MockTank("v", x=200, y=300, color=7,
                                          team_id=2, player_index=0,
                                          health=100, alive=victim_alive)
                        # a near bystander (takes partial/lethal damage), a
                        # shielded mid bystander, and a far untouched tank
                        near = MockTank("near", x=206, y=300, team_id=2,
                                        player_index=1, health=100)
                        shielded = MockTank("shield", x=200, y=314, team_id=2,
                                            player_index=2, health=100,
                                            shield_hp=60, shield_item=1)
                        far = MockTank("far", x=20, y=300, team_id=2,
                                       player_index=3, health=100)
                        shooter = MockTank("s", x=100, y=300, team_id=1,
                                           player_index=5)
                        st = MockState(
                            tanks=[victim, near, shielded, far],
                            rng=Rng(seed), explosion_scale=sc,
                            current_shooter=shooter,
                            with_fountain=with_fountain)
                        throe = death.death_sequence(st, victim, weapon)
                        out["death_sequence"].append({
                            "fn": "death_sequence", "seed": seed,
                            "widx": (widx if widx is not None else -1),
                            "wname": (weapon.name if weapon else "None"),
                            "scale": sc, "victim_alive": victim_alive,
                            "with_fountain": with_fountain,
                            "throe": throe,
                            "victim": _tank_snap(victim),
                            "near": _tank_snap(near),
                            "shielded": _tank_snap(shielded),
                            "far": _tank_snap(far),
                            "shooter": _tank_snap(shooter),
                            "state": _state_snap(st),
                        })

    # death_sequence with NO shooter (current_shooter None): the blast deals
    # damage with no hit-counters and no kill award (award_kill returns early on
    # killer None).  Pins the no-attacker branch.
    for seed in (0, 5, 42):
        victim = MockTank("v", x=200, y=300, color=4, team_id=0,
                          player_index=0, health=100, alive=True)
        near = MockTank("near", x=204, y=300, team_id=0, player_index=1,
                        health=100)
        st = MockState(tanks=[victim, near], rng=Rng(seed),
                       explosion_scale=1.0, current_shooter=None)
        throe = death.death_sequence(st, victim, weapons.ITEMS[1])
        out["death_sequence"].append({
            "fn": "death_sequence", "seed": seed, "widx": 1,
            "wname": "Missile_noshooter", "scale": 1.0, "victim_alive": True,
            "with_fountain": True, "throe": throe,
            "victim": _tank_snap(victim), "near": _tank_snap(near),
            "shielded": _tank_snap(near), "far": _tank_snap(near),
            "shooter": [0, 0, 0, False, 0, 0, 0],
            "state": _state_snap(st),
        })

    # death_sequence: empty-tank-list state (no tanks at all) -- the blast loop
    # iterates nothing; only the throe/fountain/carve/add_explosion fire.  Pins
    # the degenerate no-target case over the seeds that pick each throe family.
    for seed in (0, 1, 2, 42):
        victim = MockTank("v", x=180, y=260, color=11, alive=False)
        st = MockState(tanks=[], rng=Rng(seed), explosion_scale=1.0)
        throe = death.death_sequence(st, victim, weapons.ITEMS[0])
        out["death_sequence"].append({
            "fn": "death_sequence", "seed": seed, "widx": 0,
            "wname": "BabyMissile_notanks", "scale": 1.0, "victim_alive": False,
            "with_fountain": True, "throe": throe,
            "victim": _tank_snap(victim),
            "near": [0, 0, 0, False, 0, 0, 0],
            "shielded": [0, 0, 0, False, 0, 0, 0],
            "far": [0, 0, 0, False, 0, 0, 0],
            "shooter": [0, 0, 0, False, 0, 0, 0],
            "state": _state_snap(st),
        })

    return _write("death", out)


DUMPERS = {
    "death": dump_death,
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
