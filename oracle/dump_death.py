#!/usr/bin/env python3
"""Oracle vector dumper for the `death` module (kill roulette + ascension).

Drives the Python port's REAL scorch.death functions (the fidelity reference,
itself byte-verified against 1.5/SCORCH.EXE -- the FUN_271b_0005 kill roulette
+ the FUN_3ef5_029a ascension, scorch-re/notes_death_throe_roulette.md) over
deterministic, rng-seeded input batteries and writes golden vectors to
vectors/death.json.  The TypeScript differential gate (test/death.test.ts)
loads this JSON and asserts the TS port (src/death.ts) reproduces every result
EXACTLY (integers / indices / signals / booleans / strings).

death.py is integer-only itself (radius truncation, the rand(11) roll, the
sink-depth pick, the ball-steps pick); the one transcendental dependency lives
in the callee: damage.explode's radial law measures INTEGER pixel coordinates
(bit-exact in the TS port, the damage.ts NUMERIC NOTES result).  No roulette
case spawns a projectile or consumes ammo (byte-verified); the staged battery
still pins step_queue's live-flight HOLD by injecting a mock flight.  Every
value dumped here is therefore asserted EXACT.

This is a STATIC use of the Python port: it imports scorch.death headless
(SDL_VIDEODRIVER=dummy) and calls its functions against lightweight mock
Tank/Cfg/Terrain/Rng/State objects exposing exactly the duck-typed fields the
sequences read.  It never runs the DOS binary.

DETERMINISM: every battery that touches rng seeds a fresh scorch.rng.Rng(seed)
(the MT19937 linchpin, a green gate).  Batteries that must exercise a SPECIFIC
roulette case wrap the seeded Rng in _ForcedPicks: a delegate whose first
pick(11) calls return scripted rolls, everything else passing through -- the
same scripted-roll technique the engine smoke checks use, mirrored 1:1 in the
TS test.

THE DEATH CHAIN under test:
  * death_sequence  -> enqueue (queue states) / _roll_throe+_case_body_immediate
                       (stub states without death_queue)
  * retreat_sequence-> enqueue ascension / immediate fountain+grave blast
  * step_queue      -> the staged FIFO: award/front/thud/blast/sink/cookoff/
                       climb signals, stage waits on throe_fx / death_fountains,
                       the live-projectile hold, chain FIFO order
  * _debris_fountain / _blast_radius / _roll_throe helpers

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
                if key in ("fn", "label", "note", "name", "behavior", "case"):
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
# callback logging), extended with the queue surface (death_queue / throe_fx /
# death_fountains / projectiles), the cook-off predicate fields
# (selected_weapon / has_ammo), state.h (the sink floor clamp) and the
# ICON_BAR / SUSPEND_DIRT cfg reads.
# ---------------------------------------------------------------------------
import scorch.constants as C  # noqa: E402
from scorch.rng import Rng  # noqa: E402


class _ForcedPicks:
    """Delegate rng wrapper: the first len(forced) pick(11) calls return the
    scripted rolls in order; every other pick (and every later pick(11))
    delegates to the real seeded Rng.  Lets a battery drive a SPECIFIC roulette
    case while the case body's own picks (ball steps, sink depth, cook-off
    angle/power) stay on the shared deterministic stream."""

    def __init__(self, rng, forced):
        self._rng = rng
        self._forced = list(forced)

    def pick(self, n):
        if n == 11 and self._forced:
            return self._forced.pop(0)
        return self._rng.pick(n)


class MockCfg:
    def __init__(self, sound=True, icon_bar=False, suspend_dirt=0):
        # scoring/team_mode read by damage.explode -> scoring.award_*; pin to
        # values that make the awards deterministic (STANDARD, no teams).
        self.scoring = C.SCORING_STANDARD
        self.team_mode = C.TEAM_NONE
        # _roll_throe's case-8 reroll gate (DAT_5f38_50d8 analogue).
        self.SUSPEND_DIRT = suspend_dirt
        self._sound = sound
        self._icon_bar = icon_bar

    def is_on(self, key):
        if key == "SOUND":
            return self._sound
        if key == "ICON_BAR":
            # _debris_fountain's top clip: bar bottom (29) vs playfield top (9).
            return self._icon_bar
        return False


class MockEconomy:
    def unit_price(self, slot):
        return float(slot)


class MockTank:
    def __init__(self, tid, x=200, y=300, color=15, half_width=7, health=100,
                 shield_hp=0, shield_item=0, alive=True, player_index=0,
                 team_id=0, selected_weapon=0, ammo=0):
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
        # case-10 predicate surface: armed weapon + a flat per-slot ammo store.
        # The mock's has_ammo is deliberately simpler than objects.Tank (no
        # slot-0 infinite special case) so the predicate outcome is pinned by
        # `ammo` alone; identical in the TS mock.  Nothing is consumed (the
        # decoded cook-off is a visual hull scatter).
        self.selected_weapon = selected_weapon
        self.inventory = [0] * 80
        self.inventory[selected_weapon] = ammo
        self.hits_this_round = {}
        self.hits_career = {}

    def has_ammo(self, slot):
        return self.inventory[slot] > 0


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
    """The death game-state surface.  Exposes:
      - the damage-chain fields (cfg/economy/tanks/terrain/current_shooter/
        current_weapon) so damage.explode -> apply_tank_damage -> scoring works,
      - `w`/`h` (playfield dims: the fallback clamp + the sink floor clamp),
      - rng for the rand(11) roulette + per-case picks,
      - explosion_scale for _blast_radius/_scaled,
      - add_explosion / add_throe / add_death_fountain emitters (logged), and
        on_tank_destroyed (logged).
    `with_fountain=False` DROPS add_death_fountain so the _debris_fountain
    fallback branch (state.add_explosion dirt-puff) is exercised.
    `with_queue=True` binds the STAGED surface (death_queue + throe_fx +
    death_fountains + projectiles); the emit recorders then ALSO append live
    entries (ttl-tagged) so step_queue's stage waits see them; without it the
    attributes are ABSENT and death_sequence/retreat_sequence take their
    immediate stub paths, exactly like a bare GameState stub."""

    THROE_TTL = 3        # mock throe lifetime in ticks (aged by the driver)
    FOUNTAIN_TTL = 2     # mock fountain (0x60c3 climb) lifetime in ticks

    def __init__(self, cfg=None, tanks=None, terrain=None, rng=None,
                 explosion_scale=1.0, current_shooter=None, current_weapon=None,
                 w=360, h=480, with_fountain=True, with_queue=False):
        self.cfg = cfg if cfg is not None else MockCfg()
        self.tanks = tanks if tanks is not None else []
        self.terrain = terrain if terrain is not None else MockTerrain(w=w, h=h)
        self.rng = rng if rng is not None else Rng(0)
        self.explosion_scale = explosion_scale
        self.current_shooter = current_shooter
        self.current_weapon = current_weapon
        self.economy = MockEconomy()
        self.w = w
        self.h = h
        # observable callback logs
        self.explosions = []
        self.throes = []
        self.fountains = []
        self.destroyed = []
        self._with_fountain = with_fountain
        self._with_queue = with_queue
        if with_fountain:
            # bind the method only when requested (so hasattr is False otherwise,
            # exactly like a GameState stub lacking the emitter)
            self.add_death_fountain = self._add_death_fountain
        if with_queue:
            self.death_queue = []
            self.throe_fx = []
            self.death_fountains = []
            self.projectiles = []

    def add_explosion(self, x, y, r, dirt_only=False, nuke=False):
        self.explosions.append([int(x), int(y), int(r), bool(dirt_only),
                                bool(nuke)])

    def add_throe(self, kind, x, y, color, life=None):
        self.throes.append([kind, x, y, color,
                            life if life is not None else None])
        if self._with_queue:
            self.throe_fx.append({"ttl": self.THROE_TTL})

    def _add_death_fountain(self, x, y, top, color=15, stride=6, scatter=1):
        self.fountains.append([x, y, top, color, stride, scatter])
        if self._with_queue:
            self.death_fountains.append({"ttl": self.FOUNTAIN_TTL})

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


def _sig_json(sig, payload):
    """JSON-able form of a step_queue (signal, payload) tuple: the award
    payload is the tank object -> its id; front/blast payloads are ints."""
    if hasattr(payload, "id"):
        return [sig, payload.id]
    return [sig, payload]


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
        "roll_throe": [],
        "sequence_immediate": [],
        "retreat_stub": [],
        "debris_fountain": [],
        "debris_fountain_fallback": [],
        "staged": [],
    }

    # -- module constants (each one expect()) --
    out["consts"].append({
        "fn": "const",
        "THROE_FRONT_TICKS": death.THROE_FRONT_TICKS,
        "THROE_DELAY_TICKS": death.THROE_DELAY_TICKS,
        "RADIUS_SMALL": death.RADIUS_SMALL,
        "RADIUS_LARGE": death.RADIUS_LARGE,
        "RADIUS_CAP": death.RADIUS_CAP,
        "SINK_DEPTH_MIN": death.SINK_DEPTH_MIN,
        "SINK_DEPTH_RAND": death.SINK_DEPTH_RAND,
        "BALL_STEP_FRAMES": death.BALL_STEP_FRAMES,
        "DEBRIS_PUFF_RADIUS": death.DEBRIS_PUFF_RADIUS,
        "DEBRIS_ROW_STRIDE": death.DEBRIS_ROW_STRIDE,
        "DEBRIS_TOP_MARGIN": death.DEBRIS_TOP_MARGIN,
        "DEATH_BLAST_FALLBACK": death.DEATH_BLAST_FALLBACK,
        "PLAYFIELD_TOP": death.PLAYFIELD_TOP,
        "STATUS_BAR_H": death.STATUS_BAR_H,
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
    # explosion_scale=1.0 lock for the default-equivalent value.
    out["blast_radius"].append({
        "fn": "blast_radius", "idx": -1, "name": "None_default", "blast": 0,
        "scale": 1.0, "out": death._blast_radius(MockState(explosion_scale=1.0),
                                                 None),
    })

    # -----------------------------------------------------------------------
    # _roll_throe: the rand(11) roulette WITH the byte-decoded case-8 reroll
    # (FUN_271b_0005 offsets 00f4..010a).  For each seed, 40 sequential rolls
    # with SUSPEND_DIRT 0 (raw stream, 8 permitted) and 35 (nonzero -> every 8
    # rerolled away, consuming extra stream picks).  Pins the seeded selection
    # AND the reroll's stream-position effect exactly (integers).
    # -----------------------------------------------------------------------
    SEEDS = [0, 1, 2, 3, 7, 11, 42, 99, 123, 1234, 2024, 65535, 0xDEADBEEF,
             123456789]
    for s in SEEDS:
        for suspend in (0, 35):
            st = MockState(cfg=MockCfg(suspend_dirt=suspend), rng=Rng(s))
            rolls = [death._roll_throe(st) for _ in range(40)]
            out["roll_throe"].append({"fn": "roll_throe", "seed": s,
                                      "suspend": suspend, "out": rolls})

    # -----------------------------------------------------------------------
    # death_sequence STUB path (no death_queue): _roll_throe +
    # _case_body_immediate in one tick.  Drive EVERY roll 0..10 via the
    # _ForcedPicks first-pick script over the tank grid x scale, with bystanders
    # at known integer distances so the case-1..3 escalating blasts (radii
    # RADIUS_* x scale) and their chain kills (kill_tank -> on_tank_destroyed
    # log; NO award in kill_tank now) pin exactly.  Cases 4..10 are visual-only
    # (byte-decoded): the bystander snapshots pin that NOBODY takes damage.
    # o2 is pre-dead: the blast damage loop must skip it.
    # -----------------------------------------------------------------------
    THROE_TANKS = [
        ("origin", 0, 0, 0),
        ("mid", 200, 300, 7),
        ("neg", -10, -10, 3),
        ("big", 355, 470, 15),
        ("c2", 123, 88, 2),
    ]
    for roll in range(11):
        for (tname, tx, ty, tcol) in THROE_TANKS:
            for sc in (1.0, 2.0):
                # roll 10 armed so the immediate cook-off branch fires (the
                # ammo-less predicate-False side is pinned by roll10_noammo in
                # the staged battery).
                ammo = 2 if roll == 10 else 0
                victim = MockTank("v", x=tx, y=ty, color=tcol, team_id=2,
                                  player_index=0, health=0, alive=False,
                                  ammo=ammo)
                o1 = MockTank("o1", x=tx + 6, y=ty, team_id=2, player_index=1,
                              health=100)
                o2 = MockTank("o2", x=tx + 9, y=ty, team_id=2, player_index=2,
                              health=0, alive=False)
                o3 = MockTank("o3", x=tx + 150, y=ty, team_id=2,
                              player_index=3, health=100)
                shooter = MockTank("s", x=tx - 100, y=ty, team_id=1,
                                   player_index=5)
                st = MockState(tanks=[victim, o1, o2, o3],
                               rng=_ForcedPicks(Rng(1000 + roll), [roll]),
                               explosion_scale=sc, current_shooter=shooter)
                ret = death.death_sequence(st, victim, None)
                out["sequence_immediate"].append({
                    "fn": "sequence_immediate", "roll": roll, "tank": tname,
                    "x": tx, "y": ty, "col": tcol, "scale": sc,
                    "ammo": ammo,
                    "ret": ret,
                    "victim": _tank_snap(victim), "o1": _tank_snap(o1),
                    "o2": _tank_snap(o2), "o3": _tank_snap(o3),
                    "shooter": _tank_snap(shooter),
                    "state": _state_snap(st),
                })

    # -----------------------------------------------------------------------
    # retreat_sequence STUB path (no death_queue): fountain (or its fallback
    # puff) + the weapon-radius grave blast, immediately.  weapon x scale x
    # ICON_BAR (top clip 29 vs 9) x fountain-emitter presence.  current_shooter
    # is None (game.retreat nulls it), so blast kills award no one.
    # -----------------------------------------------------------------------
    RETREAT_WEAPONS = [None, 0, 1, 3]
    for widx in RETREAT_WEAPONS:
        for sc in (1.0, 2.0):
            for icon_bar in (False, True):
                for with_fountain in (True, False):
                    weapon = weapons.ITEMS[widx] if widx is not None else None
                    victim = MockTank("v", x=200, y=300, color=7, team_id=2,
                                      player_index=0, health=0, alive=False)
                    o1 = MockTank("o1", x=206, y=300, team_id=2,
                                  player_index=1, health=100)
                    o3 = MockTank("o3", x=20, y=300, team_id=2,
                                  player_index=3, health=100)
                    st = MockState(cfg=MockCfg(icon_bar=icon_bar),
                                   tanks=[victim, o1, o3], rng=Rng(3),
                                   explosion_scale=sc, current_shooter=None,
                                   with_fountain=with_fountain)
                    death.retreat_sequence(st, victim, weapon)
                    out["retreat_stub"].append({
                        "fn": "retreat_stub",
                        "widx": (widx if widx is not None else -1),
                        "wname": (weapon.name if weapon else "None"),
                        "scale": sc, "icon_bar": icon_bar,
                        "with_fountain": with_fountain,
                        "victim": _tank_snap(victim), "o1": _tank_snap(o1),
                        "o3": _tank_snap(o3),
                        "state": _state_snap(st),
                    })

    # -----------------------------------------------------------------------
    # _debris_fountain WITH the emitter present: the add_death_fountain call
    # args (x, y, top, color, stride, scatter) over scatter False/True, the
    # tank grid, and ICON_BAR OFF/ON (top = PLAYFIELD_TOP+7 = 9 vs
    # STATUS_BAR_H+7 = 29, the bar-bottom ceiling analogue).
    # -----------------------------------------------------------------------
    for (tname, tx, ty, tcol) in THROE_TANKS:
        for scatter in (False, True):
            for icon_bar in (False, True):
                st = MockState(cfg=MockCfg(icon_bar=icon_bar),
                               with_fountain=True)
                tk = MockTank("t", x=tx, y=ty, color=tcol)
                death._debris_fountain(st, tk, scatter=scatter)
                out["debris_fountain"].append({
                    "fn": "debris_fountain", "tank": tname, "x": tx, "y": ty,
                    "col": tcol, "scatter": bool(scatter),
                    "icon_bar": icon_bar,
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
    # STAGED step_queue battery: a queue-capable mock driven tick-by-tick.
    # Each tick = (1) age the mock FX/flight lists (throe ttl 3, fountain ttl
    # 2, projectile drains 2 ticks after spawn -- the driver's stand-ins for
    # game's emitter stepping), (2) death.step_queue, (3) record the (signal,
    # payload) stream + the per-tick list lengths.  Cases: every forced roll
    # 0..10 (the full roulette: front lead-in cases 0-5, blast ladders +
    # THROE_DELAY_TICKS waits, ball/fireworks/ring waits, the sink descent
    # ticks + y clamp, the debris cook-off), the cook-off WITHOUT ammo (skips
    # straight to done), a two-corpse CHAIN (FIFO order: the second corpse's
    # award fires only after the first throe retires), an injected mock FLIGHT
    # (a live projectile BLOCKS the queue until it drains -- no roulette case
    # spawns one, so the driver injects it), and the retreat ASCENSION (climb
    # wait -> grave blast).  The dump FAILS if a case does not drain (queue
    # stuck = port bug; no silent truncation).
    # -----------------------------------------------------------------------
    def run_staged(label, seed, forced, victims, ascend=None, ammo=0,
                   selected=2, y1=300, hold_flight=False):
        v1 = MockTank("v1", x=200, y=y1, color=7, team_id=2, player_index=0,
                      health=0, alive=False,
                      selected_weapon=selected, ammo=ammo)
        o1 = MockTank("o1", x=206, y=300, team_id=2, player_index=1,
                      health=100)
        o2 = MockTank("o2", x=215, y=300, team_id=2, player_index=2,
                      health=0, alive=False)
        tanks = [v1, o1, o2]
        v2 = None
        if victims > 1:
            v2 = MockTank("v2", x=100, y=280, color=4, team_id=2,
                          player_index=4, health=0, alive=False)
            tanks.append(v2)
        shooter = MockTank("s", x=50, y=300, team_id=1, player_index=5)
        st = MockState(tanks=tanks, rng=_ForcedPicks(Rng(seed), forced),
                       explosion_scale=1.0, current_shooter=shooter,
                       with_queue=True)
        if ascend is not None:
            death.retreat_sequence(st, v1, ascend if ascend is not True else None)
        else:
            death.death_sequence(st, v1, None)
            if v2 is not None:
                death.death_sequence(st, v2, None)
        if hold_flight:
            # no roulette case spawns a flight (byte-verified), so inject one:
            # the killing shot still airborne when a settle-path kill enqueued.
            st.projectiles.append({"mock": True})
        ticks = []
        proj_countdown = None
        for _ in range(200):
            # (1) age the mock lists (the driver's _animate_effects stand-in)
            for e in st.throe_fx:
                e["ttl"] -= 1
            st.throe_fx[:] = [e for e in st.throe_fx if e["ttl"] > 0]
            for e in st.death_fountains:
                e["ttl"] -= 1
            st.death_fountains[:] = [e for e in st.death_fountains
                                     if e["ttl"] > 0]
            if st.projectiles:
                if proj_countdown is None:
                    proj_countdown = 2
                else:
                    proj_countdown -= 1
                    if proj_countdown <= 0:
                        st.projectiles[:] = []
                        proj_countdown = None
            # (2) advance the staged FIFO
            sigs = death.step_queue(st)
            # (3) record
            ticks.append({
                "sig": [_sig_json(s, p) for (s, p) in sigs],
                "q": len(st.death_queue),
                "throe": len(st.throe_fx),
                "fount": len(st.death_fountains),
                "proj": len(st.projectiles),
            })
            if (not st.death_queue and not st.throe_fx
                    and not st.death_fountains and not st.projectiles):
                break
        else:
            raise AssertionError(f"staged case {label!r} did not drain")
        out["staged"].append({
            "fn": "staged", "case": label, "seed": seed,
            "forced": list(forced), "victims": victims,
            "ammo": ammo, "selected": selected,
            "hold_flight": bool(hold_flight),
            "ascension": bool(ascend is not None),
            "n_ticks": len(ticks),
            "ticks": ticks,
            "v1": _tank_snap(v1), "v1_y": v1.y,
            "o1": _tank_snap(o1), "o2": _tank_snap(o2),
            "v2": (_tank_snap(v2) if v2 is not None else None),
            "shooter": _tank_snap(shooter),
            "state": _state_snap(st),
        })

    for roll in range(11):
        # roll 10 with ammo so the cook-off actually fires
        run_staged(f"roll{roll}", 5, [roll], 1,
                   ammo=(2 if roll == 10 else 0))
    run_staged("roll10_noammo", 5, [10], 1, ammo=0)
    # sink next to the floor: the y descent clamps at state.h - 1 (479)
    run_staged("roll8_deep", 5, [8], 1, y1=470)
    run_staged("chain_cookoff", 9, [10, 6], 2, ammo=2)
    run_staged("chain_front", 11, [0, 9], 2)
    run_staged("flight_hold", 13, [9], 1, hold_flight=True)
    run_staged("ascension", 7, [], 1, ascend=True)

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
