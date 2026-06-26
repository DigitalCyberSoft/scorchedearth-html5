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

type GameFlowVectors = {
  module: string; field: [number, number]; lut_idx: number[]; terr_x: number[];
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
      // the death FX MUST be populated with finite numbers (the regression guard).
      const ak = steps[steps.length - 1];
      expect(ak.fx.death_fountains.length, "fountains populated").toBeGreaterThan(0);
      for (const f of ak.fx.death_fountains) {
        for (const v of [f.col, f.y, f.top, f.color, f.stride, f.scatter]) {
          expect(Number.isInteger(v)).toBe(true);
        }
      }
      expect(ak.fx.explosions.length, "explosions populated").toBeGreaterThan(0);
      for (let k = 0; k < 6; k++) {
        gs._animate_effects();
        steps.push(snap(gs, `anim${k}`));
      }
      expect(steps.length, `death#${ci} step count`).toBe(c.steps.length);
      for (let i = 0; i < c.steps.length; i++) {
        expectSnap(steps[i], c.steps[i], `death[${c.seed}][${i}]`);
      }
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
      expect(gs.phase, `retreat_win#${ci} ends round`).toBe("round_end");
      for (let i = 0; i < c.steps.length; i++) {
        expectSnap(steps[i], c.steps[i], `retreat_win[${c.seed}][${i}]`);
      }
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
});
