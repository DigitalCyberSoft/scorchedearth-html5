/**
 * Differential gate: src/game.ts GameState FLOW paths == Python scorch.game
 * (the byte-verified fidelity oracle), for the real-game paths the per-step
 * dump_game.py battery does NOT drive: a complete fire->flight->impact->damage
 * pipeline per weapon BEHAVIOR (explosive / nuke / roller / digger / sandhog /
 * leapfrog / funky / dirt / mirv / laser / plasma / tracer), the death sequence
 * (on_tank_destroyed -> death.death_sequence -- the options-object crash that was
 * fixed), retreat, mass_kill, win/loss elimination, the shop/economy cycle,
 * CHANGING_WIND jitter, shield deflection in flight, the SYNCHRONOUS AI volley
 * loop (launch + re-aim), SIMULTANEOUS human fire, and the isolated visual-effect
 * helpers (firewall / battery / flash / digger band / throes / plasma ring).
 *
 * Golden vectors come from oracle/dump_game_flow.py, which drives the REAL
 * scorch.game.GameState headless over the SAME fixed seeds + scripted scenarios
 * and dumps a rich snapshot (tanks + projectiles + every visual-effect array + a
 * terrain column-top signature + a live-LUT band sample + wind + last_landing)
 * after each pipeline step.  This test reproduces the identical battery against
 * src/game.ts and asserts every snapshot reproduces EXACT for integers /
 * toBeCloseTo(.,12) for trajectory floats.
 *
 * EPSILON POLICY: identical to test/game.test.ts.  Every tank field (incl color),
 * every effect field (all integer/boolean/string), the LUT band RGB (integer),
 * the terrain column tops (integer), wind/phase/indices, and last_landing are
 * asserted EXACT (.toBe / .toEqual).  The ONLY floats are in-flight projectile
 * kinematics (px/py/vx/vy), asserted .toBeCloseTo(.,12).
 *
 * SEEDING: createGameState seeds BOTH the shared MT singleton (grng) and the
 * private _pyrandom with `seed`, exactly mirroring dump_game_flow.build's
 * random.seed(seed)/grng.seed(seed); build() then pins mtn_ranges=[] so terrain
 * generation takes the _midpoint rng path on both sides.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  GameState,
  createGameState,
  setMtnRanges,
} from "../src/game";
import { Config } from "../src/config";
import * as C from "../src/constants";
import * as weapons from "../src/weapons";
import * as damage from "../src/damage";
import * as physics from "../src/physics";
import * as palette from "../src/palette";
import { TalkConfig } from "../src/talk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "game_flow.json");

// ---------------------------------------------------------------------------
// Vector shapes (mirror dump_game_flow.py serialization).
// ---------------------------------------------------------------------------
type TankSnap = {
  health: number; x: number; y: number; shield_hp: number; shield_item: number;
  alive: boolean; score: number; cash: number; win_counter: number;
  angle: number; power: number; color: number;
};
type ProjSnap = { px: number; py: number; vx: number; vy: number; active: boolean; behavior: string };
type ExploSnap = {
  x: number; y: number; maxr: number; style: string; dirt: boolean;
  step: number; flash: boolean; phase: number; frame: number;
};
type RingSnap = { x: number; y: number; maxr: number; r: number; dir: number };
type FountainSnap = { col: number; y: number; top: number; color: number; stride: number; scatter: number };
type ThroeSnap = { kind: string; frame: number; life: number; n_parts: number };
type FlashSnap = { up: number; down: number; frame: number; rgb: number[] };
type FirewallSnap = { x: number; y0: number; y1: number; frame: number };
type FxSnap = {
  explosions: ExploSnap[]; plasma_rings: RingSnap[]; death_fountains: FountainSnap[];
  throe_fx: ThroeSnap[]; flashes: FlashSnap[]; firewalls: FirewallSnap[];
  beams: number[]; trace_marks: number;
};
type Snap = {
  label: string; phase: string; current_shooter: number; winner: number;
  round_index: number; wind: number; fire_index: number;
  tanks: TankSnap[]; projectiles: ProjSnap[]; fx: FxSnap;
  lut: number[][]; terr: number[]; last_landing: number[] | null;
};

type WeaponCase = { slot: number; label: string; angle: number; power: number; steps: Snap[] };
type StepCase = { seed: number; steps: Snap[] } & { [k: string]: unknown };
type MassKillCase = {
  seed: number; scoring: string; roster_n: number; cash0: number; score0: number; steps: Snap[];
};
type ShopRow = {
  label: string; phase: string; round_index: number; cash: number[]; inv: number[][];
};
type ShopCase = { seed: number; rows: ShopRow[] };
type WindCase = { seed: number; winds: number[] };
type ShieldCase = { label: string; seed: number; steps: Snap[] };
type SyncCase = { seed: number; steps: Snap[]; volleys: number };
type SimHumanCase = { seed: number; steps: Snap[]; human_launched: number; gated_count: number };

type EffectsVec = {
  firewall: Array<{ firewalls: FirewallSnap[]; counter: number; active: boolean; lut: number[][] }>;
  discharge: Array<{ batteries: number }>;
  battery_auto: { used: number; health: number; batteries: number };
  flash: Array<{ flashes: Array<{ up: number; down: number; frame: number }>; lut: number[][] }>;
  digger_band: Array<{ cycle: number; step: number; lut: number[][] }>;
  digger_expire: { cycle: number; step: number; lut: number[][] };
  throes: { [kind: string]: { seq: Array<ThroeSnap | null>; terr_after: number[] } };
  plasma_ring: Array<{ rings: RingSnap[]; beams?: number[] }>;
  mayhem: { inv: number[] };
  unknown_class: {
    pre: { ai_class: number; reveal_type: number };
    post1: { ai_class: number; reveal_type: number };
    post2: { ai_class: number; reveal_type: number };
  };
  arm_shield: {
    slot: number; shield_hp: number; shield_item: number;
    inv_shield: number; inv_force: number;
  };
};

type FallCase = { label: string; steps: Snap[] };
type ResolveHitCase = { label: string; slot: number; shielded: boolean; steps: Snap[] };
type TripleCase = { icon: number; n_spawned: number; after_fire: Snap };
type AmmoCase = { label: string; behavior: string | null; selected_after: number; missile_left?: number };
type ElasticCase = { token: string; seed: number; after_round: number; after_fire: number };
type TeamWinCase = { seed: number; steps: Snap[]; win_before: boolean; win_after: boolean };
type ArmEdges = {
  already_up: { slot: number | null; shield_hp: number; inv_force: number };
  sim_no_autodef: { shield_hp: number; shield_item: number; inv_shield: number };
  sim_autodef: { shield_hp: number; shield_item: number; inv_shield: number };
};
type MagSeqRow = { px: number; py: number; vx: number; vy: number; active: boolean };
type MagStep = { seq: Array<MagSeqRow | null>; shield_hp: number };
type ExploTail = {
  grow: Array<[number, number] | null>;
  stamp: Array<[number, number] | null>;
  firewall_expire: Array<{ n: number; active: boolean }>;
};

type OffField = { last_landing: [number, number] | null; active: boolean; n_expl: number };
type MagSkip = { vy_before: number; vy_after: number };
type EdgesVec = {
  perturb_zero: { wind: number };
  sync_wind: { wind: number; phase: string };
  sim_wind: { wind: number; phase: string };
  sync_human_wait: { seq: Array<[string, number]> };
  sync_collect_human: { phase: string; cs: number; queue_same: boolean };
  sync_advance_win: { phase: string; round_index: number };
  sync_drop_dead: { cs: number; queue: number[]; phase: string };
  sync_volley_win: { phase: string; round_index: number };
  sim_begin_dead: { sim_keys: number[] };
  sim_begin_autodef: { parachute: boolean[] };
  sim_update_win: { phase: string; round_index: number };
  sim_update_no_rec: { phase: string; t1_proj: number };
  mirv_contact: { nproj: number; contacts: boolean[] };
  offfield_floor: OffField;
  offfield_wrap: OffField;
  offfield_wrap_ceil: OffField;
  offfield_tracer: OffField;
  offfield_digger: OffField;
  offfield_digger_zero: OffField;
  mag_vx0: MagSkip;
  mag_farx: MagSkip;
  digger_on_shield: { active: boolean; shield_before: number; shield_after: number };
  contact_sandhog: { active: boolean; last_landing: [number, number] };
  settle_no_chute: { parachutes: number; deployed: boolean; y: number };
  lightning_zero: { frame: number; band_before: number[][]; band_after: number[][] };
};
type GameFlowVectors = {
  module: string; field: [number, number]; lut_idx: number[]; terr_x: number[];
  edges: EdgesVec;
  weapon_fire: WeaponCase[]; death_fx: StepCase[]; retreat: StepCase[];
  mass_kill: MassKillCase[]; win_loss: StepCase[]; shop_cycle: ShopCase[];
  changing_wind: WindCase[]; shields: ShieldCase[]; sync_ai_volley: SyncCase[];
  sim_human: SimHumanCase[]; effects: EffectsVec; retreat_win: StepCase[];
  falling: FallCase[]; resolve_hit: ResolveHitCase[]; triple: TripleCase[];
  ammo_fallback: AmmoCase[]; elastic: ElasticCase[]; team_win: TeamWinCase[];
  arm_edges: ArmEdges; mag_step: MagStep; explo_tail: ExploTail;
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as GameFlowVectors;
const [W, H] = vec.field;
const LUT_IDX = vec.lut_idx;
const TERR_X = vec.terr_x;
const DT = 1 / 60.0;

// keep the module-global mtn list empty (build() also pins per-instance);
// documents that createGameState's _mtnRanges default must be [].
setMtnRanges([]);

// ---------------------------------------------------------------------------
// Config + GameState builders (mirror dump_game_flow.make_cfg / build).
// ---------------------------------------------------------------------------
function makeCfg(over: { [k: string]: string | number | boolean } = {}): Config {
  const cfg = new Config();
  cfg.SOUND = "OFF";
  cfg.TALKING_TANKS = "OFF";
  cfg.FLY_SOUND = "OFF";
  cfg.SKY = "PLAIN";
  for (const k of Object.keys(over)) {
    (cfg as unknown as { [k: string]: unknown })[k] = over[k];
  }
  cfg.live_elastic = cfg.elastic;
  return cfg;
}

type Player = [string, number, number, number];

function build(cfg: Config, seed: number, players: Player[]): GameState {
  const gs = createGameState(cfg, W, H, seed);
  (gs as { mtn_ranges: unknown[] }).mtn_ranges = [];
  for (const [name, ai, team, icon] of players) {
    gs.add_player(name, ai, team, icon);
  }
  return gs;
}

// ---------------------------------------------------------------------------
// Snapshot capture -- structurally identical to dump_game_flow.snap.
// ---------------------------------------------------------------------------
function snapTank(t: GameState["tanks"][number]): TankSnap {
  return {
    health: t.health, x: t.x, y: t.y, shield_hp: t.shield_hp,
    shield_item: t.shield_item, alive: t.alive, score: t.score, cash: t.cash,
    win_counter: t.win_counter, angle: t.angle, power: t.power, color: t.color,
  };
}
function snapProj(p: GameState["projectiles"][number]): ProjSnap {
  return { px: p.px, py: p.py, vx: p.vx, vy: p.vy, active: p.active, behavior: p.weapon.behavior };
}
function num(v: unknown): number {
  return v as number;
}
function snapFx(gs: GameState): FxSnap {
  return {
    explosions: gs.explosions.map((e) => ({
      x: num(e.x), y: num(e.y), maxr: num(e.maxr), style: e.style as string,
      dirt: e.dirt as boolean, step: num(e.step), flash: e.flash as boolean,
      phase: num(e.phase), frame: num(e.frame),
    })),
    plasma_rings: gs.plasma_rings.map((r) => ({
      x: num(r.x), y: num(r.y), maxr: num(r.maxr), r: num(r.r), dir: num(r.dir),
    })),
    death_fountains: gs.death_fountains.map((f) => ({
      col: num(f.col), y: num(f.y), top: num(f.top), color: num(f.color),
      stride: num(f.stride), scatter: num(f.scatter),
    })),
    throe_fx: gs.throe_fx.map((e) => ({
      kind: e.kind as string, frame: num(e.frame), life: num(e.life),
      n_parts: Array.isArray(e.parts) ? (e.parts as unknown[]).length : 0,
    })),
    flashes: gs.flashes.map((f) => ({
      up: num(f.up), down: num(f.down), frame: num(f.frame),
      rgb: (f.rgb as number[]).slice(),
    })),
    firewalls: gs.firewalls.map((fw) => ({
      x: num(fw.x), y0: num(fw.y0), y1: num(fw.y1), frame: num(fw.frame),
    })),
    beams: gs.beams.map((b) => b.pts.length),
    trace_marks: gs.trace_marks.length,
  };
}
function snapLut(gs: GameState): number[][] {
  return LUT_IDX.map((i) => {
    const row = gs.lut.table[i];
    return [row[0], row[1], row[2]];
  });
}
function snapTerr(gs: GameState): number[] {
  return TERR_X.map((x) => gs.terrain.column_top(x));
}
function snap(gs: GameState, label: string): Snap {
  const cs = gs.current_shooter !== null ? gs.current_shooter.player_index : -1;
  const win = gs.winner !== null ? gs.winner.player_index : -1;
  const ll = gs.last_landing !== null ? [gs.last_landing[0], gs.last_landing[1]] : null;
  return {
    label, phase: gs.phase, current_shooter: cs, winner: win,
    round_index: gs.round_index, wind: gs.cfg.wind, fire_index: gs.fire_index,
    tanks: gs.tanks.map(snapTank), projectiles: gs.projectiles.map(snapProj),
    fx: snapFx(gs), lut: snapLut(gs), terr: snapTerr(gs), last_landing: ll,
  };
}

// ---------------------------------------------------------------------------
// Snapshot comparison.
// ---------------------------------------------------------------------------
function expectTank(got: TankSnap, want: TankSnap, tag: string): void {
  expect(got.health, `${tag} health`).toBe(want.health);
  expect(got.x, `${tag} x`).toBe(want.x);
  expect(got.y, `${tag} y`).toBe(want.y);
  expect(got.shield_hp, `${tag} shield_hp`).toBe(want.shield_hp);
  expect(got.shield_item, `${tag} shield_item`).toBe(want.shield_item);
  expect(got.alive, `${tag} alive`).toBe(want.alive);
  expect(got.score, `${tag} score`).toBe(want.score);
  expect(got.cash, `${tag} cash`).toBe(want.cash);
  expect(got.win_counter, `${tag} win_counter`).toBe(want.win_counter);
  expect(got.angle, `${tag} angle`).toBe(want.angle);
  expect(got.power, `${tag} power`).toBe(want.power);
  expect(got.color, `${tag} color`).toBe(want.color);
}
function expectProj(got: ProjSnap, want: ProjSnap, tag: string): void {
  expect(got.active, `${tag} active`).toBe(want.active);
  expect(got.behavior, `${tag} behavior`).toBe(want.behavior);
  expect(got.px, `${tag} px`).toBeCloseTo(want.px, 12);
  expect(got.py, `${tag} py`).toBeCloseTo(want.py, 12);
  expect(got.vx, `${tag} vx`).toBeCloseTo(want.vx, 12);
  expect(got.vy, `${tag} vy`).toBeCloseTo(want.vy, 12);
}
function expectFx(got: FxSnap, want: FxSnap, tag: string): void {
  expect(got.explosions.length, `${tag} explosions n`).toBe(want.explosions.length);
  for (let i = 0; i < want.explosions.length; i++) {
    const g = got.explosions[i];
    const w = want.explosions[i];
    expect(g, `${tag} explosion${i}`).toEqual(w);
    // finite-number guard (the add_explosion options-object regression).
    for (const v of [g.x, g.y, g.maxr, g.step, g.phase, g.frame]) {
      expect(Number.isFinite(v), `${tag} explosion${i} finite`).toBe(true);
    }
  }
  expect(got.plasma_rings, `${tag} plasma_rings`).toEqual(want.plasma_rings);
  expect(got.death_fountains.length, `${tag} fountains n`).toBe(want.death_fountains.length);
  for (let i = 0; i < want.death_fountains.length; i++) {
    const g = got.death_fountains[i];
    expect(g, `${tag} fountain${i}`).toEqual(want.death_fountains[i]);
    // finite-number guard: every field (esp color) must be a finite integer, never
    // NaN -- the exact regression the add_death_fountain options-object fix closed.
    for (const v of [g.col, g.y, g.top, g.color, g.stride, g.scatter]) {
      expect(Number.isInteger(v), `${tag} fountain${i} integer`).toBe(true);
    }
  }
  expect(got.throe_fx, `${tag} throe_fx`).toEqual(want.throe_fx);
  expect(got.flashes, `${tag} flashes`).toEqual(want.flashes);
  expect(got.firewalls, `${tag} firewalls`).toEqual(want.firewalls);
  expect(got.beams, `${tag} beams`).toEqual(want.beams);
  expect(got.trace_marks, `${tag} trace_marks`).toBe(want.trace_marks);
}
function expectSnap(got: Snap, want: Snap, label: string): void {
  const tag = `${label}/${want.label}`;
  expect(got.phase, `${tag} phase`).toBe(want.phase);
  expect(got.current_shooter, `${tag} current_shooter`).toBe(want.current_shooter);
  expect(got.winner, `${tag} winner`).toBe(want.winner);
  expect(got.round_index, `${tag} round_index`).toBe(want.round_index);
  expect(got.wind, `${tag} wind`).toBe(want.wind);
  expect(got.fire_index, `${tag} fire_index`).toBe(want.fire_index);
  expect(got.last_landing, `${tag} last_landing`).toEqual(want.last_landing);
  expect(got.tanks.length, `${tag} tank n`).toBe(want.tanks.length);
  for (let i = 0; i < want.tanks.length; i++) {
    expectTank(got.tanks[i], want.tanks[i], `${tag} tank${i}`);
  }
  expect(got.projectiles.length, `${tag} proj n`).toBe(want.projectiles.length);
  for (let i = 0; i < want.projectiles.length; i++) {
    expectProj(got.projectiles[i], want.projectiles[i], `${tag} proj${i}`);
  }
  expectFx(got.fx, want.fx, tag);
  expect(got.lut, `${tag} lut`).toEqual(want.lut);
  expect(got.terr, `${tag} terr`).toEqual(want.terr);
}

// ===========================================================================
// Sanity locks on the battery.
// ===========================================================================
describe("game_flow: vector battery", () => {
  it("module tag + field match the dumper", () => {
    expect(vec.module).toBe("game_flow");
    expect(vec.field).toEqual([W, H]);
    expect(vec.weapon_fire.length).toBe(12);
  });
});

// ===========================================================================
// Scenario A: full fire -> flight -> impact -> detonation per weapon behavior.
// ===========================================================================
describe("game_flow: weapon-behavior fire/flight/impact pipeline", () => {
  for (let ci = 0; ci < vec.weapon_fire.length; ci++) {
    const c = vec.weapon_fire[ci];
    it(`${c.label} (slot ${c.slot})`, () => {
      const cfg = makeCfg({
        MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0,
        FALLING_TANKS: "OFF", CHANGING_WIND: "OFF", TRACE: "OFF",
      });
      const gs = build(cfg, 42, [["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0]]);
      gs.new_game();
      gs.update(DT);
      const shooter = gs.current_shooter!;
      shooter.inventory[c.slot] = 20;
      shooter.angle = c.angle;
      shooter.power = c.power;
      shooter.selected_weapon = c.slot;
      gs.fire();
      const steps: Snap[] = [snap(gs, "after_fire")];
      let n = 0;
      let emptyAt: number | null = null;
      while (n < 250) {
        gs.update(DT);
        n += 1;
        steps.push(snap(gs, `f${n}`));
        if (gs.phase === "round_end" || gs.phase === "game_over") break;
        if (emptyAt === null && gs.projectiles.length === 0) emptyAt = n;
        if (emptyAt !== null && n >= emptyAt + 10) break;
      }
      expect(steps.length, `${c.label} step count`).toBe(c.steps.length);
      for (let i = 0; i < c.steps.length; i++) {
        expectSnap(steps[i], c.steps[i], `weapon[${c.label}][${i}]`);
      }
    });
  }
});

// ===========================================================================
// Scenario B: the death sequence (on_tank_destroyed -> death.death_sequence).
// ===========================================================================
describe("game_flow: death sequence (on_tank_destroyed populates FINITE FX)", () => {
  for (let ci = 0; ci < vec.death_fx.length; ci++) {
    const c = vec.death_fx[ci];
    it(`seed=${c.seed} kill does not throw + FX finite`, () => {
      const cfg = makeCfg({
        MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0,
        FALLING_TANKS: "OFF", CHANGING_WIND: "OFF",
      });
      const gs = build(cfg, c.seed, [["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0]]);
      gs.new_game();
      const baseY = gs.tanks[0].y;
      gs.tanks[0].x = 300; gs.tanks[0].y = baseY;
      gs.tanks[1].x = 314; gs.tanks[1].y = baseY;
      for (const t of gs.tanks) { t.health = 100; t.alive = true; }
      gs.current_shooter = gs.tanks[0];
      gs.current_weapon = weapons.ITEMS[3];
      const steps: Snap[] = [snap(gs, "pre_kill")];
      // a lethal blast on tank 1 -> kill_tank -> on_tank_destroyed -> death_sequence.
      expect(() =>
        damage.explode(gs as unknown as damage.State, gs.tanks[1].x, gs.tanks[1].y, 80, true),
      ).not.toThrow();
      steps.push(snap(gs, "after_kill"));
      // The killing blast's own fireball is immediate; the DEATH FX are STAGED
      // (death.step_queue: the FUN_271b_0005 kill roulette -- award/front/case
      // body -- runs when the queue PROCESSES the corpse), so nothing death-
      // side exists at the kill snapshot beyond the queue entry itself.
      const ak = steps[steps.length - 1];
      expect(ak.fx.explosions.length, "explosions populated").toBeGreaterThan(0);
      expect(gs.death_queue.length, "death staged").toBeGreaterThan(0);
      for (let k = 0; k < 6; k++) {
        gs._animate_effects();
        steps.push(snap(gs, `anim${k}`));
      }
      expect(steps.length, `death#${ci} step count`).toBe(c.steps.length);
      for (let i = 0; i < c.steps.length; i++) {
        expectSnap(steps[i], c.steps[i], `death[${c.seed}][${i}]`);
      }
      // The NaN regression guard (the death-fountain options-object bug), kept
      // under the DECODED model: a normal kill no longer spawns the ascension
      // fountain (that is the retreat path, FUN_3ef5_029a); the kill roulette
      // may spawn any throe kind -- or none at all (thud/blast/vanish rolls).
      // Drive the staged queue to COMPLETION, stepping any cook-off flight
      // (roll 10 launches the corpse's weapon, and a live projectile blocks
      // the queue), and assert (a) every fountain/throe field that DID appear
      // is a finite integer and (b) the queue fully drains.
      let guard = 0;
      while (
        (gs.death_queue.length > 0 ||
          gs.throe_fx.length > 0 ||
          gs.death_fountains.length > 0 ||
          gs.projectiles.length > 0) &&
        guard++ < 3000
      ) {
        for (let s = 0; s < C.PHYSICS_SUBSTEPS; s++) gs._step_flight();
        gs._animate_effects();
        for (const f of gs.death_fountains as Array<{ [k: string]: unknown }>) {
          for (const v of [f.col, f.y, f.top, f.color, f.stride, f.scatter]) {
            expect(Number.isInteger(v), "fountain field integer").toBe(true);
          }
        }
        for (const e of gs.throe_fx as Array<{ [k: string]: unknown }>) {
          for (const v of [e.x, e.y, e.color, e.frame, e.life]) {
            expect(Number.isInteger(v), "throe field integer").toBe(true);
          }
        }
      }
      expect(gs.death_queue.length, "death queue drains").toBe(0);
      expect(gs.throe_fx.length, "throes retire").toBe(0);
    });
  }
});

// ===========================================================================
// Scenario C: retreat (SEQUENTIAL).
// ===========================================================================
describe("game_flow: retreat (flee + forfeit, no points, no kill credit)", () => {
  for (let ci = 0; ci < vec.retreat.length; ci++) {
    const c = vec.retreat[ci];
    it(`seed=${c.seed}`, () => {
      const cfg = makeCfg({
        MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0,
        FALLING_TANKS: "OFF", CHANGING_WIND: "OFF",
      });
      const gs = build(cfg, c.seed, [
        ["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0], ["C", C.AI_HUMAN, 0, 0],
      ]);
      gs.new_game();
      gs.update(DT);
      const steps: Snap[] = [snap(gs, "turn_start")];
      const ret = gs.retreat();
      expect(ret, `retreat#${ci} returned true`).toBe(true);
      steps.push(snap(gs, "after_retreat"));
      let n = 0;
      while (n < 200) {
        gs.update(DT);
        n += 1;
        if (gs.phase === "aim" || gs.phase === "round_end" || gs.phase === "game_over") break;
      }
      steps.push(snap(gs, "after_settle"));
      for (let i = 0; i < c.steps.length; i++) {
        expectSnap(steps[i], c.steps[i], `retreat[${c.seed}][${i}]`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Scenario C2: a 2-tank retreat -> last tank standing -> _end_round (the
// SEQUENTIAL retreat-that-wins path).
// ---------------------------------------------------------------------------
describe("game_flow: retreat that ends the round (last tank standing)", () => {
  for (let ci = 0; ci < vec.retreat_win.length; ci++) {
    const c = vec.retreat_win[ci];
    it(`seed=${c.seed}`, () => {
      const cfg = makeCfg({
        MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0,
        FALLING_TANKS: "OFF", CHANGING_WIND: "OFF", SCORING: "STANDARD",
      });
      const gs = build(cfg, c.seed, [["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0]]);
      gs.new_game();
      gs.update(DT);
      const steps: Snap[] = [snap(gs, "turn_start")];
      gs.retreat();
      steps.push(snap(gs, "after_retreat"));
      // Round end is DEFERRED past the staged death FX: retreat parks in SETTLE
      // (the staged grave blast must land first -- it can damage neighbours),
      // and the SETTLE exit runs the same win check afterwards.
      expect(gs.phase, `retreat_win#${ci} defers to settle`).toBe("settle");
      for (let i = 0; i < c.steps.length; i++) {
        expectSnap(steps[i], c.steps[i], `retreat_win[${c.seed}][${i}]`);
      }
      // ...and the round DOES end once the staged FX drain (the original
      // guarantee of this test, now at its faithful time).
      let guard = 0;
      while (gs.phase === "settle" && guard++ < 2000) {
        gs.update(DT);
      }
      expect(gs.phase, `retreat_win#${ci} ends round after drain`).toBe("round_end");
    });
  }
});

// ===========================================================================
// Scenario D: mass_kill.
// ===========================================================================
describe("game_flow: mass_kill (kill all, equal split, no win credit)", () => {
  for (let ci = 0; ci < vec.mass_kill.length; ci++) {
    const c = vec.mass_kill[ci];
    it(`seed=${c.seed} ${c.scoring} n=${c.roster_n}`, () => {
      const cfg = makeCfg({
        MAXROUNDS: 10, INITIAL_CASH: c.cash0, MAX_WIND: 0, SCORING: c.scoring,
      });
      const players: Player[] = [];
      for (let i = 0; i < c.roster_n; i++) {
        players.push([String.fromCharCode(65 + i), C.AI_HUMAN, 0, 0]);
      }
      const gs = build(cfg, c.seed, players);
      gs.new_game();
      for (const t of gs.tanks) { t.score = c.score0; t.cash = c.cash0; }
      gs.mass_kill();
      const got = snap(gs, "after_mass_kill");
      // every tank dead, win_counter untouched, equal score/cash share.
      for (const t of gs.tanks) {
        expect(t.alive, "dead").toBe(false);
        expect(t.health, "health 0").toBe(0);
      }
      expectSnap(got, c.steps[0], `mass_kill[${c.seed}]`);
    });
  }
});

// ===========================================================================
// Scenario E: win / loss elimination -> last tank standing -> GAME_OVER.
// ===========================================================================
describe("game_flow: win/loss elimination + GAME_OVER winner", () => {
  for (let ci = 0; ci < vec.win_loss.length; ci++) {
    const c = vec.win_loss[ci];
    it(`seed=${c.seed}`, () => {
      const cfg = makeCfg({
        MAXROUNDS: 1, INITIAL_CASH: 0, MAX_WIND: 0,
        FALLING_TANKS: "OFF", CHANGING_WIND: "OFF", SCORING: "STANDARD",
      });
      const gs = build(cfg, c.seed, [
        ["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0],
        ["C", C.AI_HUMAN, 0, 0], ["D", C.AI_HUMAN, 0, 0],
      ]);
      gs.new_game();
      const steps: Snap[] = [snap(gs, "round_start")];
      gs.current_shooter = null;
      for (const idx of [1, 2, 3]) {
        damage.kill_tank(gs as unknown as damage.State, gs.tanks[idx] as unknown as damage.Tank);
        steps.push(snap(gs, `kill${idx}`));
      }
      gs.phase = "settle";
      gs._settle_done = false;
      let n = 0;
      while (n < 240) {
        gs.update(DT);
        n += 1;
        if (gs.phase === "round_end" || gs.phase === "game_over") break;
      }
      steps.push(snap(gs, "round_end"));
      gs.proceed_after_round();
      steps.push(snap(gs, "game_over"));
      expect(gs.phase, "game_over phase").toBe("game_over");
      expect(steps.length, `win_loss#${ci} count`).toBe(c.steps.length);
      for (let i = 0; i < c.steps.length; i++) {
        expectSnap(steps[i], c.steps[i], `win_loss[${c.seed}][${i}]`);
      }
    });
  }
});

// ===========================================================================
// Scenario F: shop / economy cycle (AI buys, proceed, next round).
// ===========================================================================
describe("game_flow: shop/economy cycle (run_ai_buys / proceed / begin_next_round)", () => {
  function rowOf(gs: GameState, label: string): ShopRow {
    return {
      label, phase: gs.phase, round_index: gs.round_index,
      cash: gs.tanks.map((t) => t.cash),
      inv: gs.tanks.map((t) => t.inventory.slice()),
    };
  }
  function expectRow(got: ShopRow, want: ShopRow, tag: string): void {
    expect(got.phase, `${tag}/${want.label} phase`).toBe(want.phase);
    expect(got.round_index, `${tag}/${want.label} round`).toBe(want.round_index);
    expect(got.cash, `${tag}/${want.label} cash`).toEqual(want.cash);
    expect(got.inv, `${tag}/${want.label} inv`).toEqual(want.inv);
  }
  for (let ci = 0; ci < vec.shop_cycle.length; ci++) {
    const c = vec.shop_cycle[ci];
    it(`seed=${c.seed}`, () => {
      const cfg = makeCfg({
        MAXROUNDS: 3, INITIAL_CASH: 20000, MAX_WIND: 0,
        FALLING_TANKS: "OFF", CHANGING_WIND: "OFF", SCORING: "STANDARD",
      });
      const gs = build(cfg, c.seed, [
        ["H", C.AI_HUMAN, 0, 0],
        ["AI1", C.AI_SHOOTER, 0, 0],
        ["AI2", C.AI_POOLSHARK, 0, 0],
      ]);
      gs.new_game();
      const rows: ShopRow[] = [rowOf(gs, "after_new_game")];
      gs.run_ai_buys();
      rows.push(rowOf(gs, "after_ai_buys"));
      gs.begin_next_round();
      rows.push(rowOf(gs, "round1_start"));
      gs.current_shooter = null;
      damage.kill_tank(gs as unknown as damage.State, gs.tanks[1] as unknown as damage.Tank);
      damage.kill_tank(gs as unknown as damage.State, gs.tanks[2] as unknown as damage.Tank);
      gs._end_round();
      rows.push(rowOf(gs, "round1_end"));
      gs.proceed_after_round();
      rows.push(rowOf(gs, "after_proceed"));
      expect(rows.length).toBe(c.rows.length);
      for (let i = 0; i < c.rows.length; i++) {
        expectRow(rows[i], c.rows[i], `shop[${c.seed}]`);
      }
    });
  }
});

// ===========================================================================
// Scenario G: CHANGING_WIND per-turn jitter.
// ===========================================================================
describe("game_flow: CHANGING_WIND per-turn jitter", () => {
  for (let ci = 0; ci < vec.changing_wind.length; ci++) {
    const c = vec.changing_wind[ci];
    it(`seed=${c.seed}`, () => {
      const cfg = makeCfg({
        MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 100,
        FALLING_TANKS: "OFF", CHANGING_WIND: "ON",
      });
      const gs = build(cfg, c.seed, [
        ["AI1", C.AI_SHOOTER, 0, 0], ["AI2", C.AI_SHOOTER, 0, 0],
      ]);
      gs.new_game();
      const winds: number[] = [gs.cfg.wind];
      let lastFi = gs.fire_index;
      let n = 0;
      while (n < 400 && winds.length < 8) {
        gs.update(DT);
        n += 1;
        if (gs.fire_index !== lastFi) {
          winds.push(gs.cfg.wind);
          lastFi = gs.fire_index;
        }
        if (gs.phase === "round_end" || gs.phase === "game_over") break;
      }
      expect(winds, `changing_wind[${c.seed}]`).toEqual(c.winds);
    });
  }
});

// ===========================================================================
// Scenario H: shield deflection in flight (mag push / force reflect).
// ===========================================================================
describe("game_flow: in-flight shields (mag push / force deflect)", () => {
  const FLAGS: { [k: string]: { push?: boolean; deflect?: boolean } } = {
    mag: { push: true },
    force: { deflect: true },
  };
  for (let ci = 0; ci < vec.shields.length; ci++) {
    const c = vec.shields[ci];
    it(`${c.label} seed=${c.seed}`, () => {
      const cfg = makeCfg({
        MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0,
        FALLING_TANKS: "OFF", CHANGING_WIND: "OFF", TRACE: "OFF",
      });
      const gs = build(cfg, c.seed, [["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0]]);
      gs.new_game();
      gs.update(DT);
      const shooter = gs.current_shooter!;
      const target = gs.tanks[1];
      const baseY = gs.tanks[0].y;
      shooter.x = 200; shooter.y = baseY;
      target.x = 380; target.y = baseY;
      target.shield_hp = 200;
      target.shield_item = weapons.SLOT_FORCE_SHIELD;
      const fl = FLAGS[c.label];
      target.shield_push = fl.push ?? false;
      target.shield_deflect = fl.deflect ?? false;
      shooter.angle = 45;
      shooter.power = 520;
      shooter.selected_weapon = weapons.SLOT_BABY_MISSILE;
      gs.fire();
      const steps: Snap[] = [snap(gs, "after_fire")];
      let n = 0;
      while (n < 90) {
        gs.update(DT);
        n += 1;
        steps.push(snap(gs, `f${n}`));
        if (gs.phase === "round_end" || gs.phase === "game_over" || gs.phase === "aim") break;
      }
      expect(steps.length, `shield#${ci} count`).toBe(c.steps.length);
      for (let i = 0; i < c.steps.length; i++) {
        expectSnap(steps[i], c.steps[i], `shield[${c.label}/${c.seed}][${i}]`);
      }
    });
  }
});

// ===========================================================================
// Scenario I: SYNCHRONOUS AI volley (launch + fly + re-aim a second volley).
// ===========================================================================
describe("game_flow: SYNCHRONOUS AI volley loop", () => {
  for (let ci = 0; ci < vec.sync_ai_volley.length; ci++) {
    const c = vec.sync_ai_volley[ci];
    it(`seed=${c.seed}`, () => {
      const cfg = makeCfg({
        MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0,
        FALLING_TANKS: "OFF", CHANGING_WIND: "OFF", PLAY_MODE: "SYNCHRONOUS",
      });
      const gs = build(cfg, c.seed, [
        ["AI1", C.AI_SHOOTER, 0, 0], ["AI2", C.AI_SHOOTER, 0, 0],
      ]);
      gs.new_game();
      const steps: Snap[] = [snap(gs, "sync_start")];
      let n = 0;
      let volleys = 0;
      let prev = gs.phase;
      while (n < 800) {
        gs.update(DT);
        n += 1;
        if (gs.phase === "sync_volley" && prev !== "sync_volley") {
          volleys += 1;
          steps.push(snap(gs, `volley${volleys}_launch`));
        }
        prev = gs.phase;
        if (gs.phase === "round_end" || gs.phase === "game_over") break;
        if (volleys >= 2 && gs.phase === "sync_aim") {
          steps.push(snap(gs, "second_reaim"));
          break;
        }
      }
      steps.push(snap(gs, "sync_final"));
      expect(volleys, `sync#${ci} volleys`).toBe(c.volleys);
      expect(steps.length, `sync#${ci} count`).toBe(c.steps.length);
      for (let i = 0; i < c.steps.length; i++) {
        expectSnap(steps[i], c.steps[i], `sync[${c.seed}][${i}]`);
      }
    });
  }
});

// ===========================================================================
// Scenario J: SIMULTANEOUS human fire (launch + per-tank re-fire gate).
// ===========================================================================
describe("game_flow: SIMULTANEOUS human fire + re-fire gate", () => {
  for (let ci = 0; ci < vec.sim_human.length; ci++) {
    const c = vec.sim_human[ci];
    it(`seed=${c.seed}`, () => {
      const cfg = makeCfg({
        MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0,
        FALLING_TANKS: "OFF", CHANGING_WIND: "OFF", PLAY_MODE: "SIMULTANEOUS",
      });
      const gs = build(cfg, c.seed, [
        ["H", C.AI_HUMAN, 0, 0], ["AI", C.AI_SHOOTER, 0, 0],
      ]);
      gs.new_game();
      gs.update(DT);
      const human = gs.tanks[0];
      human.angle = 50; human.power = 600;
      human.selected_weapon = weapons.SLOT_BABY_MISSILE;
      const steps: Snap[] = [snap(gs, "sim_start")];
      const before = gs.projectiles.filter((p) => p.owner === human).length;
      gs.fire();
      const afterFirst = gs.projectiles.filter((p) => p.owner === human).length;
      steps.push(snap(gs, "after_human_fire"));
      gs.fire();
      const gated = gs.projectiles.filter((p) => p.owner === human).length;
      steps.push(snap(gs, "after_gated_fire"));
      expect(afterFirst - before, `sim#${ci} launched`).toBe(c.human_launched);
      expect(gated, `sim#${ci} gated`).toBe(c.gated_count);
      for (let i = 0; i < c.steps.length; i++) {
        expectSnap(steps[i], c.steps[i], `sim[${c.seed}][${i}]`);
      }
    });
  }
});

// ===========================================================================
// Scenario K: isolated effect/animation helpers + edge engine paths.
// ===========================================================================
describe("game_flow: isolated effect helpers + edge paths", () => {
  const E = vec.effects;

  it("firewall (add_firewall + _tick_firewall_band)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, [
      ["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0],
    ]);
    gs.new_game();
    gs.add_firewall(120, 100, 300);
    const rows = [{
      firewalls: gs.firewalls.map((x) => ({ x: num(x.x), y0: num(x.y0), y1: num(x.y1), frame: num(x.frame) })),
      counter: gs._firewall_counter, active: gs._firewall_band_active, lut: snapLut(gs),
    }];
    for (let k = 0; k < 5; k++) {
      gs._tick_firewall_band(3);
      rows.push({
        firewalls: gs.firewalls.map((x) => ({ x: num(x.x), y0: num(x.y0), y1: num(x.y1), frame: num(x.frame) })),
        counter: gs._firewall_counter, active: gs._firewall_band_active, lut: snapLut(gs),
      });
    }
    expect(rows.length).toBe(E.firewall.length);
    for (let i = 0; i < E.firewall.length; i++) {
      expect(rows[i].firewalls, `firewall[${i}] list`).toEqual(E.firewall[i].firewalls);
      expect(rows[i].counter, `firewall[${i}] counter`).toBe(E.firewall[i].counter);
      expect(rows[i].active, `firewall[${i}] active`).toBe(E.firewall[i].active);
      expect(rows[i].lut, `firewall[${i}] lut`).toEqual(E.firewall[i].lut);
    }
  });

  it("_discharge_batteries (explicit count + default-all)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, [
      ["A", C.AI_HUMAN, 0, 0],
    ]);
    gs.new_game();
    const t = gs.tanks[0];
    t.inventory[weapons.SLOT_BATTERY] = 4;
    expect(t.batteries).toBe(E.discharge[0].batteries);
    gs._discharge_batteries(t, 2);
    expect(t.batteries).toBe(E.discharge[1].batteries);
    gs._discharge_batteries(t);
    expect(t.batteries).toBe(E.discharge[2].batteries);
  });

  it("_battery_auto_trigger (SIM recharge to >90)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, [
      ["A", C.AI_HUMAN, 0, 0],
    ]);
    gs.new_game();
    const t = gs.tanks[0];
    t.health = 55;
    t.inventory[weapons.SLOT_BATTERY] = 10;
    const used = gs._battery_auto_trigger(t);
    expect(used).toBe(E.battery_auto.used);
    expect(t.health).toBe(E.battery_auto.health);
    expect(t.batteries).toBe(E.battery_auto.batteries);
  });

  it("flash + lightning band (add_flash / _step_flashes / _tick_lightning_band)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, [
      ["A", C.AI_HUMAN, 0, 0],
    ]);
    gs.new_game();
    gs.add_flash(5, 10, [255, 255, 235], 0);
    gs.add_flash(3, 6, [200, 220, 255], 4);
    for (let k = 0; k < 8; k++) {
      gs._step_flashes();
      gs._tick_lightning_band();
      const flashes = gs.flashes.map((f) => ({ up: num(f.up), down: num(f.down), frame: num(f.frame) }));
      expect(flashes, `flash[${k}] flashes`).toEqual(E.flash[k].flashes);
      expect(snapLut(gs), `flash[${k}] lut`).toEqual(E.flash[k].lut);
    }
  });

  it("digger band rotate (start_digger_cycle / _tick_digger_band / _rollRows)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, [
      ["A", C.AI_HUMAN, 0, 0],
    ]);
    gs.new_game();
    gs.start_digger_cycle();
    const rows = [{ cycle: gs._digger_cycle, step: gs._digger_step, lut: snapLut(gs) }];
    for (const s of [1, 2, 1, 3]) {
      gs._tick_digger_band(s);
      rows.push({ cycle: gs._digger_cycle, step: gs._digger_step, lut: snapLut(gs) });
    }
    expect(rows.length).toBe(E.digger_band.length);
    for (let i = 0; i < E.digger_band.length; i++) {
      expect(rows[i].cycle, `digger[${i}] cycle`).toBe(E.digger_band[i].cycle);
      expect(rows[i].step, `digger[${i}] step`).toBe(E.digger_band[i].step);
      expect(rows[i].lut, `digger[${i}] lut`).toEqual(E.digger_band[i].lut);
    }
  });

  it("digger cycle expiry (200-frame cycle -> band reset + trail clear)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, [
      ["A", C.AI_HUMAN, 0, 0],
    ]);
    gs.new_game();
    gs.start_digger_cycle();
    for (let k = 0; k < 201; k++) gs._tick_digger_band(1);
    expect(gs._digger_cycle, "expired cycle").toBe(E.digger_expire.cycle);
    expect(gs._digger_step, "reset step").toBe(E.digger_expire.step);
    expect(snapLut(gs), "expired lut").toEqual(E.digger_expire.lut);
  });

  it("throes per kind (add_throe + _step_throe_fx)", () => {
    for (const kind of Object.keys(E.throes)) {
      const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 7, [
        ["A", C.AI_HUMAN, 0, 0],
      ]);
      gs.new_game();
      gs.add_throe(kind, 100, 200, 15);
      const seq: Array<ThroeSnap | null> = [snapThroe(gs)];
      for (let k = 0; k < 5; k++) {
        gs._step_throe_fx();
        seq.push(gs.throe_fx.length > 0 ? snapThroe(gs) : null);
      }
      expect(seq, `throe ${kind} seq`).toEqual(E.throes[kind].seq);
      expect(snapTerr(gs), `throe ${kind} terr`).toEqual(E.throes[kind].terr_after);
    }
  });

  function snapThroe(gs: GameState): ThroeSnap {
    const e = gs.throe_fx[0];
    return {
      kind: e.kind as string, frame: num(e.frame), life: num(e.life),
      n_parts: Array.isArray(e.parts) ? (e.parts as unknown[]).length : 0,
    };
  }

  it("plasma ring + beam (add_plasma_ring / add_beam / _step_plasma_rings)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, [
      ["A", C.AI_HUMAN, 0, 0],
    ]);
    gs.new_game();
    gs.add_plasma_ring(100, 100, 12);
    gs.add_beam([[10, 10], [20, 20], [30, 25]]);
    const ring0 = gs.plasma_rings.map((r) => ({ x: num(r.x), y: num(r.y), maxr: num(r.maxr), r: num(r.r), dir: num(r.dir) }));
    expect(ring0, "plasma ring initial").toEqual(E.plasma_ring[0].rings);
    expect(gs.beams.map((b) => b.pts.length), "beam initial").toEqual(E.plasma_ring[0].beams);
    for (let k = 1; k < E.plasma_ring.length; k++) {
      gs._step_plasma_rings();
      const rings = gs.plasma_rings.map((r) => ({ x: num(r.x), y: num(r.y), maxr: num(r.maxr), r: num(r.r), dir: num(r.dir) }));
      expect(rings, `plasma ring step ${k}`).toEqual(E.plasma_ring[k].rings);
    }
  });

  it("mayhem cheat stocks 99 of every enabled item", () => {
    const cfg = makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 });
    (cfg as unknown as { mayhem: boolean }).mayhem = true;
    const gs = build(cfg, 1, [["A", C.AI_HUMAN, 0, 0]]);
    gs.new_game();
    expect(gs.tanks[0].inventory, "mayhem inventory").toEqual(E.mayhem.inv);
  });

  it("Unknown-class per-turn re-roll (latched once)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 11, [
      ["U", C.AI_UNKNOWN, 0, 0], ["B", C.AI_SHOOTER, 0, 0],
    ]);
    gs.new_game();
    const t = gs.tanks[0];
    expect({ ai_class: t.ai_class, reveal_type: t.reveal_type }, "pre").toEqual(E.unknown_class.pre);
    gs._resolve_unknown_class(t);
    expect({ ai_class: t.ai_class, reveal_type: t.reveal_type }, "post1").toEqual(E.unknown_class.post1);
    gs._resolve_unknown_class(t);
    expect({ ai_class: t.ai_class, reveal_type: t.reveal_type }, "post2").toEqual(E.unknown_class.post2);
  });

  it("_arm_best_shield arms the highest-tier owned shield", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, [
      ["A", C.AI_HUMAN, 0, 0],
    ]);
    gs.new_game();
    const t = gs.tanks[0];
    t.shield_hp = 0;
    t.inventory[weapons.SLOT_SHIELD] = 1;
    t.inventory[weapons.SLOT_FORCE_SHIELD] = 1;
    const slot = gs._arm_best_shield(t, true);
    expect(slot, "armed slot").toBe(E.arm_shield.slot);
    expect(t.shield_hp, "shield_hp").toBe(E.arm_shield.shield_hp);
    expect(t.shield_item, "shield_item").toBe(E.arm_shield.shield_item);
    expect(t.inventory[weapons.SLOT_SHIELD], "inv shield").toBe(E.arm_shield.inv_shield);
    expect(t.inventory[weapons.SLOT_FORCE_SHIELD], "inv force").toBe(E.arm_shield.inv_force);
  });
});

// ===========================================================================
// Scenario L: FALLING_TANKS settle (chute deploy+drift / plain fall / land-on-
// enemy / FALLING_TANKS-off snap-to-surface).
// ===========================================================================
const SETTLE = "settle";
function driveSettle(gs: GameState, steps: Snap[], maxn = 80): void {
  let n = 0;
  while (n < maxn) {
    gs.update(DT);
    n += 1;
    steps.push(snap(gs, `s${n}`));
    if (gs.phase !== SETTLE) break;
  }
}
describe("game_flow: FALLING_TANKS settle (chute / fall / squash / off)", () => {
  for (let ci = 0; ci < vec.falling.length; ci++) {
    const c = vec.falling[ci];
    it(`${c.label}`, () => {
      let gs: GameState;
      if (c.label === "chute") {
        gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, FALLING_TANKS: "ON", CHANGING_WIND: "OFF" }), 3,
          [["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0]]);
        gs.new_game();
        const t0 = gs.tanks[0];
        gs.cfg.wind = 50;
        t0.parachute_deployed = true;
        t0.parachute_threshold = 0;
        t0.inventory[weapons.SLOT_PARACHUTE] = 2;
        gs.terrain.carve_circle(t0.x, t0.y + 30, 60);
      } else if (c.label === "plain") {
        gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, FALLING_TANKS: "ON", CHANGING_WIND: "OFF" }), 5,
          [["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0]]);
        gs.new_game();
        const t0 = gs.tanks[0];
        t0.parachute_deployed = false;
        t0.inventory[weapons.SLOT_PARACHUTE] = 0;
        gs.terrain.carve_circle(t0.x, t0.y + 25, 50);
      } else if (c.label === "land_on_enemy") {
        gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, FALLING_TANKS: "ON", CHANGING_WIND: "OFF" }), 9,
          [["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0]]);
        gs.new_game();
        const t0 = gs.tanks[0];
        const t1 = gs.tanks[1];
        t0.parachute_deployed = false;
        t0.inventory[weapons.SLOT_PARACHUTE] = 0;
        t0.x = 300;
        t0.y = gs.terrain.column_top(300) - 40;
        t1.x = 300;
        t1.y = gs.terrain.column_top(300) - 1;
        gs.terrain.carve_circle(300, t0.y + 10, 30);
      } else {
        gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, FALLING_TANKS: "OFF", CHANGING_WIND: "OFF" }), 5,
          [["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0]]);
        gs.new_game();
        gs.terrain.carve_circle(gs.tanks[0].x, gs.tanks[0].y + 20, 40);
      }
      gs.phase = SETTLE;
      gs._settle_done = false;
      const steps: Snap[] = [snap(gs, "pre_settle")];
      driveSettle(gs, steps);
      expect(steps.length, `falling[${c.label}] count`).toBe(c.steps.length);
      for (let i = 0; i < c.steps.length; i++) {
        expectSnap(steps[i], c.steps[i], `falling[${c.label}][${i}]`);
      }
    });
  }
});

// ===========================================================================
// Scenario M: _resolve_hit tank-collision variants.
// ===========================================================================
describe("game_flow: _resolve_hit tank variants (shield/digger/dirt/instakill)", () => {
  for (let ci = 0; ci < vec.resolve_hit.length; ci++) {
    const c = vec.resolve_hit[ci];
    it(`${c.label}`, () => {
      const cfg = makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, FALLING_TANKS: "OFF", CHANGING_WIND: "OFF", TRACE: "OFF" });
      const gs = build(cfg, 42, [["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0]]);
      gs.new_game();
      gs.update(DT);
      gs.current_shooter = gs.tanks[0];
      const shooter = gs.tanks[0];
      const target = gs.tanks[1];
      const yy = 200;
      shooter.x = 250; shooter.y = yy;
      target.x = 310; target.y = yy;
      for (let cx = 230; cx < 340; cx += 12) gs.terrain.carve_circle(cx, yy + 6, 18);
      if (c.shielded) { target.shield_hp = 100; target.shield_item = weapons.SLOT_SHIELD; }
      shooter.inventory[c.slot] = 20;
      shooter.angle = 0; shooter.power = 300; shooter.selected_weapon = c.slot;
      gs.fire();
      const steps: Snap[] = [snap(gs, "after_fire")];
      let n = 0;
      let emptyAt: number | null = null;
      while (n < 120) {
        gs.update(DT);
        n += 1;
        steps.push(snap(gs, `f${n}`));
        if (gs.phase === "round_end" || gs.phase === "game_over" || gs.phase === "aim") break;
        if (emptyAt === null && gs.projectiles.length === 0) emptyAt = n;
        if (emptyAt !== null && n >= emptyAt + 6) break;
      }
      expect(steps.length, `resolve_hit[${c.label}] count`).toBe(c.steps.length);
      for (let i = 0; i < c.steps.length; i++) {
        expectSnap(steps[i], c.steps[i], `resolve_hit[${c.label}][${i}]`);
      }
    });
  }
});

// ===========================================================================
// Scenario N: CPU-only triple-turret triple shot.
// ===========================================================================
describe("game_flow: CPU triple-turret fires 3 fanned shots", () => {
  it("three projectiles, fanned", () => {
    const c = vec.triple[0];
    const cfg = makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, FALLING_TANKS: "OFF", CHANGING_WIND: "OFF", TRACE: "OFF" });
    const gs = build(cfg, 42, [["A", C.AI_HUMAN, 0, 6], ["B", C.AI_HUMAN, 0, 0]]);
    gs.new_game();
    gs.update(DT);
    gs.current_shooter = gs.tanks[0];
    const shooter = gs.tanks[0];
    shooter.angle = 80; shooter.power = 300;
    shooter.selected_weapon = weapons.SLOT_MISSILE;
    shooter.inventory[weapons.SLOT_MISSILE] = 9;
    const spawned = gs.fire();
    expect(shooter.tank_icon, "icon").toBe(c.icon);
    expect(spawned.length, "n spawned").toBe(c.n_spawned);
    expect(spawned.length, "triple = 3").toBe(3);
    expectSnap(snap(gs, "after_fire"), c.after_fire, "triple");
  });
});

// ===========================================================================
// Scenario O: fire() ammo fallback + auto-switch.
// ===========================================================================
describe("game_flow: fire() ammo fallback + auto-switch", () => {
  it("fallback to baby missile when owned 0", () => {
    const c = vec.ammo_fallback[0];
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, FALLING_TANKS: "OFF", CHANGING_WIND: "OFF" }), 1,
      [["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0]]);
    gs.new_game();
    gs.update(DT);
    const sh = gs.current_shooter!;
    sh.inventory[weapons.SLOT_MISSILE] = 0;
    sh.selected_weapon = weapons.SLOT_MISSILE;
    sh.angle = 80; sh.power = 300;
    const spawned = gs.fire();
    expect(spawned[0].weapon.behavior, "behavior").toBe(c.behavior);
    expect(sh.selected_weapon, "selected_after").toBe(c.selected_after);
  });
  it("auto-switch to baby missile when last round fired", () => {
    const c = vec.ammo_fallback[1];
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, FALLING_TANKS: "OFF", CHANGING_WIND: "OFF" }), 1,
      [["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0]]);
    gs.new_game();
    gs.update(DT);
    const sh = gs.current_shooter!;
    sh.inventory[weapons.SLOT_MISSILE] = 1;
    sh.selected_weapon = weapons.SLOT_MISSILE;
    sh.angle = 80; sh.power = 300;
    const spawned = gs.fire();
    expect(spawned[0].weapon.behavior, "behavior").toBe(c.behavior);
    expect(sh.selected_weapon, "selected_after").toBe(c.selected_after);
    expect(sh.inventory[weapons.SLOT_MISSILE], "missile_left").toBe(c.missile_left);
  });
});

// ===========================================================================
// Scenario P: ELASTIC RANDOM / ERRATIC live-wall roll.
// ===========================================================================
describe("game_flow: ELASTIC RANDOM/ERRATIC live-wall roll", () => {
  for (let ci = 0; ci < vec.elastic.length; ci++) {
    const c = vec.elastic[ci];
    it(`${c.token} seed=${c.seed}`, () => {
      const cfg = makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, FALLING_TANKS: "OFF", CHANGING_WIND: "OFF", ELASTIC: c.token });
      const gs = build(cfg, c.seed, [["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0]]);
      gs.new_game();
      expect(gs.cfg.live_elastic, `${c.token} after_round`).toBe(c.after_round);
      gs.update(DT);
      const sh = gs.current_shooter!;
      sh.angle = 80; sh.power = 300; sh.selected_weapon = weapons.SLOT_BABY_MISSILE;
      gs.fire();
      expect(gs.cfg.live_elastic, `${c.token} after_fire`).toBe(c.after_fire);
    });
  }
});

// ===========================================================================
// Scenario Q: team win (TEAM_MODE STANDARD).
// ===========================================================================
describe("game_flow: team win_check (TEAM_MODE STANDARD)", () => {
  for (let ci = 0; ci < vec.team_win.length; ci++) {
    const c = vec.team_win[ci];
    it(`seed=${c.seed}`, () => {
      const cfg = makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, FALLING_TANKS: "OFF", CHANGING_WIND: "OFF", TEAM_MODE: "STANDARD", SCORING: "STANDARD" });
      const gs = build(cfg, c.seed, [
        ["A", C.AI_HUMAN, 1, 0], ["B", C.AI_HUMAN, 1, 0],
        ["C", C.AI_HUMAN, 2, 0], ["D", C.AI_HUMAN, 2, 0],
      ]);
      gs.new_game();
      const steps: Snap[] = [snap(gs, "start")];
      gs.current_shooter = null;
      damage.kill_tank(gs as unknown as damage.State, gs.tanks[2] as unknown as damage.Tank);
      steps.push(snap(gs, "kill_c"));
      expect(gs._win_check(), `win_before`).toBe(c.win_before);
      damage.kill_tank(gs as unknown as damage.State, gs.tanks[3] as unknown as damage.Tank);
      steps.push(snap(gs, "kill_d"));
      expect(gs._win_check(), `win_after`).toBe(c.win_after);
      for (let i = 0; i < c.steps.length; i++) {
        expectSnap(steps[i], c.steps[i], `team_win[${c.seed}][${i}]`);
      }
    });
  }
});

// ===========================================================================
// Scenario R: arm-shield edges (already-up / SIM auto-defense gate).
// ===========================================================================
describe("game_flow: arm-shield edges", () => {
  it("already-up returns null", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, [["A", C.AI_HUMAN, 0, 0]]);
    gs.new_game();
    const t = gs.tanks[0];
    t.shield_hp = 80; t.shield_item = weapons.SLOT_SHIELD;
    t.inventory[weapons.SLOT_FORCE_SHIELD] = 1;
    const slot = gs._arm_best_shield(t, true);
    expect(slot).toBe(vec.arm_edges.already_up.slot);
    expect(t.shield_hp).toBe(vec.arm_edges.already_up.shield_hp);
    expect(t.inventory[weapons.SLOT_FORCE_SHIELD]).toBe(vec.arm_edges.already_up.inv_force);
  });
  it("SIM without Auto-Defense clears the shield", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, PLAY_MODE: "SIMULTANEOUS" }), 1, [["A", C.AI_HUMAN, 0, 0]]);
    gs.new_game();
    const t = gs.tanks[0];
    t.shield_hp = 0; t.inventory[weapons.SLOT_SHIELD] = 1;
    gs._arm_defenses(t);
    expect(t.shield_hp).toBe(vec.arm_edges.sim_no_autodef.shield_hp);
    expect(t.shield_item).toBe(vec.arm_edges.sim_no_autodef.shield_item);
    expect(t.inventory[weapons.SLOT_SHIELD]).toBe(vec.arm_edges.sim_no_autodef.inv_shield);
  });
  it("SIM with Auto-Defense arms the best owned shield", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, PLAY_MODE: "SIMULTANEOUS" }), 1, [["A", C.AI_HUMAN, 0, 0]]);
    gs.new_game();
    const t = gs.tanks[0];
    t.shield_hp = 0;
    t.inventory[weapons.SLOT_AUTO_DEFENSE] = 1;
    t.inventory[weapons.SLOT_SHIELD] = 1;
    gs._arm_defenses(t);
    expect(t.shield_hp).toBe(vec.arm_edges.sim_autodef.shield_hp);
    expect(t.shield_item).toBe(vec.arm_edges.sim_autodef.shield_item);
    expect(t.inventory[weapons.SLOT_SHIELD]).toBe(vec.arm_edges.sim_autodef.inv_shield);
  });
});

// ===========================================================================
// Scenario S: mag-push step (_mag_deflect overhead box bumps vy per step).
// ===========================================================================
describe("game_flow: Mag Deflector overhead push (_mag_deflect)", () => {
  it("upward vy bump per step", () => {
    const ms = vec.mag_step;
    const cfg = makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, FALLING_TANKS: "OFF", CHANGING_WIND: "OFF", TRACE: "OFF" });
    const gs = build(cfg, 42, [["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0]]);
    gs.new_game();
    gs.update(DT);
    const shooter = gs.tanks[0];
    const target = gs.tanks[1];
    gs.current_shooter = shooter;
    shooter.x = 120; shooter.y = 240;
    target.x = 300; target.y = 240;
    target.shield_hp = 150;
    target.shield_item = weapons.SLOT_MAG_DEFLECTOR;
    target.shield_push = true;
    target.shield_deflect = false;
    const proj = physics.launch(shooter, gs.cfg as unknown as physics.PhysicsCfg, weapons.ITEMS[weapons.SLOT_BABY_MISSILE]);
    proj.px = target.x - 8;
    proj.py = target.y - 40;
    proj.sx = Math.round(proj.px);
    proj.sy = Math.round(proj.py);
    proj.prev_px = proj.px; proj.prev_py = proj.py;
    proj.vx = 1.0; proj.vy = -0.5;
    proj.owner = shooter;
    proj.armed = true;
    gs.projectiles = [proj];
    const got: Array<MagSeqRow | null> = [{ px: proj.px, py: proj.py, vx: proj.vx, vy: proj.vy, active: proj.active }];
    for (let k = 0; k < 8; k++) {
      gs._step_flight();
      if (gs.projectiles.length > 0) {
        const p = gs.projectiles[0];
        got.push({ px: p.px, py: p.py, vx: p.vx, vy: p.vy, active: p.active });
      } else {
        got.push(null);
      }
    }
    expect(got.length).toBe(ms.seq.length);
    for (let i = 0; i < ms.seq.length; i++) {
      const w = ms.seq[i];
      const g = got[i];
      if (w === null) { expect(g, `mag step${i} null`).toBeNull(); continue; }
      expect(g, `mag step${i} present`).not.toBeNull();
      expect(g!.active, `mag step${i} active`).toBe(w.active);
      expect(g!.px, `mag step${i} px`).toBeCloseTo(w.px, 12);
      expect(g!.py, `mag step${i} py`).toBeCloseTo(w.py, 12);
      expect(g!.vx, `mag step${i} vx`).toBeCloseTo(w.vx, 12);
      expect(g!.vy, `mag step${i} vy`).toBeCloseTo(w.vy, 12);
    }
    expect(target.shield_hp, "mag does not chip").toBe(ms.shield_hp);
  });
});

// ===========================================================================
// Scenario T: explosion tail (expand->flash->shrink->done), dirt stamp, firewall
// expiry/restore.
// ===========================================================================
describe("game_flow: explosion/firewall animation tails", () => {
  it("grow explosion runs expand->flash->shrink->done", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, [["A", C.AI_HUMAN, 0, 0]]);
    gs.new_game();
    gs.add_explosion(200, 200, 35);
    const got: Array<[number, number] | null> = [];
    for (let k = 0; k < 120; k++) {
      gs._animate_effects();
      if (gs.explosions.length > 0) {
        const e = gs.explosions[0];
        got.push([num(e.phase), num(e.frame)]);
      } else { got.push(null); break; }
    }
    expect(got, "grow tail").toEqual(vec.explo_tail.grow);
  });
  it("dirt stamp ages out after the hold", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, [["A", C.AI_HUMAN, 0, 0]]);
    gs.new_game();
    gs.add_explosion(150, 150, 18, { dirt_only: true });
    const got: Array<[number, number] | null> = [];
    for (let k = 0; k < 8; k++) {
      gs._animate_effects();
      if (gs.explosions.length > 0) {
        const e = gs.explosions[0];
        got.push([num(e.phase), num(e.frame)]);
      } else { got.push(null); break; }
    }
    expect(got, "stamp tail").toEqual(vec.explo_tail.stamp);
  });
  it("firewall band expires and restores", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, [["A", C.AI_HUMAN, 0, 0]]);
    gs.new_game();
    gs.add_firewall(100, 100, 250);
    const got: Array<{ n: number; active: boolean }> = [];
    for (let k = 0; k < 125; k++) {
      gs._tick_firewall_band(3);
      got.push({ n: gs.firewalls.length, active: gs._firewall_band_active });
    }
    expect(got, "firewall expire").toEqual(vec.explo_tail.firewall_expire);
  });
});

// ===========================================================================
// Scenario U(diff): narrow GUARD / early-return edge branches, differential vs
// oracle/dump_game_flow.scen_edges.  Each mirrors the Python setup EXACTLY (same
// build seed, same direct internal-method call) and asserts the same compact
// observable.  Drives the wind-jitter zero path, the SYNC/SIM turn-loop guards,
// the off-field detonate split, the mag-deflect skip gates, a digger fizzling on
// a shield, a contact sandhog, the out-of-chutes settle, and the lightning no-op.
// ===========================================================================
describe("game_flow: coverage edge branches (differential)", () => {
  const E = vec.edges;
  const P2: Player[] = [["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0]];
  const AI2: Player[] = [["AI1", C.AI_SHOOTER, 0, 0], ["AI2", C.AI_SHOOTER, 0, 0]];
  const AI3: Player[] = [
    ["AI1", C.AI_SHOOTER, 0, 0], ["AI2", C.AI_SHOOTER, 0, 0], ["AI3", C.AI_SHOOTER, 0, 0],
  ];

  function offf(
    mode: number, slot: number, px: number, py: number, sx: number, sy: number,
    blast?: number,
  ): OffField {
    // `mode` is the live wall sub-mode the boundary handler sees (cfg.live_elastic;
    // 5 == WRAP detonate).  Set numerically -- the ELASTIC token table is not 1:1
    // with the wall-mode numbers (token "WRAP" parses to 1, not 5).
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, P2);
    gs.new_game();
    gs.cfg.live_elastic = mode;
    const p = physics.launch(gs.tanks[0], gs.cfg as unknown as physics.PhysicsCfg, weapons.ITEMS[slot]);
    if (blast !== undefined) {
      // clone first (physics.launch shares weapons.ITEMS[slot]; mutating in place
      // would corrupt the global table) -- mirror dump_game_flow.offf's deepcopy.
      p.weapon = Object.assign(Object.create(Object.getPrototypeOf(p.weapon)), p.weapon) as weapons.Item;
      p.weapon.blast = blast;
    }
    p.px = px; p.py = py; p.sx = sx; p.sy = sy;
    p.owner = gs.tanks[0];
    gs.last_landing = null;
    const ne = gs.explosions.length;
    gs._resolve_off_field(p);
    return { last_landing: gs.last_landing, active: p.active, n_expl: gs.explosions.length - ne };
  }

  it("_perturb_wind pins wind to 0 when MAX_WIND<=0 (511-513)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, CHANGING_WIND: "ON" }), 1, P2);
    gs.new_game();
    gs.cfg.wind = 50;
    gs._perturb_wind();
    expect(gs.cfg.wind).toBe(E.perturb_zero.wind);
  });

  it("SYNC re-aim head perturbs the wind (1073-1074)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 200, CHANGING_WIND: "ON", PLAY_MODE: "SYNCHRONOUS" }), 7, AI2);
    gs.new_game();
    gs._sync_start_volley();
    expect(gs.cfg.wind, "sync wind").toBe(E.sync_wind.wind);
    expect(gs.phase, "sync phase").toBe(E.sync_wind.phase);
  });

  it("SIM AI cadence perturbs the wind as a shot resolves (1290-1291)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 200, CHANGING_WIND: "ON", PLAY_MODE: "SIMULTANEOUS" }), 7, AI2);
    gs.new_game();
    for (const t of gs.tanks) gs._sim[t.player_index].timer = 0.0;
    gs._sim_update(DT);
    expect(gs.cfg.wind, "sim wind").toBe(E.sim_wind.wind);
    expect(gs.phase, "sim phase").toBe(E.sim_wind.phase);
  });

  it("SYNC_AIM parks on a human shooter (1150-1151)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, PLAY_MODE: "SYNCHRONOUS" }), 1, P2);
    gs.new_game();
    const seq: Array<[string, number]> = [
      [gs.phase, gs.current_shooter ? gs.current_shooter.player_index : -1],
    ];
    for (let k = 0; k < 3; k++) {
      gs.update(DT);
      seq.push([gs.phase, gs.current_shooter ? gs.current_shooter.player_index : -1]);
    }
    expect(seq).toEqual(E.sync_human_wait.seq);
  });

  it("_sync_collect parks while a human's lock is pending (1150-1151)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, PLAY_MODE: "SYNCHRONOUS" }), 1, P2);
    gs.new_game();
    gs.phase = "sync_aim";
    gs.current_shooter = gs.tanks[0]; // a human shooter
    const q0 = gs._sync_queue.slice();
    gs._sync_collect(DT); // human -> early return, no advance/tick
    expect(gs.phase).toBe(E.sync_collect_human.phase);
    const cs = gs.current_shooter as { player_index: number } | null;
    expect(cs ? cs.player_index : -1).toBe(E.sync_collect_human.cs);
    expect(JSON.stringify(gs._sync_queue) === JSON.stringify(q0)).toBe(E.sync_collect_human.queue_same);
  });

  it("_sync_advance win short-circuit (1088-1090)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, PLAY_MODE: "SYNCHRONOUS", SCORING: "STANDARD" }), 1, P2);
    gs.new_game();
    gs.current_shooter = null;
    damage.kill_tank(gs as unknown as damage.State, gs.tanks[1] as unknown as damage.Tank);
    gs._sync_advance();
    expect(gs.phase).toBe(E.sync_advance_win.phase);
    expect(gs.round_index).toBe(E.sync_advance_win.round_index);
  });

  it("_sync_advance drops a dead queue head (1097-1098)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, PLAY_MODE: "SYNCHRONOUS" }), 1, AI3);
    gs.new_game();
    gs.tanks[0].alive = false;
    gs._sync_locks = {};
    gs._sync_queue = [0, 1, 2];
    gs.current_shooter = null;
    gs._sync_advance();
    const cs = gs.current_shooter as { player_index: number } | null;
    expect(cs ? cs.player_index : -1).toBe(E.sync_drop_dead.cs);
    expect(gs._sync_queue).toEqual(E.sync_drop_dead.queue);
    expect(gs.phase).toBe(E.sync_drop_dead.phase);
  });

  it("_sync_volley ends the round on the post-settle win (1202)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, PLAY_MODE: "SYNCHRONOUS", SCORING: "STANDARD" }), 1, P2);
    gs.new_game();
    gs.phase = "sync_volley";
    gs.timer = 0.0;
    gs.projectiles = [];
    gs.explosions = [];
    gs.beams = [];
    gs.plasma_rings = [];
    gs.death_fountains = [];
    gs.throe_fx = [];
    gs.tanks[1].alive = false;
    gs.tanks[1].health = 0;
    gs._sync_volley(DT);
    expect(gs.phase).toBe(E.sync_volley_win.phase);
    expect(gs.round_index).toBe(E.sync_volley_win.round_index);
  });

  it("_sim_begin_round skips a dead tank (1217-1218)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, PLAY_MODE: "SIMULTANEOUS" }), 1, AI2);
    gs.new_game();
    gs.tanks[0].alive = false;
    gs._sim_begin_round();
    expect(Object.keys(gs._sim).map(Number).sort((a, b) => a - b)).toEqual(E.sim_begin_dead.sim_keys);
  });

  it("_sim_begin_round disables the passive chute for an Auto-Defense owner (1221)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, PLAY_MODE: "SIMULTANEOUS" }), 1, P2);
    gs.new_game();
    gs.tanks[0].inventory[weapons.SLOT_AUTO_DEFENSE] = 1;
    gs._sim_begin_round();
    expect(gs.tanks.map((t) => !!t.parachute_deployed)).toEqual(E.sim_begin_autodef.parachute);
  });

  it("_sim_update win short-circuit (1268-1270)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, PLAY_MODE: "SIMULTANEOUS", SCORING: "STANDARD" }), 1, AI2);
    gs.new_game();
    damage.kill_tank(gs as unknown as damage.State, gs.tanks[1] as unknown as damage.Tank);
    gs._sim_update(DT);
    expect(gs.phase).toBe(E.sim_update_win.phase);
    expect(gs.round_index).toBe(E.sim_update_win.round_index);
  });

  it("_sim_update ends the round only after the death queue drains (decoded model)", () => {
    // Decoded-model twin of the win short-circuit above: a SIM kill now STAGES
    // its roulette throe (death_queue), and the win check is queue-guarded so
    // any pending grave blast (cases 1-3) lands before the round ends -- the
    // binary's blocking sweep order.  TS-only phase-machine check (the vector
    // above pins the deferred FALSE branch; this drives the drain to the TRUE
    // branch).
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, PLAY_MODE: "SIMULTANEOUS", SCORING: "STANDARD" }), 1, AI2);
    gs.new_game();
    damage.kill_tank(gs as unknown as damage.State, gs.tanks[1] as unknown as damage.Tank);
    gs._sim_update(DT);
    expect(gs.phase, "held while the throe plays").toBe("sim_live");
    let drained = -1;
    for (let i = 0; i < 60 * 60 && gs.phase === "sim_live"; i++) {
      gs._sim_update(DT);
      if (drained < 0 && gs.death_queue.length === 0 && gs.throe_fx.length === 0) drained = i;
    }
    expect(gs.death_queue.length, "queue drained").toBe(0);
    expect(gs.phase, "round ends after the drain").toBe("round_end");
    expect(drained, "the end came from the drain, not a stall").toBeGreaterThanOrEqual(0);
  });

  it("_sim_update skips a tank with no _sim record (1279-1280)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, PLAY_MODE: "SIMULTANEOUS" }), 1, AI2);
    gs.new_game();
    delete gs._sim[gs.tanks[1].player_index];
    gs._sim_update(DT);
    expect(gs.phase).toBe(E.sim_update_no_rec.phase);
    expect(gs.projectiles.filter((p) => p.owner === gs.tanks[1]).length).toBe(E.sim_update_no_rec.t1_proj);
  });

  it("MIRV contact trigger propagates to every child warhead (1426-1429)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, FALLING_TANKS: "OFF", CHANGING_WIND: "OFF" }), 1, P2);
    gs.new_game();
    gs.update(DT);
    const sh = gs.current_shooter!;
    sh.inventory[6] = 5;
    sh.angle = 70; sh.power = 700; sh.selected_weapon = 6;
    sh.contact_trigger = true;
    gs.fire();
    let n = 0;
    while (n < 400 && gs.projectiles.length <= 1) { gs.update(DT); n += 1; }
    expect(gs.projectiles.length).toBe(E.mirv_contact.nproj);
    expect(gs.projectiles.map((p) => !!p.contact)).toEqual(E.mirv_contact.contacts);
  });

  it("_resolve_off_field: floor / WRAP side+ceil / tracer-lose / digger fizzle-vs-explode (1464-1497)", () => {
    expect(offf(0, 1, 300.0, 480.0, 300, 479)).toEqual(E.offfield_floor);
    expect(offf(5, 1, -3.0, 200.0, 0, 200)).toEqual(E.offfield_wrap);
    expect(offf(5, 1, 200.0, -3.0, 200, 0)).toEqual(E.offfield_wrap_ceil);
    expect(offf(0, 10, 300.0, 480.0, 300, 479)).toEqual(E.offfield_tracer);
    expect(offf(0, 20, 300.0, 480.0, 300, 479)).toEqual(E.offfield_digger);
    expect(offf(0, 20, 300.0, 480.0, 300, 479, 0)).toEqual(E.offfield_digger_zero);
  });

  it("_mag_deflect skips on vx==0 and on |dx|>15 (1557-1562)", () => {
    function magskip(dx: number, vx: number): MagSkip {
      const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, P2);
      gs.new_game();
      const sh = gs.tanks[0];
      const tg = gs.tanks[1];
      tg.x = 300; tg.y = 240;
      tg.shield_hp = 150;
      tg.shield_item = weapons.SLOT_MAG_DEFLECTOR;
      tg.shield_push = true;
      tg.shield_deflect = false;
      const p = physics.launch(sh, gs.cfg as unknown as physics.PhysicsCfg, weapons.ITEMS[weapons.SLOT_BABY_MISSILE]);
      p.owner = sh;
      p.px = tg.x + dx; p.py = tg.y - 40;
      p.sx = tg.x + dx; p.sy = tg.y - 40;
      p.vx = vx; p.vy = -0.5;
      const before = p.vy;
      gs._mag_deflect(p);
      return { vy_before: before, vy_after: p.vy };
    }
    const a = magskip(-8, 0.0);
    expect(a.vy_before).toBeCloseTo(E.mag_vx0.vy_before, 12);
    expect(a.vy_after).toBeCloseTo(E.mag_vx0.vy_after, 12);
    const b = magskip(-40, 1.0);
    expect(b.vy_before).toBeCloseTo(E.mag_farx.vy_before, 12);
    expect(b.vy_after).toBeCloseTo(E.mag_farx.vy_after, 12);
  });

  it("digger fizzles on a shielded tank, no chip (1675)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, P2);
    gs.new_game();
    const tg = gs.tanks[1];
    tg.shield_hp = 100;
    tg.shield_item = weapons.SLOT_SHIELD;
    const p = physics.launch(gs.tanks[0], gs.cfg as unknown as physics.PhysicsCfg, weapons.ITEMS[20]);
    p.owner = gs.tanks[0];
    const hp0 = tg.shield_hp;
    gs._resolve_hit(p, { 0: "tank", 1: tg, 2: tg.x, 3: tg.y });
    expect(p.active).toBe(E.digger_on_shield.active);
    expect(hp0).toBe(E.digger_on_shield.shield_before);
    expect(tg.shield_hp).toBe(E.digger_on_shield.shield_after);
  });

  it("contact-trigger sandhog detonates at the surface (1740-1744)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, P2);
    gs.new_game();
    const p = physics.launch(gs.tanks[0], gs.cfg as unknown as physics.PhysicsCfg, weapons.ITEMS[23]);
    p.owner = gs.tanks[0];
    p.contact = true;
    const x = gs.tanks[0].x;
    const y = gs.terrain.column_top(x) + 1;
    gs._resolve_hit(p, { 0: "terrain", 1: null, 2: x, 3: y });
    expect(p.active).toBe(E.contact_sandhog.active);
    expect(gs.last_landing).toEqual(E.contact_sandhog.last_landing);
  });

  it("settle: a chute deploy that exhausts the last chute goes passive (1860-1861)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, FALLING_TANKS: "ON" }), 3, P2);
    gs.new_game();
    const t0 = gs.tanks[0];
    t0.parachute_deployed = true;
    t0.parachute_threshold = 0;
    t0.inventory[weapons.SLOT_PARACHUTE] = 1;
    gs.terrain.carve_circle(t0.x, t0.y + 30, 60);
    gs._settle_tank(t0);
    expect(t0.inventory[weapons.SLOT_PARACHUTE]).toBe(E.settle_no_chute.parachutes);
    expect(!!t0.parachute_deployed).toBe(E.settle_no_chute.deployed);
    expect(t0.y).toBe(E.settle_no_chute.y);
  });

  it("_tick_lightning_band is a no-op while every flash is still staggered (2231-2232)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, [["A", C.AI_HUMAN, 0, 0]]);
    gs.new_game();
    const lo = palette.LIGHTNING_BAND_LO;
    const hi = palette.LIGHTNING_BAND_HI;
    const slice = (): number[][] => {
      const out: number[][] = [];
      for (let i = lo; i <= hi; i++) {
        const r = gs.lut.table[i];
        out.push([r[0], r[1], r[2]]);
      }
      return out;
    };
    const bandBefore = slice();
    gs.add_flash(5, 10, [255, 255, 235], 4); // stagger delay 4 -> frame -4 (<0)
    gs._tick_lightning_band(); // level stays 0 -> early return, band untouched
    const bandAfter = slice();
    expect(gs.flashes[0].frame as number).toBe(E.lightning_zero.frame);
    expect(bandAfter, "TS band unchanged by the no-op").toEqual(bandBefore);
    expect(bandBefore, "band matches oracle before").toEqual(E.lightning_zero.band_before);
    expect(bandAfter, "band matches oracle after").toEqual(E.lightning_zero.band_after);
  });
});

// ===========================================================================
// Scenario U: test-only edge guards (no oracle needed -- defensive/headless).
// ===========================================================================
describe("game_flow: edge guards", () => {
  it("mass_kill on an empty roster is a no-op", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, []);
    const phaseBefore = gs.phase;
    const roundBefore = gs.round_index;
    expect(() => gs.mass_kill()).not.toThrow();
    expect(gs.phase, "phase unchanged").toBe(phaseBefore);
    expect(gs.round_index, "round unchanged").toBe(roundBefore);
  });
  it("SIMULTANEOUS human input/keydown are no-ops on the headless (empty) keymap", () => {
    const cfg = makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, PLAY_MODE: "SIMULTANEOUS" });
    const gs = build(cfg, 1, [["H", C.AI_HUMAN, 0, 0], ["AI", C.AI_SHOOTER, 0, 0]]);
    gs.new_game();
    gs.update(DT);
    const human = gs.tanks[0];
    const angleBefore = human.angle;
    const powerBefore = human.power;
    // empty keymap (headless) -> held controls and keydown are inert.
    expect(() => gs._sim_human_input(null, DT)).not.toThrow();
    expect(() => gs._sim_human_input([true, true, true, true, true, true], DT)).not.toThrow();
    expect(gs._sim_human_keydown(-1), "keydown inert").toBe(false);
    expect(human.angle, "angle unchanged").toBe(angleBefore);
    expect(human.power, "power unchanged").toBe(powerBefore);
  });

  it("SIMULTANEOUS held controls drive the local human with a populated keymap (1329-1345)", () => {
    // The headless port builds an EMPTY keymap (no pygame.key.key_code); the
    // browser/render wiring fills it.  Inject a populated keymap so the held-control
    // branches run.  TS-only (the oracle's headless keymap is empty -- not
    // differential).  HOLD_DT is >1deg/step so the int() truncation shows movement.
    const HOLD_DT = 0.1;
    const cfg = makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, PLAY_MODE: "SIMULTANEOUS" });
    const gs = build(cfg, 1, [["H", C.AI_HUMAN, 0, 0], ["AI", C.AI_SHOOTER, 0, 0]]);
    gs.new_game();
    gs.update(DT); // phase SIM_LIVE; _sim_human = the human tank
    const human = gs.tanks[0];
    gs._sim_keymap = { cw: 0, ccw: 1, power_up: 2, power_down: 3, fire: 4, weapon: 5 };
    human.angle = 90; human.power = 500;
    gs._sim_human_input([true, false, false, false], HOLD_DT);
    expect(human.angle, "cw lowers angle (toward East)").toBeLessThan(90);
    human.angle = 90;
    gs._sim_human_input([false, true, false, false], HOLD_DT);
    expect(human.angle, "ccw raises angle").toBeGreaterThan(90);
    human.power = 500;
    gs._sim_human_input([false, false, true, false], HOLD_DT);
    expect(human.power, "power_up raises power").toBeGreaterThan(500);
    human.power = 500;
    gs._sim_human_input([false, false, false, true], HOLD_DT);
    expect(human.power, "power_down lowers power").toBeLessThan(500);
  });

  it("SIMULTANEOUS keydown fire + weapon dispatch with a populated keymap (1363-1370)", () => {
    const cfg = makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0, PLAY_MODE: "SIMULTANEOUS" });
    const gs = build(cfg, 1, [["H", C.AI_HUMAN, 0, 0], ["AI", C.AI_SHOOTER, 0, 0]]);
    gs.new_game();
    gs.update(DT);
    gs._sim_keymap = { cw: 0, ccw: 1, power_up: 2, power_down: 3, fire: 4, weapon: 5 };
    const human = gs.tanks[0];
    human.angle = 60; human.power = 400; human.selected_weapon = weapons.SLOT_BABY_MISSILE;
    const before = gs.projectiles.filter((p) => p.owner === human).length;
    expect(gs._sim_human_keydown(4), "fire dispatched").toBe(true);
    expect(gs.projectiles.filter((p) => p.owner === human).length, "human shell launched").toBeGreaterThan(before);
    // weapon key is swallowed (returns true); the headless port stubs cycle_weapon.
    expect(gs._sim_human_keydown(5), "weapon swallowed").toBe(true);
    expect(gs._sim_human_keydown(99), "unmapped key not swallowed").toBe(false);
  });

  it("fire() parks an attack-taunt bubble when the talk pool is populated (859-863)", () => {
    // The headless default talk pools are empty (oracle keeps TALKING_TANKS OFF);
    // inject ALL + probability 100 + a 1-line pool to force a deterministic taunt
    // -> set_speech.  TS-only stub (not differential).
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, [["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0]]);
    gs.new_game();
    gs.update(DT);
    const sh = gs.current_shooter!;
    sh.angle = 70; sh.power = 300;
    gs.talk = new TalkConfig(["ZAP!"], ["URK!"], {
      TALKING_TANKS: "ALL", TALK_PROBABILITY: 100, TALK_DELAY: 50,
      ATTACK_COMMENTS: "", DIE_COMMENTS: "",
    });
    gs.speech = null;
    gs.fire();
    expect(gs.speech, "attack taunt parked").not.toBeNull();
    expect((gs.speech as unknown as { text: string }).text).toBe("ZAP!");
  });

  it("kill parks a die-taunt bubble at roulette processing time (2124-2129 -> award signal, 1834-1841)", () => {
    // Decoded-model update (notes_death_throe_roulette.md s.2.1): the die taunt
    // no longer parks synchronously inside on_tank_destroyed -- that call now
    // ONLY enqueues the corpse; award + taunt fire when the staged death queue
    // PROCESSES it (the ("award", tank) signal in _step_death_queue), the
    // binary's dead-tank-sweep order.  Same guarantee (pool line -> speech
    // bubble), moved to processing time; driven here by update ticks.
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, [["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0]]);
    gs.new_game();
    gs.talk = new TalkConfig(["ZAP!"], ["URK!"], {
      TALKING_TANKS: "ALL", TALK_PROBABILITY: 100, TALK_DELAY: 50,
      ATTACK_COMMENTS: "", DIE_COMMENTS: "",
    });
    gs.speech = null;
    gs.tanks[1].health = 0;
    gs.tanks[1].alive = false;
    gs.phase = "firing"; // the queue steps in FIRING/SETTLE/SYNC/SIM, not AIM
    gs.on_tank_destroyed(gs.tanks[1], null);
    expect(gs.speech, "no taunt at enqueue time (processing-time model)").toBeNull();
    for (let i = 0; i < 600 && gs.speech === null; i++) {
      gs.update(DT);
    }
    expect(gs.speech, "die taunt parked at processing").not.toBeNull();
    expect((gs.speech as unknown as { text: string }).text).toBe("URK!");
  });

  it("_leapfrog_hop is a no-op when the projectile has no owner (1762-1763)", () => {
    // A fired leapfrog always carries its owner; this TS-only defensive guard (the
    // Python oracle would AttributeError here, so it is not differential) returns
    // before dereferencing a null owner.
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, [["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0]]);
    gs.new_game();
    const p = physics.launch(gs.tanks[0], gs.cfg as unknown as physics.PhysicsCfg, weapons.ITEMS[4]);
    p.owner = null;
    p.warheads_left = 3;
    const before = gs.projectiles.length;
    expect(() => gs._leapfrog_hop(p, 100, 100)).not.toThrow();
    expect(gs.projectiles.length, "no hop spawned for an owner-less proj").toBe(before);
  });

  it("_start_chute_descent ignores a trivial path (<2 points) (1875-1876)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, [["A", C.AI_HUMAN, 0, 0]]);
    gs.new_game();
    const t = gs.tanks[0] as unknown as { chute_descent?: unknown; x: number; y: number };
    t.chute_descent = null;
    gs._start_chute_descent(gs.tanks[0], [[t.x, t.y]]); // length 1 -> early return
    expect(t.chute_descent, "no descent for a 1-point path").toBeFalsy();
    gs._start_chute_descent(gs.tanks[0], []); // empty -> early return
    expect(t.chute_descent, "no descent for an empty path").toBeFalsy();
  });

  it("retreat() returns false for a null or dead tank (793-794)", () => {
    const gs = build(makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 0, MAX_WIND: 0 }), 1, [["A", C.AI_HUMAN, 0, 0], ["B", C.AI_HUMAN, 0, 0]]);
    gs.new_game();
    gs.tanks[1].alive = false;
    expect(gs.retreat(gs.tanks[1]), "a dead tank cannot retreat").toBe(false);
    gs.current_shooter = null;
    expect(gs.retreat(), "no current shooter -> false").toBe(false);
  });
});
