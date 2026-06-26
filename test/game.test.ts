/**
 * Differential gate: TS scorch.game GameState == Python scorch.game.GameState
 * (the byte-verified fidelity oracle).  game is the make-or-break fidelity module:
 * the whole round/turn/fire/settle pipeline lives here.
 *
 * Golden vectors are produced by oracle/dump_game.py, which drives the REAL
 * scorch.game.GameState headless over FIXED seeds + scripted scenarios and dumps a
 * GameState SNAPSHOT after each pipeline step.  This test reproduces the SAME
 * scenarios against src/game.ts (same seeds via createGameState, same Config pins,
 * same scripted fire/kill/explode calls, same drive loop) and asserts every
 * snapshot matches.
 *
 * EPSILON POLICY:
 *   Every tank field the engine carries as an int (health/x/y/shield_hp/shield_item/
 *   alive/score/cash/win_counter/angle/power), plus phase/current_shooter index/
 *   winner index/round_index/wind/fire_index, is asserted EXACT (.toBe / ===).
 *   The ONLY floats on the snapshot are in-flight projectile kinematics
 *   (px/py/vx/vy), which accumulate through sin/cos/sqrt/atan2 on the flight path;
 *   they are asserted .toBeCloseTo(.,12).  The TS rng (CPython MT, bit-exact) +
 *   pyRound (banker's) + the ported physics/damage make even these converge to ~12
 *   digits, and every dependent integer (placement, damage, score) is exact.
 *
 * SEEDING (== createGameState == main.py:476-479): createGameState seeds BOTH the
 * shared MT singleton (gs.rng) and Python's module-level random analog
 * (gs._pyrandom) with the same value before/at construction; the scenario builder
 * below mirrors dump_game.build by re-seeding both, then forces mtn_ranges=[] so
 * terrain.generate takes the _midpoint rng path on both sides.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  GameState,
  createGameState,
  AIM,
  SETTLE,
  ROUND_END,
  GAME_OVER,
  SYNC_AIM,
  SYNC_VOLLEY,
} from "../src/game";
import { Config } from "../src/config";
import * as C from "../src/constants";
import * as weapons from "../src/weapons";
import * as damage from "../src/damage";
import { rng as grng } from "../src/rng";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "game.json");

const W = 640;
const H = 480;

// ---------------------------------------------------------------------------
// Vector types (mirror dump_game.py's serialized shape exactly).
// ---------------------------------------------------------------------------
type TankSnap = {
  health: number;
  x: number;
  y: number;
  shield_hp: number;
  shield_item: number;
  alive: boolean;
  score: number;
  cash: number;
  win_counter: number;
  angle: number;
  power: number;
};
type ProjSnap = { px: number; py: number; vx: number; vy: number; active: boolean };
type Snap = {
  label: string;
  phase: string;
  current_shooter: number;
  winner: number;
  round_index: number;
  wind: number;
  fire_index: number;
  tanks: TankSnap[];
  projectiles: ProjSnap[];
};
type StepCase = { seed: number; steps: Snap[] } & { [k: string]: unknown };
type SetupCase = {
  seed: number;
  roster: number;
  steps: Snap[];
  extra: { firing_order: number[]; colors: number[]; inv0: number[] };
};
type PlayOrderCase = { seed: number; play_order: number; orders: number[][] };
type AiBuysCase = { seed: number; rows: Array<{ cash: number; inventory: number[] }> };

type GameVectors = {
  module: string;
  field: [number, number];
  setup: SetupCase[];
  single_shot: StepCase[];
  splash_kill: StepCase[];
  round_end_win: StepCase[];
  play_order: PlayOrderCase[];
  mirv_split: StepCase[];
  ai_buys: AiBuysCase[];
  round_cycle: StepCase[];
  sync_volley: StepCase[];
  sim_live: StepCase[];
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as GameVectors;

// ---------------------------------------------------------------------------
// Snapshot capture + comparison -- structurally identical to dump_game.snap.
// ---------------------------------------------------------------------------
function snapTank(t: GameState["tanks"][number]): TankSnap {
  return {
    health: t.health,
    x: t.x,
    y: t.y,
    shield_hp: t.shield_hp,
    shield_item: t.shield_item,
    alive: t.alive,
    score: t.score,
    cash: t.cash,
    win_counter: t.win_counter,
    angle: t.angle,
    power: t.power,
  };
}
function snapProj(p: GameState["projectiles"][number]): ProjSnap {
  return { px: p.px, py: p.py, vx: p.vx, vy: p.vy, active: p.active };
}
function snap(gs: GameState, label: string): Snap {
  const cs = gs.current_shooter !== null ? gs.current_shooter.player_index : -1;
  const win = gs.winner !== null ? gs.winner.player_index : -1;
  return {
    label,
    phase: gs.phase,
    current_shooter: cs,
    winner: win,
    round_index: gs.round_index,
    wind: gs.cfg.wind,
    fire_index: gs.fire_index,
    tanks: gs.tanks.map(snapTank),
    projectiles: gs.projectiles.map(snapProj),
  };
}

function expectTank(got: TankSnap, want: TankSnap, label: string): void {
  expect(got.health, `${label} health`).toBe(want.health);
  expect(got.x, `${label} x`).toBe(want.x);
  expect(got.y, `${label} y`).toBe(want.y);
  expect(got.shield_hp, `${label} shield_hp`).toBe(want.shield_hp);
  expect(got.shield_item, `${label} shield_item`).toBe(want.shield_item);
  expect(got.alive, `${label} alive`).toBe(want.alive);
  expect(got.score, `${label} score`).toBe(want.score);
  expect(got.cash, `${label} cash`).toBe(want.cash);
  expect(got.win_counter, `${label} win_counter`).toBe(want.win_counter);
  expect(got.angle, `${label} angle`).toBe(want.angle);
  expect(got.power, `${label} power`).toBe(want.power);
}
function expectProj(got: ProjSnap, want: ProjSnap, label: string): void {
  // px/py/vx/vy are flight-path floats -> toBeCloseTo(.,12); active is a boolean.
  expect(got.px, `${label} px`).toBeCloseTo(want.px, 12);
  expect(got.py, `${label} py`).toBeCloseTo(want.py, 12);
  expect(got.vx, `${label} vx`).toBeCloseTo(want.vx, 12);
  expect(got.vy, `${label} vy`).toBeCloseTo(want.vy, 12);
  expect(got.active, `${label} active`).toBe(want.active);
}
function expectSnap(got: Snap, want: Snap, label: string): void {
  const tag = `${label}/${want.label}`;
  expect(got.phase, `${tag} phase`).toBe(want.phase);
  expect(got.current_shooter, `${tag} current_shooter`).toBe(want.current_shooter);
  expect(got.winner, `${tag} winner`).toBe(want.winner);
  expect(got.round_index, `${tag} round_index`).toBe(want.round_index);
  expect(got.wind, `${tag} wind`).toBe(want.wind);
  expect(got.fire_index, `${tag} fire_index`).toBe(want.fire_index);
  expect(got.tanks.length, `${tag} tank count`).toBe(want.tanks.length);
  for (let i = 0; i < want.tanks.length; i++) {
    expectTank(got.tanks[i], want.tanks[i], `${tag} tank${i}`);
  }
  expect(got.projectiles.length, `${tag} proj count`).toBe(want.projectiles.length);
  for (let i = 0; i < want.projectiles.length; i++) {
    expectProj(got.projectiles[i], want.projectiles[i], `${tag} proj${i}`);
  }
}

// ---------------------------------------------------------------------------
// Config builder + GameState builder -- mirror dump_game.make_cfg / build.
// ---------------------------------------------------------------------------
function makeCfg(over: { [k: string]: string | number } = {}): Config {
  const cfg = new Config();
  cfg.SOUND = "OFF";
  cfg.TALKING_TANKS = "OFF";
  cfg.FLY_SOUND = "OFF";
  // SKY=PLAIN: matches dump_game.make_cfg -- a fixed sky that draws no rng and
  // avoids the CAVERN branch (a pre-existing hazard.ts/terrain.ts grid-shape
  // mismatch, unrelated to this port).
  cfg.SKY = "PLAIN";
  for (const k of Object.keys(over)) {
    (cfg as unknown as { [k: string]: unknown })[k] = over[k];
  }
  cfg.live_elastic = cfg.elastic; // re-resolve after any ELASTIC override
  return cfg;
}

type Player = [string, number, number, number];

function build(cfg: Config, seed: number, players: Player[]): GameState {
  // createGameState seeds the shared MT singleton (grng) at construction AND
  // gs._pyrandom afterward, both with `seed` -- exactly dump_game.build's
  // random.seed(seed)/grng.seed(seed).
  const gs = createGameState(cfg, W, H, seed);
  (gs as { mtn_ranges: unknown[] }).mtn_ranges = []; // pin the _midpoint rng path
  for (const [name, ai, team, icon] of players) {
    gs.add_player(name, ai, team, icon);
  }
  return gs;
}

function drive(
  gs: GameState,
  dt: number,
  maxFrames: number,
  steps: Snap[],
  stopPhases: Set<string>,
): void {
  let n = 0;
  while (n < maxFrames) {
    gs.update(dt);
    n += 1;
    steps.push(snap(gs, `frame${n}`));
    if (stopPhases.has(gs.phase)) {
      break;
    }
  }
}

const DT = 1 / 60.0;

// ---------------------------------------------------------------------------
// Sanity locks on the vector battery itself.
// ---------------------------------------------------------------------------
describe("game: oracle vector battery", () => {
  it("module tag + field match the dumper", () => {
    expect(vec.module).toBe("game");
    expect(vec.field).toEqual([W, H]);
  });
  it("battery is non-trivial", () => {
    const total =
      vec.setup.length +
      vec.single_shot.length +
      vec.splash_kill.length +
      vec.round_end_win.length +
      vec.play_order.length +
      vec.mirv_split.length +
      vec.ai_buys.length +
      vec.round_cycle.length +
      vec.sync_volley.length +
      vec.sim_live.length;
    expect(total).toBeGreaterThan(40);
  });
});

// ---------------------------------------------------------------------------
// Scenario 1: add_player x N + new_game (placement + terrain seed + reset).
// ---------------------------------------------------------------------------
describe("game: setup (add_player + new_game placement/firing-order/reset)", () => {
  const ROSTERS: Player[][] = [
    [
      ["A", C.AI_HUMAN, 0, 0],
      ["B", C.AI_HUMAN, 0, 0],
    ],
    [
      ["A", C.AI_HUMAN, 0, 0],
      ["B", C.AI_HUMAN, 0, 0],
      ["C", C.AI_HUMAN, 0, 0],
      ["D", C.AI_HUMAN, 0, 0],
    ],
  ];
  for (let ci = 0; ci < vec.setup.length; ci++) {
    const c = vec.setup[ci];
    it(`seed=${c.seed} roster=${c.roster}`, () => {
      const cfg = makeCfg({
        MAXROUNDS: 10,
        INITIAL_CASH: 0,
        MAX_WIND: 200,
        FALLING_TANKS: "ON",
      });
      const gs = build(cfg, c.seed, ROSTERS[c.roster]);
      gs.new_game();
      const got = snap(gs, "after_new_game");
      expectSnap(got, c.steps[0], `setup#${ci}`);
      // firing order + colors + slot-0 inventory
      expect(gs.firing_order, `setup#${ci} firing_order`).toEqual(c.extra.firing_order);
      expect(
        gs.tanks.map((t) => t.color),
        `setup#${ci} colors`,
      ).toEqual(c.extra.colors);
      expect(
        gs.tanks.map((t) => t.inventory[weapons.SLOT_BABY_MISSILE]),
        `setup#${ci} inv0`,
      ).toEqual(c.extra.inv0);
    });
  }
});

// ---------------------------------------------------------------------------
// Scenario 2: a full single-shot fire -> settle resolution.
// ---------------------------------------------------------------------------
describe("game: single-shot fire -> flight -> detonation -> settle", () => {
  for (let ci = 0; ci < vec.single_shot.length; ci++) {
    const c = vec.single_shot[ci];
    it(`seed=${c.seed}`, () => {
      const cfg = makeCfg({
        MAXROUNDS: 10,
        INITIAL_CASH: 0,
        MAX_WIND: 0,
        FALLING_TANKS: "ON",
        CHANGING_WIND: "OFF",
      });
      const gs = build(cfg, c.seed, [
        ["A", C.AI_HUMAN, 0, 0],
        ["B", C.AI_HUMAN, 0, 0],
      ]);
      gs.new_game();
      const steps: Snap[] = [snap(gs, "round_start")];
      gs.update(DT);
      steps.push(snap(gs, "begin_turn"));
      const shooter = gs.current_shooter!;
      shooter.angle = 50;
      shooter.power = 600;
      shooter.selected_weapon = weapons.SLOT_BABY_MISSILE;
      gs.fire();
      steps.push(snap(gs, "after_fire"));
      drive(gs, DT, 600, steps, new Set([AIM, GAME_OVER, ROUND_END]));
      expect(steps.length, `single_shot#${ci} step count`).toBe(c.steps.length);
      for (let i = 0; i < c.steps.length; i++) {
        expectSnap(steps[i], c.steps[i], `single_shot#${ci}[${i}]`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Scenario 3: a multi-tank splash that kills + scores.
// ---------------------------------------------------------------------------
describe("game: multi-tank splash kill + scoring", () => {
  for (let ci = 0; ci < vec.splash_kill.length; ci++) {
    const c = vec.splash_kill[ci];
    it(`seed=${c.seed}`, () => {
      const cfg = makeCfg({
        MAXROUNDS: 10,
        INITIAL_CASH: 0,
        MAX_WIND: 0,
        FALLING_TANKS: "OFF",
        CHANGING_WIND: "OFF",
      });
      const gs = build(cfg, c.seed, [
        ["A", C.AI_HUMAN, 0, 0],
        ["B", C.AI_HUMAN, 0, 0],
        ["C", C.AI_HUMAN, 0, 0],
      ]);
      gs.new_game();
      const baseY = gs.tanks[0].y;
      for (let i = 0; i < gs.tanks.length; i++) {
        const t = gs.tanks[i];
        t.x = 300 + i * 14;
        t.y = baseY;
        t.health = 100;
        t.alive = true;
      }
      gs.tanks[0].inventory[weapons.SLOT_BABY_MISSILE] = 99;
      const steps: Snap[] = [snap(gs, "pre_blast")];
      gs.current_shooter = gs.tanks[0];
      gs.current_weapon = weapons.ITEMS[weapons.SLOT_BABY_MISSILE];
      damage.explode(
        gs as unknown as damage.State,
        gs.tanks[1].x,
        gs.tanks[1].y,
        80,
        false,
      );
      steps.push(snap(gs, "after_explode"));
      for (let i = 0; i < c.steps.length; i++) {
        expectSnap(steps[i], c.steps[i], `splash#${ci}[${i}]`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Scenario 4: round-end + win detection (last tank standing).
// ---------------------------------------------------------------------------
describe("game: round-end + win detection", () => {
  for (let ci = 0; ci < vec.round_end_win.length; ci++) {
    const c = vec.round_end_win[ci];
    it(`seed=${c.seed}`, () => {
      const cfg = makeCfg({
        MAXROUNDS: 1,
        INITIAL_CASH: 0,
        MAX_WIND: 0,
        FALLING_TANKS: "OFF",
        CHANGING_WIND: "OFF",
        SCORING: "STANDARD",
      });
      const gs = build(cfg, c.seed, [
        ["A", C.AI_HUMAN, 0, 0],
        ["B", C.AI_HUMAN, 0, 0],
      ]);
      gs.new_game();
      const steps: Snap[] = [snap(gs, "round_start")];
      gs.current_shooter = null;
      damage.kill_tank(gs as unknown as damage.State, gs.tanks[1] as unknown as damage.Tank);
      steps.push(snap(gs, "after_kill"));
      gs.phase = SETTLE;
      gs._settle_done = false;
      drive(gs, DT, 120, steps, new Set([ROUND_END, GAME_OVER]));
      steps.push(snap(gs, "at_round_end"));
      gs.proceed_after_round();
      steps.push(snap(gs, "after_proceed"));
      expect(steps.length, `round_end#${ci} step count`).toBe(c.steps.length);
      for (let i = 0; i < c.steps.length; i++) {
        expectSnap(steps[i], c.steps[i], `round_end#${ci}[${i}]`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Scenario 5: EACH play-order mode (firing order under RANDOM/LOSERS/WINNERS/ROBIN).
// ---------------------------------------------------------------------------
describe("game: play-order modes (firing order)", () => {
  const TOK: { [k: number]: string } = {
    [C.PLAYORDER_RANDOM]: "RANDOM",
    [C.PLAYORDER_LOSERS]: "LOSERS-FIRST",
    [C.PLAYORDER_WINNERS]: "WINNERS-FIRST",
    [C.PLAYORDER_ROBIN]: "ROUND-ROBIN",
  };
  for (let ci = 0; ci < vec.play_order.length; ci++) {
    const c = vec.play_order[ci];
    it(`seed=${c.seed} order=${TOK[c.play_order]}`, () => {
      const cfg = makeCfg({
        MAXROUNDS: 10,
        INITIAL_CASH: 0,
        MAX_WIND: 0,
        PLAY_ORDER: TOK[c.play_order],
      });
      const gs = build(cfg, c.seed, [
        ["A", C.AI_HUMAN, 0, 0],
        ["B", C.AI_HUMAN, 0, 0],
        ["C", C.AI_HUMAN, 0, 0],
        ["D", C.AI_HUMAN, 0, 0],
      ]);
      gs.new_game();
      const scores = [30, 10, 40, 20];
      for (let i = 0; i < gs.tanks.length; i++) {
        gs.tanks[i].score = scores[i];
      }
      const orders: number[][] = [];
      for (let ri = 0; ri < 3; ri++) {
        gs.round_index = ri;
        gs._build_firing_order();
        orders.push(gs.firing_order.slice());
      }
      expect(orders, `play_order#${ci}`).toEqual(c.orders);
    });
  }
});

// ---------------------------------------------------------------------------
// Scenario 6: a MIRV/cluster split (apogee child spawn + kinematics).
// ---------------------------------------------------------------------------
describe("game: MIRV apogee split (child warheads)", () => {
  for (let ci = 0; ci < vec.mirv_split.length; ci++) {
    const c = vec.mirv_split[ci];
    it(`seed=${c.seed}`, () => {
      const cfg = makeCfg({
        MAXROUNDS: 10,
        INITIAL_CASH: 0,
        MAX_WIND: 0,
        FALLING_TANKS: "OFF",
        CHANGING_WIND: "OFF",
      });
      const gs = build(cfg, c.seed, [
        ["A", C.AI_HUMAN, 0, 0],
        ["B", C.AI_HUMAN, 0, 0],
      ]);
      gs.new_game();
      gs.update(DT);
      const shooter = gs.current_shooter!;
      shooter.inventory[6] = 5; // MIRV (slot 6)
      shooter.angle = 70;
      shooter.power = 700;
      shooter.selected_weapon = 6;
      gs.fire();
      const steps: Snap[] = [snap(gs, "after_fire")];
      drive(gs, DT, 400, steps, new Set([AIM, SETTLE, ROUND_END, GAME_OVER]));
      expect(steps.length, `mirv#${ci} step count`).toBe(c.steps.length);
      for (let i = 0; i < c.steps.length; i++) {
        expectSnap(steps[i], c.steps[i], `mirv#${ci}[${i}]`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Scenario 7: run_ai_buys for AI tanks (economy + AI purchase rng).
// ---------------------------------------------------------------------------
describe("game: run_ai_buys (AI economy purchases)", () => {
  for (let ci = 0; ci < vec.ai_buys.length; ci++) {
    const c = vec.ai_buys[ci];
    it(`seed=${c.seed}`, () => {
      const cfg = makeCfg({ MAXROUNDS: 10, INITIAL_CASH: 50000, MAX_WIND: 0 });
      const gs = build(cfg, c.seed, [
        ["AI1", C.AI_SHOOTER, 0, 0],
        ["AI2", C.AI_POOLSHARK, 0, 0],
        ["AI3", C.AI_CYBORG, 0, 0],
      ]);
      gs.new_game();
      gs.run_ai_buys();
      for (let i = 0; i < c.rows.length; i++) {
        expect(gs.tanks[i].cash, `ai_buys#${ci} tank${i} cash`).toBe(c.rows[i].cash);
        expect(
          gs.tanks[i].inventory,
          `ai_buys#${ci} tank${i} inventory`,
        ).toEqual(c.rows[i].inventory);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Scenario 8: begin_next_round / proceed_after_round (multi-round cycle).
// ---------------------------------------------------------------------------
describe("game: round cycle (begin_next_round / proceed_after_round)", () => {
  for (let ci = 0; ci < vec.round_cycle.length; ci++) {
    const c = vec.round_cycle[ci];
    it(`seed=${c.seed}`, () => {
      const cfg = makeCfg({
        MAXROUNDS: 2,
        INITIAL_CASH: 0,
        MAX_WIND: 0,
        FALLING_TANKS: "OFF",
        CHANGING_WIND: "OFF",
        SCORING: "STANDARD",
      });
      const gs = build(cfg, c.seed, [
        ["A", C.AI_HUMAN, 0, 0],
        ["B", C.AI_HUMAN, 0, 0],
      ]);
      gs.new_game();
      const steps: Snap[] = [snap(gs, "r1_start")];
      gs.current_shooter = null;
      damage.kill_tank(gs as unknown as damage.State, gs.tanks[1] as unknown as damage.Tank);
      gs._end_round();
      steps.push(snap(gs, "r1_end"));
      gs.proceed_after_round();
      steps.push(snap(gs, "r1_after_proceed"));
      gs.begin_next_round();
      steps.push(snap(gs, "r2_start"));
      gs.current_shooter = null;
      damage.kill_tank(gs as unknown as damage.State, gs.tanks[0] as unknown as damage.Tank);
      gs._end_round();
      steps.push(snap(gs, "r2_end"));
      gs.proceed_after_round();
      steps.push(snap(gs, "r2_after_proceed"));
      expect(steps.length, `round_cycle#${ci} step count`).toBe(c.steps.length);
      for (let i = 0; i < c.steps.length; i++) {
        expectSnap(steps[i], c.steps[i], `round_cycle#${ci}[${i}]`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Scenario 9: SYNCHRONOUS volley loop (collect locks -> fire all -> settle).
// ---------------------------------------------------------------------------
describe("game: SYNCHRONOUS volley loop", () => {
  for (let ci = 0; ci < vec.sync_volley.length; ci++) {
    const c = vec.sync_volley[ci];
    it(`seed=${c.seed}`, () => {
      const cfg = makeCfg({
        MAXROUNDS: 10,
        INITIAL_CASH: 0,
        MAX_WIND: 0,
        FALLING_TANKS: "OFF",
        CHANGING_WIND: "OFF",
        PLAY_MODE: "SYNCHRONOUS",
      });
      const gs = build(cfg, c.seed, [
        ["A", C.AI_HUMAN, 0, 0],
        ["B", C.AI_HUMAN, 0, 0],
      ]);
      gs.new_game();
      const steps: Snap[] = [snap(gs, "sync_start")];
      for (let k = 0; k < 4; k++) {
        const cs = gs.current_shooter;
        if (cs !== null && gs.phase === AIM) {
          cs.angle = 60;
          cs.power = 650;
          cs.selected_weapon = weapons.SLOT_BABY_MISSILE;
          gs.fire();
          steps.push(snap(gs, "lock"));
        }
        gs.update(DT);
        steps.push(snap(gs, "tick"));
        if (
          gs.phase === SYNC_VOLLEY ||
          gs.phase === SETTLE ||
          gs.phase === ROUND_END ||
          gs.phase === GAME_OVER
        ) {
          break;
        }
      }
      drive(gs, DT, 600, steps, new Set([SYNC_AIM, SETTLE, ROUND_END, GAME_OVER]));
      expect(steps.length, `sync#${ci} step count`).toBe(c.steps.length);
      for (let i = 0; i < c.steps.length; i++) {
        expectSnap(steps[i], c.steps[i], `sync#${ci}[${i}]`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Scenario 10: SIMULTANEOUS real-time loop (AI cadence + battery + settle).
// ---------------------------------------------------------------------------
describe("game: SIMULTANEOUS real-time loop", () => {
  for (let ci = 0; ci < vec.sim_live.length; ci++) {
    const c = vec.sim_live[ci];
    it(`seed=${c.seed}`, () => {
      const cfg = makeCfg({
        MAXROUNDS: 10,
        INITIAL_CASH: 0,
        MAX_WIND: 0,
        FALLING_TANKS: "OFF",
        CHANGING_WIND: "OFF",
        PLAY_MODE: "SIMULTANEOUS",
      });
      const gs = build(cfg, c.seed, [
        ["AI1", C.AI_SHOOTER, 0, 0],
        ["AI2", C.AI_SHOOTER, 0, 0],
      ]);
      gs.new_game();
      const steps: Snap[] = [snap(gs, "sim_start")];
      for (let k = 0; k < 60; k++) {
        gs.update(DT);
        steps.push(snap(gs, "frame"));
        if (gs.phase === ROUND_END || gs.phase === GAME_OVER) {
          break;
        }
      }
      expect(steps.length, `sim#${ci} step count`).toBe(c.steps.length);
      for (let i = 0; i < c.steps.length; i++) {
        expectSnap(steps[i], c.steps[i], `sim#${ci}[${i}]`);
      }
    });
  }
});

// keep grng import referenced (createGameState seeds it); prevents an unused-import
// lint and documents that the shared singleton is the seeded source.
void grng;
