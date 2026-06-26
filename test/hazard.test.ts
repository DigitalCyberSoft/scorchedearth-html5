/**
 * Differential gate: TS hazard == scorch/hazard.py (the byte-verified Python
 * oracle).  Golden vectors are produced by oracle/dump_hazard.py and written to
 * oracle/vectors/hazard.json.
 *
 * EPSILON: NONE.  Every hazard output is an integer pixel/index, a boolean
 * cadence/branch decision, a string sky name, or an integer health/shield delta.
 * The module performs NO transcendental math (no sin/cos/pow/sqrt/atan2) -- it
 * draws from the RNG via pick()/chance() (integer draws) and does integer
 * arithmetic with Python floor-division (ported as pyFloorDiv).  So every
 * assertion below is EXACT (toBe); there is no toBeCloseTo in this file by design.
 *
 * The mock factories below mirror EXACTLY the duck-typed objects oracle/
 * dump_hazard.py builds (same field defaults, same construction order), so the TS
 * RNG stream (new Rng(seed)) advances in lockstep with the Python Rng(seed) and
 * the recorded mutations reproduce.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { Rng } from "../src/rng";
import { Terrain } from "../src/terrain";
import * as C from "../src/constants";
import * as hazard from "../src/hazard";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "hazard.json");

// ---------------------------------------------------------------------------
// JSON shape (mirrors dump_hazard.py payload)
// ---------------------------------------------------------------------------
type Pt = [number, number];
type Poly = Pt[];

type TankSnap = {
  health: number;
  shield_hp: number;
  shield_item: number;
  alive: boolean;
};

type Flash = [number, number, [number, number, number], number];

type StrikeRun = {
  case: string;
  return: Poly[] | null;
  active_bolts: { pts: Pt[]; frame: number }[];
  flashes: Flash[];
  live_sky: string | null;
  tanks: TankSnap[];
};

type Vectors = {
  constants: {
    BRANCH_DEPTH_CAP: number;
    BRANCH_RNG_N: number;
    BRANCH_RNG_GT: number;
    STRIKE_CADENCE: [number, number];
    FLICKER_CADENCE: [number, number];
    STRIKE_FLASH_UP: number;
    STRIKE_FLASH_DOWN: number;
    STRIKE_FLASH_RGB: [number, number, number];
    FLICKER_MIN: number;
    FLICKER_RAND: number;
    FLICKER_UP: number;
    FLICKER_DOWN: number;
    FLICKER_GAP: number;
    FLICKER_RGB: [number, number, number];
    LIGHTNING_DAMAGE: number;
    STRIKE_HALF_WIDTH: number;
    CAVERN_CEILING_ROWS: number;
    RANDOM_SKY_POOL: string[];
    HOSTILE_SKIES: string[];
  };
  sky: {
    fixed: { seed: number; skies: (string | null)[]; out: string[] }[];
    random_pick: { seed: number; out: string[] }[];
    hostile: { sky: string | null; out: boolean }[];
  };
  lightning_bolt: {
    runs: {
      seed: number;
      bolts: { x: number; y: number; ty: number; out: Poly[] }[];
    }[];
  };
  bolt_segments: {
    runs: {
      seed: number;
      segs: { w: number; tx: number; ty: number; out: Poly[] }[];
    }[];
  };
  maybe_strike: { seeds: { seed: number; runs: StrikeRun[] }[] };
  thunder_flicker: {
    seeds: { seed: number; runs: { sound: boolean | string; out: Flash[] }[] }[];
  };
  strike_damage: {
    cases: {
      aim_x: number;
      aim_y: number;
      out: (TankSnap & { x: number; y: number; hw: number })[];
    }[];
  };
  bolt_lifecycle: {
    register: { out: { pts: Pt[]; frame: number }[] };
    age_default: { out: number[][] };
    age_custom: { out: number[][] };
    age_empty: { out: number[] };
  };
  cavern_ceiling: {
    cases: {
      w: number;
      h: number;
      live_sky: string | null;
      sky: string | null;
      rows: number;
      grid: number[][];
      fill: number;
      crust: number;
    }[];
  };
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as Vectors;

// ---------------------------------------------------------------------------
// Mock factories -- byte-for-byte the duck-typed objects dump_hazard.py builds.
// ---------------------------------------------------------------------------
class MockCfg {
  SKY: string | null;
  _sound: boolean;
  _hostile: boolean;
  scoring: number;
  team_mode: number;
  constructor(opts: {
    sky?: string | null;
    sound?: boolean;
    hostile_env?: boolean;
    scoring?: number;
    team_mode?: number;
  } = {}) {
    this.SKY = opts.sky ?? null;
    this._sound = opts.sound ?? false;
    this._hostile = opts.hostile_env ?? false;
    this.scoring = opts.scoring ?? C.SCORING_BASIC;
    this.team_mode = opts.team_mode ?? C.TEAM_NONE;
  }
  is_on(key: string): boolean {
    if (key === "SOUND") return this._sound;
    if (key === "HOSTILE_ENVIRONMENT") return this._hostile;
    return false;
  }
}

type MockTank = {
  x: number;
  y: number;
  half_width: number;
  health: number;
  shield_hp: number;
  shield_item: number;
  alive: boolean;
  player_index: number;
  hits_this_round: { [k: number]: number };
  hits_career: { [k: number]: number };
  score: number;
  cash: number;
  team_id: number;
};

function makeTank(
  x: number,
  y: number,
  opts: {
    half_width?: number;
    health?: number;
    shield_hp?: number;
    shield_item?: number;
    alive?: boolean;
    player_index?: number;
  } = {}
): MockTank {
  return {
    x,
    y,
    half_width: opts.half_width ?? 10,
    health: opts.health ?? 100,
    shield_hp: opts.shield_hp ?? 0,
    shield_item: opts.shield_item ?? 0,
    alive: opts.alive ?? true,
    player_index: opts.player_index ?? 0,
    hits_this_round: {},
    hits_career: {},
    score: 0,
    cash: 0,
    team_id: 0,
  };
}

type MockState = hazard.State & {
  flashes: Flash[];
  current_shooter: null;
  current_weapon: null;
  on_tank_destroyed: (v: unknown, w: unknown) => void;
};

function makeState(opts: {
  w?: number;
  h?: number;
  seed?: number;
  sky?: string | null;
  sound?: boolean;
  hostile_env?: boolean;
  scoring?: number;
  tanks?: MockTank[];
  live_sky?: string | null;
  with_flash?: boolean;
  with_terrain?: boolean;
} = {}): MockState {
  const w = opts.w ?? 1024;
  const h = opts.h ?? 768;
  const with_flash = opts.with_flash ?? true;
  const with_terrain = opts.with_terrain ?? true;
  const flashes: Flash[] = [];
  // `terrain` is attached conditionally below (with_terrain), so the literal omits
  // it; route through `unknown` to assert MockState exactly as damage.ts does for
  // its duck-typed state crossings (hazard.State.terrain is required, the mock
  // supplies it only on the paths that read it: bolt geometry needs no terrain).
  const state: MockState = {
    w,
    h,
    rng: new Rng(opts.seed ?? 0),
    cfg: new MockCfg({
      sky: opts.sky ?? null,
      sound: opts.sound ?? false,
      hostile_env: opts.hostile_env ?? false,
      scoring: opts.scoring ?? C.SCORING_BASIC,
    }),
    tanks: (opts.tanks ?? []) as unknown as hazard.Tank[],
    live_sky: opts.live_sky ?? null,
    active_bolts: [],
    flashes,
    current_shooter: null,
    current_weapon: null,
    on_tank_destroyed: () => {
      /* no-op recorder, matches the Python mock */
    },
  } as unknown as MockState;
  if (with_terrain) {
    state.terrain = new Terrain(w, h);
  }
  if (with_flash) {
    state.add_flash = (
      up: number,
      down: number,
      rgb: [number, number, number],
      delay = 0
    ) => {
      flashes.push([up, down, [rgb[0], rgb[1], rgb[2]], delay]);
    };
  }
  return state;
}

function snapshotStrike(st: MockState, ret: Poly[] | null): StrikeRun {
  return {
    case: "",
    return: ret === null ? null : ret.map((p) => p.map((q) => [q[0], q[1]] as Pt)),
    active_bolts: (st.active_bolts ?? []).map((e) => ({
      pts: e.pts.map((q) => [q[0], q[1]] as Pt),
      frame: e.frame,
    })),
    flashes: st.flashes.map((f) => [f[0], f[1], [f[2][0], f[2][1], f[2][2]], f[3]] as Flash),
    live_sky: st.live_sky ?? null,
    tanks: (st.tanks as unknown as MockTank[]).map((t) => ({
      health: t.health,
      shield_hp: t.shield_hp,
      shield_item: t.shield_item,
      alive: t.alive,
    })),
  };
}

// ===========================================================================
// constants -- the byte-exact tuning values
// ===========================================================================
describe("hazard: tuning constants", () => {
  const k = vec.constants;
  it("scalar constants match the oracle", () => {
    expect(hazard.BRANCH_DEPTH_CAP).toBe(k.BRANCH_DEPTH_CAP);
    expect(hazard.BRANCH_RNG_N).toBe(k.BRANCH_RNG_N);
    expect(hazard.BRANCH_RNG_GT).toBe(k.BRANCH_RNG_GT);
    expect(hazard.STRIKE_FLASH_UP).toBe(k.STRIKE_FLASH_UP);
    expect(hazard.STRIKE_FLASH_DOWN).toBe(k.STRIKE_FLASH_DOWN);
    expect(hazard.FLICKER_MIN).toBe(k.FLICKER_MIN);
    expect(hazard.FLICKER_RAND).toBe(k.FLICKER_RAND);
    expect(hazard.FLICKER_UP).toBe(k.FLICKER_UP);
    expect(hazard.FLICKER_DOWN).toBe(k.FLICKER_DOWN);
    expect(hazard.FLICKER_GAP).toBe(k.FLICKER_GAP);
    expect(hazard.LIGHTNING_DAMAGE).toBe(k.LIGHTNING_DAMAGE);
    expect(hazard.STRIKE_HALF_WIDTH).toBe(k.STRIKE_HALF_WIDTH);
    expect(hazard.CAVERN_CEILING_ROWS).toBe(k.CAVERN_CEILING_ROWS);
  });
  it("tuple/array constants match the oracle", () => {
    expect(hazard.STRIKE_CADENCE).toEqual(k.STRIKE_CADENCE);
    expect(hazard.FLICKER_CADENCE).toEqual(k.FLICKER_CADENCE);
    expect(hazard.STRIKE_FLASH_RGB).toEqual(k.STRIKE_FLASH_RGB);
    expect(hazard.FLICKER_RGB).toEqual(k.FLICKER_RGB);
    expect([...hazard._RANDOM_SKY_POOL]).toEqual(k.RANDOM_SKY_POOL);
    expect([...hazard.HOSTILE_SKIES]).toEqual(k.HOSTILE_SKIES);
  });
});

// ===========================================================================
// resolve_round_sky / is_hostile
// ===========================================================================
describe("hazard: resolve_round_sky (fixed skies)", () => {
  for (const { seed, skies, out } of vec.sky.fixed) {
    it(`seed ${seed}: ${skies.length} fixed-sky resolutions match`, () => {
      const r = new Rng(seed);
      for (let i = 0; i < skies.length; i++) {
        const cfg = { SKY: skies[i], is_on: () => false };
        expect(hazard.resolve_round_sky(cfg, r), `sky=${skies[i]}`).toBe(out[i]);
      }
    });
  }
});

describe("hazard: resolve_round_sky (RANDOM pool pick)", () => {
  for (const { seed, out } of vec.sky.random_pick) {
    it(`seed ${seed}: ${out.length} RANDOM picks match the pool stream`, () => {
      const r = new Rng(seed);
      const cfg = { SKY: "RANDOM", is_on: () => false };
      for (let i = 0; i < out.length; i++) {
        expect(hazard.resolve_round_sky(cfg, r), `pick #${i} seed ${seed}`).toBe(out[i]);
      }
    });
  }
});

describe("hazard: is_hostile", () => {
  it(`${vec.sky.hostile.length} sky-name classifications match`, () => {
    for (const { sky, out } of vec.sky.hostile) {
      expect(hazard.is_hostile(sky), `is_hostile(${sky})`).toBe(out);
    }
  });
});

// ===========================================================================
// lightning_bolt -- the recursive fractal core (integer polylines, exact)
// ===========================================================================
describe("hazard: lightning_bolt (recursive bolt geometry)", () => {
  for (const { seed, bolts } of vec.lightning_bolt.runs) {
    it(`seed ${seed}: ${bolts.length} bolt geometries match exactly`, () => {
      for (const { x, y, ty, out } of bolts) {
        const r = new Rng(seed);
        const got = hazard.lightning_bolt(x, y, ty, r);
        const tag = `bolt(${x},${y}->${ty}) seed ${seed}`;
        expect(got.length, `${tag} polyline count`).toBe(out.length);
        for (let p = 0; p < out.length; p++) {
          expect(got[p].length, `${tag} poly ${p} length`).toBe(out[p].length);
          for (let q = 0; q < out[p].length; q++) {
            expect(got[p][q][0], `${tag} poly ${p} pt ${q} x`).toBe(out[p][q][0]);
            expect(got[p][q][1], `${tag} poly ${p} pt ${q} y`).toBe(out[p][q][1]);
          }
        }
      }
    });
  }
});

// ===========================================================================
// bolt_segments -- origin jitter + clamp, then lightning_bolt
// ===========================================================================
describe("hazard: bolt_segments (aimed strike origin + bolt)", () => {
  for (const { seed, segs } of vec.bolt_segments.runs) {
    it(`seed ${seed}: ${segs.length} aimed bolts match exactly`, () => {
      for (const { w, tx, ty, out } of segs) {
        const st = makeState({ w, seed, with_flash: false, with_terrain: false });
        const got = hazard.bolt_segments(st, tx, ty);
        const tag = `seg(w=${w},aim ${tx},${ty}) seed ${seed}`;
        expect(got.length, `${tag} polyline count`).toBe(out.length);
        for (let p = 0; p < out.length; p++) {
          expect(got[p].length, `${tag} poly ${p} length`).toBe(out[p].length);
          for (let q = 0; q < out[p].length; q++) {
            expect(got[p][q][0], `${tag} poly ${p} pt ${q} x`).toBe(out[p][q][0]);
            expect(got[p][q][1], `${tag} poly ${p} pt ${q} y`).toBe(out[p][q][1]);
          }
        }
      }
    });
  }
});

// ===========================================================================
// maybe_strike -- the full per-turn hook (return + every mutation)
// Rebuild the EXACT same states (same order) the dumper used so the RNG aligns.
// ===========================================================================
function buildStrikeState(seed: number, caseName: string): MockState {
  switch (caseName) {
    case "plain":
      return makeState({ seed, sky: "PLAIN" });
    case "random":
      return makeState({ seed, sky: "RANDOM" });
    case "stormy_no_tanks":
      return makeState({ seed, live_sky: "STORMY", tanks: [] });
    case "stormy_env_off":
      return makeState({
        seed,
        live_sky: "STORMY",
        hostile_env: false,
        tanks: [
          makeTank(200, 400),
          makeTank(500, 350, { shield_hp: 0 }),
          makeTank(800, 420, { half_width: 14 }),
        ],
      });
    case "stormy_env_on":
      return makeState({
        seed,
        live_sky: "STORMY",
        hostile_env: true,
        tanks: [
          makeTank(200, 400, { health: 100, shield_hp: 0 }),
          makeTank(205, 402, { health: 80, shield_hp: 25, shield_item: 3 }),
          makeTank(800, 420, { health: 100 }),
        ],
      });
    case "stormy_kill":
      return makeState({
        seed,
        live_sky: "STORMY",
        hostile_env: true,
        tanks: [
          makeTank(300, 300, { health: 5 }),
          makeTank(303, 305, { health: 3 }),
          makeTank(900, 500, { health: 100 }),
        ],
      });
    case "stormy_sound":
      return makeState({
        seed,
        live_sky: "STORMY",
        hostile_env: true,
        sound: true,
        tanks: [makeTank(640, 480, { health: 50 })],
      });
    default:
      throw new Error(`unknown maybe_strike case ${caseName}`);
  }
}

describe("hazard: maybe_strike (per-turn weather hook)", () => {
  for (const { seed, runs } of vec.maybe_strike.seeds) {
    it(`seed ${seed}: ${runs.length} strike scenarios reproduce every mutation`, () => {
      for (const expected of runs) {
        const st = buildStrikeState(seed, expected.case);
        const ret = hazard.maybe_strike(st);
        const got = snapshotStrike(st, ret);
        const tag = `${expected.case} seed ${seed}`;

        // live_sky resolution (string, exact)
        expect(got.live_sky, `${tag} live_sky`).toBe(expected.live_sky);

        // return: None vs the exact bolt polylines
        if (expected.return === null) {
          expect(ret, `${tag} return is null`).toBeNull();
        } else {
          expect(got.return, `${tag} return not null`).not.toBeNull();
          expect(got.return!.length, `${tag} return poly count`).toBe(expected.return.length);
          for (let p = 0; p < expected.return.length; p++) {
            expect(got.return![p].length, `${tag} ret poly ${p} len`).toBe(expected.return[p].length);
            for (let q = 0; q < expected.return[p].length; q++) {
              expect(got.return![p][q][0], `${tag} ret poly ${p} pt ${q} x`).toBe(expected.return[p][q][0]);
              expect(got.return![p][q][1], `${tag} ret poly ${p} pt ${q} y`).toBe(expected.return[p][q][1]);
            }
          }
        }

        // active_bolts queued (pts + frame, exact integers)
        expect(got.active_bolts.length, `${tag} active_bolts count`).toBe(expected.active_bolts.length);
        for (let b = 0; b < expected.active_bolts.length; b++) {
          expect(got.active_bolts[b].frame, `${tag} bolt ${b} frame`).toBe(expected.active_bolts[b].frame);
          expect(got.active_bolts[b].pts.length, `${tag} bolt ${b} pts len`).toBe(expected.active_bolts[b].pts.length);
          for (let q = 0; q < expected.active_bolts[b].pts.length; q++) {
            expect(got.active_bolts[b].pts[q][0], `${tag} bolt ${b} pt ${q} x`).toBe(expected.active_bolts[b].pts[q][0]);
            expect(got.active_bolts[b].pts[q][1], `${tag} bolt ${b} pt ${q} y`).toBe(expected.active_bolts[b].pts[q][1]);
          }
        }

        // queued flashes (up, down, rgb, delay -- all integers)
        expect(got.flashes.length, `${tag} flash count`).toBe(expected.flashes.length);
        for (let f = 0; f < expected.flashes.length; f++) {
          expect(got.flashes[f][0], `${tag} flash ${f} up`).toBe(expected.flashes[f][0]);
          expect(got.flashes[f][1], `${tag} flash ${f} down`).toBe(expected.flashes[f][1]);
          expect(got.flashes[f][2], `${tag} flash ${f} rgb`).toEqual(expected.flashes[f][2]);
          expect(got.flashes[f][3], `${tag} flash ${f} delay`).toBe(expected.flashes[f][3]);
        }

        // per-tank health/shield/alive after the strike (integers/bool)
        expect(got.tanks.length, `${tag} tank count`).toBe(expected.tanks.length);
        for (let t = 0; t < expected.tanks.length; t++) {
          expect(got.tanks[t].health, `${tag} tank ${t} health`).toBe(expected.tanks[t].health);
          expect(got.tanks[t].shield_hp, `${tag} tank ${t} shield_hp`).toBe(expected.tanks[t].shield_hp);
          expect(got.tanks[t].shield_item, `${tag} tank ${t} shield_item`).toBe(expected.tanks[t].shield_item);
          expect(got.tanks[t].alive, `${tag} tank ${t} alive`).toBe(expected.tanks[t].alive);
        }
      }
    });
  }
});

// ===========================================================================
// _thunder_flicker -- standalone flash burst
// ===========================================================================
describe("hazard: _thunder_flicker (sky flash burst)", () => {
  for (const { seed, runs } of vec.thunder_flicker.seeds) {
    it(`seed ${seed}: ${runs.length} flicker bursts match`, () => {
      for (const { sound, out } of runs) {
        let st: MockState;
        if (sound === "no_add_flash") {
          st = makeState({ seed, with_flash: false });
        } else {
          st = makeState({ seed, sound: sound as boolean });
        }
        hazard._thunder_flicker(st);
        const tag = `flicker sound=${sound} seed ${seed}`;
        expect(st.flashes.length, `${tag} flash count`).toBe(out.length);
        for (let f = 0; f < out.length; f++) {
          expect(st.flashes[f][0], `${tag} flash ${f} up`).toBe(out[f][0]);
          expect(st.flashes[f][1], `${tag} flash ${f} down`).toBe(out[f][1]);
          expect(st.flashes[f][2], `${tag} flash ${f} rgb`).toEqual(out[f][2]);
          expect(st.flashes[f][3], `${tag} flash ${f} delay`).toBe(out[f][3]);
        }
      }
    });
  }
});

// ===========================================================================
// _strike_damage -- column-hit selection + shield/health deltas
// ===========================================================================
function makeStrikeDamageTanks(): MockTank[] {
  return [
    makeTank(100, 200, { half_width: 10, health: 100 }),
    makeTank(116, 200, { half_width: 10, health: 100 }),
    makeTank(117, 200, { half_width: 10, health: 100 }),
    makeTank(100, 200, { half_width: 14, health: 100 }),
    makeTank(100, 100, { half_width: 10, health: 100 }),
    makeTank(100, 200, { half_width: 10, health: 100, shield_hp: 5, shield_item: 2 }),
    makeTank(100, 200, { half_width: 10, health: 100, shield_hp: 50, shield_item: 2 }),
    makeTank(100, 200, { half_width: 10, health: 100, alive: false }),
    makeTank(100, 200, { half_width: 10, health: 8 }),
  ];
}

describe("hazard: _strike_damage (column selection + damage)", () => {
  for (let ci = 0; ci < vec.strike_damage.cases.length; ci++) {
    const c = vec.strike_damage.cases[ci];
    it(`aim (${c.aim_x},${c.aim_y}): ${c.out.length} tanks resolve correctly`, () => {
      const st = makeState({ seed: ci, hostile_env: true, tanks: makeStrikeDamageTanks() });
      hazard._strike_damage(st, c.aim_x, c.aim_y);
      const tanks = st.tanks as unknown as MockTank[];
      for (let t = 0; t < c.out.length; t++) {
        const tag = `aim (${c.aim_x},${c.aim_y}) tank ${t}`;
        expect(tanks[t].x, `${tag} x`).toBe(c.out[t].x);
        expect(tanks[t].y, `${tag} y`).toBe(c.out[t].y);
        expect(tanks[t].half_width, `${tag} hw`).toBe(c.out[t].hw);
        expect(tanks[t].health, `${tag} health`).toBe(c.out[t].health);
        expect(tanks[t].shield_hp, `${tag} shield_hp`).toBe(c.out[t].shield_hp);
        expect(tanks[t].shield_item, `${tag} shield_item`).toBe(c.out[t].shield_item);
        expect(tanks[t].alive, `${tag} alive`).toBe(c.out[t].alive);
      }
    });
  }
});

// ===========================================================================
// _register_bolt / age_bolts -- visual queue management
// ===========================================================================
describe("hazard: _register_bolt (queue polylines of len>=2)", () => {
  it("registers only >=2-point polylines, frame 0", () => {
    const sampleBolt: Poly[] = [
      [
        [10, 0],
        [12, 12],
        [9, 24],
      ],
      [[50, 60]],
      [
        [7, 7],
        [8, 9],
      ],
      [],
    ];
    const st = makeState({ seed: 0, with_flash: false, with_terrain: false });
    hazard._register_bolt(st, sampleBolt);
    const out = vec.bolt_lifecycle.register.out;
    const ab = st.active_bolts!;
    expect(ab.length).toBe(out.length);
    for (let b = 0; b < out.length; b++) {
      expect(ab[b].frame, `reg bolt ${b} frame`).toBe(out[b].frame);
      expect(ab[b].pts.length, `reg bolt ${b} pts len`).toBe(out[b].pts.length);
      for (let q = 0; q < out[b].pts.length; q++) {
        expect(ab[b].pts[q][0], `reg bolt ${b} pt ${q} x`).toBe(out[b].pts[q][0]);
        expect(ab[b].pts[q][1], `reg bolt ${b} pt ${q} y`).toBe(out[b].pts[q][1]);
      }
    }
  });
});

describe("hazard: age_bolts (frame advance + expiry)", () => {
  function freshState(): MockState {
    const st = makeState({ seed: 0, with_flash: false, with_terrain: false });
    st.active_bolts = [
      { pts: [[0, 0], [1, 1]], frame: 0 },
      { pts: [[2, 2], [3, 3]], frame: 3 },
      { pts: [[4, 4], [5, 5]], frame: 6 },
    ];
    return st;
  }

  it("default max_frames=6: frames advance and expire over 10 ticks", () => {
    const out = vec.bolt_lifecycle.age_default.out;
    const st = freshState();
    for (let tick = 0; tick < out.length; tick++) {
      hazard.age_bolts(st);
      const frames = (st.active_bolts ?? []).map((b) => b.frame);
      expect(frames, `age default tick ${tick}`).toEqual(out[tick]);
    }
  });

  it("custom max_frames=2: frames advance and expire over 5 ticks", () => {
    const out = vec.bolt_lifecycle.age_custom.out;
    const st = freshState();
    for (let tick = 0; tick < out.length; tick++) {
      hazard.age_bolts(st, 2);
      const frames = (st.active_bolts ?? []).map((b) => b.frame);
      expect(frames, `age custom tick ${tick}`).toEqual(out[tick]);
    }
  });

  it("empty active_bolts: no-op", () => {
    const st = makeState({ seed: 0, with_flash: false, with_terrain: false });
    st.active_bolts = [];
    hazard.age_bolts(st);
    expect(st.active_bolts.length).toBe(vec.bolt_lifecycle.age_empty.out[0]);
  });
});

// ===========================================================================
// install_cavern_ceiling -- terrain top-band stamp
// ===========================================================================
describe("hazard: install_cavern_ceiling (terrain ceiling stamp)", () => {
  for (let ci = 0; ci < vec.cavern_ceiling.cases.length; ci++) {
    const c = vec.cavern_ceiling.cases[ci];
    it(`w=${c.w} h=${c.h} sky=${c.live_sky ?? c.sky}: rows + grid match`, () => {
      const st = makeState({
        w: c.w,
        h: c.h,
        seed: ci,
        sky: c.sky,
        live_sky: c.live_sky,
        with_flash: false,
      });
      const rows = hazard.install_cavern_ceiling(st);
      expect(rows, `case ${ci} rows`).toBe(c.rows);
      // grid must equal the Python numpy plane column-for-column, byte-for-byte.
      const t = st.terrain!;
      expect(t.w, `case ${ci} col count`).toBe(c.grid.length);
      for (let x = 0; x < c.grid.length; x++) {
        expect(t.h, `case ${ci} col ${x} len`).toBe(c.grid[x].length);
        for (let y = 0; y < c.grid[x].length; y++) {
          expect(t.read(x, y), `case ${ci} grid[${x}][${y}]`).toBe(c.grid[x][y]);
        }
      }
    });
  }
});
