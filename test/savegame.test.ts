/**
 * Differential gate: TS savegame == Python scorch/savegame.py, byte-for-byte.
 *
 * Golden vectors are produced by oracle/dump_savegame.py from the Python port and
 * written to oracle/vectors/savegame.json. The dumper drives the REAL
 * savegame.save / serialize / apply over a battery of GameStates and records:
 *   - bytes:        the EXACT blob bytes (header + UTF-8 JSON body) save() wrote;
 *   - roundtrip:    the field-level snapshot apply() restored from each blob;
 *   - guards:       short / bad-magic / bad-version / corrupt-body fixtures + the
 *                   verbatim SaveError guard messages;
 *   - consts:       MAGIC bytes, SAVE_VERSION, HEADER_LEN, NUM_ITEMS;
 *   - nonascending: a hit-map case with NON-ascending insertion order (documents
 *                   the JS-vs-CPython key-order divergence; round-trip only).
 *
 * EPSILON POLICY: there is NO transcendental math in this module. Every serialized
 * leaf is an integer, a boolean, a string, a base64 string, or an
 * exactly-representable-from-JSON float (the cfg floats / economy EMAs are parsed
 * back from the recorded JSON as the identical IEEE-754 doubles). So every
 * assertion is EXACT: byte arrays compared element-by-element (toEqual on a
 * number[]), strings/ints/bools via toBe/toEqual. No toBeCloseTo anywhere -- and
 * none is warranted, because the float bytes are reproduced via pyFloatRepr, which
 * was cross-checked byte-for-byte against CPython's json float output.
 *
 * INT-KEYED DICT ORDER (documented divergence): hits_this_round / hits_career are
 * Python dicts preserving INSERTION order; the TS data model (plain JS objects,
 * per damage.ts) forces ASCENDING integer-key order. The byte battery is built by
 * the oracle with ascending insertion order (the order the TS port actually
 * holds), so byte-identity holds over the achievable state space. The
 * `nonascending` case asserts only that the RESTORED VALUES match (order-
 * independent); its serialized byte order differs by JS semantics, which the test
 * asserts explicitly so the divergence is pinned, not hidden.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  save,
  load,
  serialize,
  apply,
  SaveError,
  MAGIC,
  MAGIC_BYTES,
  SAVE_VERSION,
  encodeString,
  pyFloatRepr,
  b64encode,
  b64decode,
  type SaveGameState,
  type SaveTank,
  type SaveEconomy,
  type SaveConfig,
  type SaveTankData,
} from "../src/savegame";
import { CONFIG_FIELDS } from "../src/config";
import { NUM_ITEMS } from "../src/weapons";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "savegame.json");

// ---------------------------------------------------------------------------
// Vector shape
// ---------------------------------------------------------------------------
type TankSnap = {
  player_index: number;
  name: string;
  ai_class: number;
  reveal_type: number;
  team_id: number;
  color: number;
  tank_icon: number;
  mobile: boolean;
  x: number;
  y: number;
  half_width: number;
  angle: number;
  power: number;
  health: number;
  alive: boolean;
  shield_hp: number;
  shield_item: number;
  shield_push: boolean;
  shield_deflect: boolean;
  shield_laserproof: boolean;
  shield_failproof: boolean;
  parachute_deployed: boolean;
  parachute_threshold: number;
  chute_up: number;
  contact_trigger: boolean;
  selected_guidance: unknown;
  guidance_target_index: number | null;
  guidance_target_pt: [number, number] | null;
  cash: number;
  cash_ceiling: number;
  inventory: number[];
  selected_weapon: number;
  fuel_remainder: number;
  score: number;
  win_counter: number;
  hits_this_round: [number, number][]; // sorted pairs
  hits_career: [number, number][];
  fall_accum: number;
  falling: boolean;
  ai_tries: number;
  sim_keys: number[];
};

type StateSnap = {
  round_index: number;
  phase: string;
  timer: number;
  message: string;
  fire_index: number;
  firing_order: number[];
  current_shooter_index: number | null;
  last_landing: [number, number] | null;
  winner_index: number | null;
  ranking_indices: number[];
  w: number;
  h: number;
  cfg: { [k: string]: number | string };
  _wind: number;
  _live_elastic: number;
  tanks: TankSnap[];
  economy: {
    price: number[];
    demand_tally: number[];
    nobuy: number[];
    demand_ema: number[];
    ratio_ema: number[];
    available: boolean[];
  };
  terrain: { w: number; h: number; hex: string };
};

type Vectors = {
  module: string;
  consts: { MAGIC: number[]; SAVE_VERSION: number; HEADER_LEN: number; NUM_ITEMS: number };
  // presave: snapshot of the PRE-save state (re-serializes to the same bytes).
  bytes: { name: string; blob_hex: string; presave: StateSnap }[];
  roundtrip: { name: string; restored: StateSnap }[];
  guards: {
    good_hex: string;
    short_hex: string;
    bad_magic_hex: string;
    bad_version_hex: string;
    corrupt_body_hex: string;
    msg_not_saved: string;
    msg_diff_version: string;
    msg_corrupt: string;
  };
  nonascending: { blob_hex: string; py_body: string; restored: StateSnap };
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as Vectors;

// ---------------------------------------------------------------------------
// Helpers: hex <-> bytes, snapshot -> structural host
// ---------------------------------------------------------------------------
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToArray(b: Uint8Array): number[] {
  return Array.from(b);
}

const CFG_TYPE: { [k: string]: string } = {};
for (const fld of CONFIG_FIELDS) CFG_TYPE[fld.name] = fld.type;

/** Build a SaveConfig from a snapshot cfg dict + the two live globals. */
function mkConfig(cfgDict: { [k: string]: number | string }, wind: number, le: number): SaveConfig {
  const cfg = {} as SaveConfig;
  for (const fld of CONFIG_FIELDS) {
    cfg[fld.name] = cfgDict[fld.name];
  }
  cfg.wind = wind;
  cfg.live_elastic = le;
  return cfg;
}

function pairsToMap(pairs: [number, number][]): { [k: number]: number } {
  const m: { [k: number]: number } = {};
  for (const [k, v] of pairs) m[k] = v;
  return m;
}

/** Build a tank host from a snapshot, resolving guidance_target later. */
function mkTank(s: TankSnap): SaveTank {
  return {
    player_index: s.player_index,
    name: s.name,
    ai_class: s.ai_class,
    reveal_type: s.reveal_type,
    team_id: s.team_id,
    color: s.color,
    tank_icon: s.tank_icon,
    mobile: s.mobile,
    x: s.x,
    y: s.y,
    half_width: s.half_width,
    angle: s.angle,
    power: s.power,
    health: s.health,
    alive: s.alive,
    shield_hp: s.shield_hp,
    shield_item: s.shield_item,
    shield_push: s.shield_push,
    shield_deflect: s.shield_deflect,
    shield_laserproof: s.shield_laserproof,
    shield_failproof: s.shield_failproof,
    parachute_deployed: s.parachute_deployed,
    parachute_threshold: s.parachute_threshold,
    chute_up: s.chute_up,
    contact_trigger: s.contact_trigger,
    selected_guidance: s.selected_guidance ?? null,
    guidance_target: null, // resolved in mkState
    guidance_target_pt: s.guidance_target_pt,
    cash: s.cash,
    cash_ceiling: s.cash_ceiling,
    inventory: s.inventory.slice(),
    selected_weapon: s.selected_weapon,
    fuel_remainder: s.fuel_remainder,
    score: s.score,
    win_counter: s.win_counter,
    hits_this_round: pairsToMap(s.hits_this_round),
    hits_career: pairsToMap(s.hits_career),
    fall_accum: s.fall_accum,
    falling: s.falling,
    ai_tries: s.ai_tries,
    sim_keys: s.sim_keys.slice(),
  };
}

/** Build a full structural GameState host from a state snapshot. The applied
 * snapshot equals the serializable pre-save state (apply(serialize(s)) is a
 * round-trip), so re-serializing this host must reproduce the recorded bytes. */
function mkState(snap: StateSnap): SaveGameState {
  const tanks = snap.tanks.map(mkTank);
  const byIdx: { [i: number]: SaveTank } = {};
  for (const t of tanks) byIdx[t.player_index] = t;
  // resolve guidance_target references from indices
  for (let i = 0; i < tanks.length; i++) {
    const gti = snap.tanks[i].guidance_target_index;
    tanks[i].guidance_target = gti != null ? byIdx[gti] ?? null : null;
  }
  const economy: SaveEconomy = {
    n: NUM_ITEMS,
    price: snap.economy.price.slice(),
    demand_tally: snap.economy.demand_tally.slice(),
    nobuy: snap.economy.nobuy.slice(),
    demand_ema: snap.economy.demand_ema.slice(),
    ratio_ema: snap.economy.ratio_ema.slice(),
    available: snap.economy.available.slice(),
  };
  return {
    round_index: snap.round_index,
    phase: snap.phase,
    timer: snap.timer,
    message: snap.message,
    fire_index: snap.fire_index,
    firing_order: snap.firing_order.slice(),
    current_shooter: snap.current_shooter_index != null ? byIdx[snap.current_shooter_index] : null,
    last_landing: snap.last_landing,
    winner: snap.winner_index != null ? byIdx[snap.winner_index] : null,
    ranking: snap.ranking_indices.map((i) => byIdx[i]),
    w: snap.w,
    h: snap.h,
    cfg: mkConfig(snap.cfg, snap._wind, snap._live_elastic),
    tanks,
    economy,
    terrain: { grid: { w: snap.terrain.w, h: snap.terrain.h, data: hexToBytes(snap.terrain.hex) } },
  };
}

/** A blank host with `count` default tanks, for apply() round-trip targets. */
function mkBlankState(count: number, w: number, h: number): SaveGameState {
  const tanks: SaveTank[] = [];
  for (let i = 0; i < count; i++) {
    tanks.push(
      mkTank({
        player_index: i,
        name: `slot${i}`,
        ai_class: 0,
        reveal_type: -1,
        team_id: 0,
        color: 0,
        tank_icon: 0,
        mobile: true,
        x: 0,
        y: 0,
        half_width: 7,
        angle: 45,
        power: 500,
        health: 100,
        alive: true,
        shield_hp: 0,
        shield_item: 0,
        shield_push: false,
        shield_deflect: false,
        shield_laserproof: false,
        shield_failproof: false,
        parachute_deployed: true,
        parachute_threshold: 5,
        chute_up: 0,
        contact_trigger: false,
        selected_guidance: null,
        guidance_target_index: null,
        guidance_target_pt: null,
        cash: 0,
        cash_ceiling: 0,
        inventory: new Array(NUM_ITEMS).fill(0),
        selected_weapon: 0,
        fuel_remainder: 0,
        score: 0,
        win_counter: 0,
        hits_this_round: [],
        hits_career: [],
        fall_accum: 0,
        falling: false,
        ai_tries: 0,
        sim_keys: [],
      }),
    );
  }
  const economy: SaveEconomy = {
    n: NUM_ITEMS,
    cfg: mkConfig(defaultCfgDict(), 0, 0),
    price: new Array(NUM_ITEMS).fill(0),
    demand_tally: new Array(NUM_ITEMS).fill(0),
    nobuy: new Array(NUM_ITEMS).fill(0),
    demand_ema: new Array(NUM_ITEMS).fill(0.1),
    ratio_ema: new Array(NUM_ITEMS).fill(0.1),
    available: new Array(NUM_ITEMS).fill(true),
  };
  return {
    round_index: 0,
    phase: "place",
    timer: 0,
    message: "",
    fire_index: 0,
    firing_order: [],
    current_shooter: null,
    last_landing: null,
    winner: null,
    ranking: [],
    w,
    h,
    cfg: mkConfig(defaultCfgDict(), 0, 0),
    tanks,
    economy,
    terrain: { grid: { w, h, data: new Uint8Array(w * h) } },
    projectiles: [],
    explosions: [],
    beams: [],
    awaiting_human: false,
  };
}

function defaultCfgDict(): { [k: string]: number | string } {
  // Minimal valid cfg dict (values irrelevant -- apply() overwrites from the
  // save). Use plausible defaults so mkConfig has every key.
  const d: { [k: string]: number | string } = {};
  for (const fld of CONFIG_FIELDS) d[fld.name] = fld.type === "str" ? "" : 0;
  return d;
}

// ---------------------------------------------------------------------------
// Snapshot comparison
// ---------------------------------------------------------------------------
function sortMap(m: { [k: number]: number }): [number, number][] {
  return Object.keys(m)
    .map((k) => Number(k))
    .sort((a, b) => a - b)
    .map((k) => [k, m[k]] as [number, number]);
}

function expectTankRestored(t: SaveTank, s: TankSnap, label: string): void {
  expect(t.player_index, `${label} player_index`).toBe(s.player_index);
  expect(t.name, `${label} name`).toBe(s.name);
  expect(t.ai_class, `${label} ai_class`).toBe(s.ai_class);
  expect(t.reveal_type, `${label} reveal_type`).toBe(s.reveal_type);
  expect(t.team_id, `${label} team_id`).toBe(s.team_id);
  expect(t.color, `${label} color`).toBe(s.color);
  expect(t.tank_icon, `${label} tank_icon`).toBe(s.tank_icon);
  expect(t.mobile, `${label} mobile`).toBe(s.mobile);
  expect(t.x, `${label} x`).toBe(s.x);
  expect(t.y, `${label} y`).toBe(s.y);
  expect(t.half_width, `${label} half_width`).toBe(s.half_width);
  expect(t.angle, `${label} angle`).toBe(s.angle);
  expect(t.power, `${label} power`).toBe(s.power);
  expect(t.health, `${label} health`).toBe(s.health);
  expect(t.alive, `${label} alive`).toBe(s.alive);
  expect(t.shield_hp, `${label} shield_hp`).toBe(s.shield_hp);
  expect(t.shield_item, `${label} shield_item`).toBe(s.shield_item);
  expect(t.shield_push, `${label} shield_push`).toBe(s.shield_push);
  expect(t.shield_deflect, `${label} shield_deflect`).toBe(s.shield_deflect);
  expect(t.shield_laserproof, `${label} shield_laserproof`).toBe(s.shield_laserproof);
  expect(t.shield_failproof, `${label} shield_failproof`).toBe(s.shield_failproof);
  expect(t.parachute_deployed, `${label} parachute_deployed`).toBe(s.parachute_deployed);
  expect(t.parachute_threshold, `${label} parachute_threshold`).toBe(s.parachute_threshold);
  expect(t.chute_up, `${label} chute_up`).toBe(s.chute_up);
  expect(t.contact_trigger, `${label} contact_trigger`).toBe(s.contact_trigger);
  expect(t.selected_guidance ?? null, `${label} selected_guidance`).toBe(s.selected_guidance ?? null);
  const gti = t.guidance_target != null ? t.guidance_target.player_index : null;
  expect(gti, `${label} guidance_target_index`).toBe(s.guidance_target_index);
  expect(t.guidance_target_pt, `${label} guidance_target_pt`).toEqual(s.guidance_target_pt);
  expect(t.cash, `${label} cash`).toBe(s.cash);
  expect(t.cash_ceiling, `${label} cash_ceiling`).toBe(s.cash_ceiling);
  expect(t.inventory, `${label} inventory`).toEqual(s.inventory);
  expect(t.selected_weapon, `${label} selected_weapon`).toBe(s.selected_weapon);
  expect(t.fuel_remainder, `${label} fuel_remainder`).toBe(s.fuel_remainder);
  expect(t.score, `${label} score`).toBe(s.score);
  expect(t.win_counter, `${label} win_counter`).toBe(s.win_counter);
  expect(sortMap(t.hits_this_round), `${label} hits_this_round`).toEqual(s.hits_this_round);
  expect(sortMap(t.hits_career), `${label} hits_career`).toEqual(s.hits_career);
  expect(t.fall_accum, `${label} fall_accum`).toBe(s.fall_accum);
  expect(t.falling, `${label} falling`).toBe(s.falling);
  expect(t.ai_tries, `${label} ai_tries`).toBe(s.ai_tries);
  expect(t.sim_keys ?? [], `${label} sim_keys`).toEqual(s.sim_keys);
}

function expectStateRestored(st: SaveGameState, s: StateSnap, label: string): void {
  expect(st.round_index, `${label} round_index`).toBe(s.round_index);
  expect(st.phase, `${label} phase`).toBe(s.phase);
  expect(st.timer, `${label} timer`).toBe(s.timer);
  expect(st.message, `${label} message`).toBe(s.message);
  expect(st.fire_index, `${label} fire_index`).toBe(s.fire_index);
  expect(st.firing_order, `${label} firing_order`).toEqual(s.firing_order);
  const csi = st.current_shooter != null ? st.current_shooter.player_index : null;
  expect(csi, `${label} current_shooter_index`).toBe(s.current_shooter_index);
  expect(st.last_landing, `${label} last_landing`).toEqual(s.last_landing);
  const wi = st.winner != null ? st.winner.player_index : null;
  expect(wi, `${label} winner_index`).toBe(s.winner_index);
  expect(
    st.ranking.map((t) => t.player_index),
    `${label} ranking_indices`,
  ).toEqual(s.ranking_indices);
  expect(st.w, `${label} w`).toBe(s.w);
  expect(st.h, `${label} h`).toBe(s.h);
  // cfg fields
  for (const fld of CONFIG_FIELDS) {
    expect(
      (st.cfg as { [k: string]: number | string })[fld.name],
      `${label} cfg.${fld.name}`,
    ).toBe(s.cfg[fld.name]);
  }
  expect(st.cfg.wind, `${label} _wind`).toBe(s._wind);
  expect(st.cfg.live_elastic, `${label} _live_elastic`).toBe(s._live_elastic);
  // economy
  expect(st.economy.price, `${label} econ.price`).toEqual(s.economy.price);
  expect(st.economy.demand_tally, `${label} econ.demand_tally`).toEqual(s.economy.demand_tally);
  expect(st.economy.nobuy, `${label} econ.nobuy`).toEqual(s.economy.nobuy);
  expect(st.economy.demand_ema, `${label} econ.demand_ema`).toEqual(s.economy.demand_ema);
  expect(st.economy.ratio_ema, `${label} econ.ratio_ema`).toEqual(s.economy.ratio_ema);
  expect(st.economy.available, `${label} econ.available`).toEqual(s.economy.available);
  // terrain bytes (exact)
  expect(st.terrain.grid.w, `${label} terrain.w`).toBe(s.terrain.w);
  expect(st.terrain.grid.h, `${label} terrain.h`).toBe(s.terrain.h);
  expect(bytesToArray(st.terrain.grid.data), `${label} terrain.data`).toEqual(
    bytesToArray(hexToBytes(s.terrain.hex)),
  );
  // tanks
  expect(st.tanks.length, `${label} tank count`).toBe(s.tanks.length);
  for (let i = 0; i < s.tanks.length; i++) {
    expectTankRestored(st.tanks[i], s.tanks[i], `${label} tank[${i}]`);
  }
}

// ===========================================================================
// Tests
// ===========================================================================
describe("savegame: vector / module sanity", () => {
  it("module tag matches the dumper", () => {
    expect(vec.module).toBe("savegame");
  });
  it("battery is non-trivial (>= 7 byte cases + guards + roundtrips)", () => {
    expect(vec.bytes.length).toBeGreaterThanOrEqual(7);
    expect(vec.roundtrip.length).toBe(vec.bytes.length);
  });
});

describe("savegame: constants agree with the Python module", () => {
  it("MAGIC bytes / SAVE_VERSION / HEADER_LEN / NUM_ITEMS", () => {
    expect(Array.from(MAGIC_BYTES)).toEqual(vec.consts.MAGIC);
    // MAGIC string code points == the byte list (ASCII)
    expect(MAGIC.split("").map((c) => c.charCodeAt(0))).toEqual(vec.consts.MAGIC);
    expect(SAVE_VERSION).toBe(vec.consts.SAVE_VERSION);
    expect(NUM_ITEMS).toBe(vec.consts.NUM_ITEMS);
    expect(vec.consts.HEADER_LEN).toBe(8);
  });
});

describe("savegame: pyFloatRepr == CPython json float (the byte-fidelity primitive)", () => {
  // A focused battery of the exact doubles that flow through serialize().
  const cases: [number, string][] = [
    [0.0, "0.0"],
    [1.0, "1.0"],
    [0.1, "0.1"],
    [0.2, "0.2"],
    [0.05, "0.05"],
    [0.5, "0.5"],
    [20.0, "20.0"],
    [12.5, "12.5"],
    [33.75, "33.75"],
    [9.81, "9.81"],
    [0.123, "0.123"],
    [0.875, "0.875"],
    [0.25, "0.25"],
    [1 / 7, "0.14285714285714285"],
    [0.1 + 0.013, "0.113"],
    [Infinity, "Infinity"],
    [-Infinity, "-Infinity"],
    [NaN, "NaN"],
  ];
  for (const [v, want] of cases) {
    it(`repr(${want})`, () => {
      expect(pyFloatRepr(v)).toBe(want);
    });
  }
  it("-0.0 renders -0.0", () => {
    expect(pyFloatRepr(-0)).toBe("-0.0");
  });
});

describe("savegame: encodeString == CPython json string escaping (ensure_ascii)", () => {
  const cases: [string, string][] = [
    ["hello", '"hello"'],
    ['a"b', '"a\\"b"'],
    ["a\\b", '"a\\\\b"'],
    ["tab\there", '"tab\\there"'],
    ["nl\nx", '"nl\\nx"'],
    ["\b\f\r", '"\\b\\f\\r"'],
    ["ctrl\x01\x1f", '"ctrl\\u0001\\u001f"'],
    ["del\x7f", '"del\\u007f"'],
    ["unié", '"uni\\u00e9"'],
    ["slash/x", '"slash/x"'], // '/' is NOT escaped
    ["☃", '"\\u2603"'],
    ["emoji\u{1f600}", '"emoji\\ud83d\\ude00"'], // surrogate pair
  ];
  for (const [s, want] of cases) {
    it(`escape ${JSON.stringify(s)}`, () => {
      expect(encodeString(s)).toBe(want);
    });
  }
});

describe("savegame: base64 round-trip == Python base64", () => {
  it("length classes + +/ alphabet + padding", () => {
    const samples: number[][] = [
      [],
      [0],
      [0, 0],
      [0, 1, 2],
      [251, 255, 191], // -> '+/+/'
      [255, 255, 255, 255, 255],
      Array.from({ length: 256 }, (_, i) => i),
    ];
    for (const arr of samples) {
      const u = new Uint8Array(arr);
      const enc = b64encode(u);
      // decode reproduces the input
      expect(bytesToArray(b64decode(enc)), `decode(encode) ${arr.length}`).toEqual(arr);
    }
    // known vectors (from Python base64.b64encode)
    expect(b64encode(new Uint8Array([0]))).toBe("AA==");
    expect(b64encode(new Uint8Array([0, 0]))).toBe("AAA=");
    expect(b64encode(new Uint8Array([]))).toBe("");
    expect(b64encode(new Uint8Array([251, 255, 191]))).toBe("+/+/");
    expect(b64encode(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).toBe("AAECAwQFBgc=");
  });
});

describe("savegame: save() byte-stream == Python savegame.save (THE HEART)", () => {
  for (let ci = 0; ci < vec.bytes.length; ci++) {
    const bc = vec.bytes[ci];
    const rc = vec.roundtrip[ci];
    it(`[${bc.name}] bytes identical`, () => {
      expect(bc.name, "byte/roundtrip case alignment").toBe(rc.name);
      // reconstruct the PRE-save state (presave snapshot) -- the round-trip
      // snapshot can differ from it wherever Python apply() is asymmetric with
      // save() (e.g. _live_elastic), so re-serializing presave is what must
      // reproduce the recorded bytes.
      const state = mkState(bc.presave);
      const got = save(state);
      const want = hexToBytes(bc.blob_hex);
      // Compare lengths first for a clear failure, then full bytes.
      expect(got.length, `${bc.name} blob length`).toBe(want.length);
      expect(bytesToArray(got), `${bc.name} blob bytes`).toEqual(bytesToArray(want));
    });
  }
});

describe("savegame: load() + apply() round-trip restores the state exactly", () => {
  for (let ci = 0; ci < vec.bytes.length; ci++) {
    const bc = vec.bytes[ci];
    const rc = vec.roundtrip[ci];
    it(`[${bc.name}] restore`, () => {
      const blob = hexToBytes(bc.blob_hex);
      const data = load(blob);
      const host = mkBlankState(rc.restored.tanks.length, rc.restored.w, rc.restored.h);
      const out = apply(data, host);
      expect(out, "apply returns the host").toBe(host);
      expectStateRestored(out, rc.restored, bc.name);
      // transient collections cleared
      expect(out.projectiles, `${bc.name} projectiles cleared`).toEqual([]);
      expect(out.explosions, `${bc.name} explosions cleared`).toEqual([]);
      expect(out.beams, `${bc.name} beams cleared`).toEqual([]);
      expect(out.awaiting_human, `${bc.name} awaiting_human`).toBe(false);
    });
  }
});

describe("savegame: serialize() round-trips through load()/apply() (no file I/O)", () => {
  for (let ci = 0; ci < vec.roundtrip.length; ci++) {
    const rc = vec.roundtrip[ci];
    it(`[${rc.name}] serialize -> save -> load -> apply`, () => {
      const state = mkState(rc.restored);
      // serialize() returns a plain dict; save() bytes must load back to it.
      const data = load(save(state));
      const ser = serialize(state);
      // the loaded dict equals serialize() (both are the plain JSON form)
      expect(data.round_index, `${rc.name} round_index`).toBe(ser.round_index);
      expect(data.tanks.length, `${rc.name} tank count`).toBe(ser.tanks.length);
      expect(data.terrain.b64, `${rc.name} terrain.b64`).toBe(ser.terrain.b64);
      const host = mkBlankState(rc.restored.tanks.length, rc.restored.w, rc.restored.h);
      apply(data, host);
      expectStateRestored(host, rc.restored, rc.name);
    });
  }
});

describe("savegame: load() header guards (catalog 18 s3.1 verbatim messages)", () => {
  it("good blob loads without throwing", () => {
    expect(() => load(hexToBytes(vec.guards.good_hex))).not.toThrow();
  });
  it("short blob -> 'is not a saved game.'", () => {
    expect(() => load(hexToBytes(vec.guards.short_hex))).toThrow(SaveError);
    try {
      load(hexToBytes(vec.guards.short_hex));
    } catch (e) {
      expect((e as SaveError).message).toBe(vec.guards.msg_not_saved);
    }
  });
  it("bad magic -> 'is not a saved game.'", () => {
    try {
      load(hexToBytes(vec.guards.bad_magic_hex));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SaveError);
      expect((e as SaveError).message).toBe(vec.guards.msg_not_saved);
    }
  });
  it("bad version -> 'was created by a different version.'", () => {
    try {
      load(hexToBytes(vec.guards.bad_version_hex));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SaveError);
      expect((e as SaveError).message).toBe(vec.guards.msg_diff_version);
    }
  });
  it("corrupt body -> 'is a corrupt saved game.'", () => {
    try {
      load(hexToBytes(vec.guards.corrupt_body_hex));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SaveError);
      expect((e as SaveError).message).toBe(vec.guards.msg_corrupt);
    }
  });
});

describe("savegame: economy length guard (incompatible item table)", () => {
  it("apply() rejects a save whose economy arrays != NUM_ITEMS", () => {
    const rc = vec.roundtrip[0];
    const data = load(save(mkState(rc.restored)));
    // truncate one economy array to simulate a foreign item table
    data.economy.price = data.economy.price.slice(0, NUM_ITEMS - 1);
    const host = mkBlankState(rc.restored.tanks.length, rc.restored.w, rc.restored.h);
    expect(() => apply(data, host)).toThrow(SaveError);
  });
});

describe("savegame: NON-ascending hit-map (documented JS-vs-CPython order divergence)", () => {
  // Round-trip VALUE equality holds for ALL key orders (apply re-keys to int).
  it("restored values match regardless of insertion order", () => {
    const blob = hexToBytes(vec.nonascending.blob_hex);
    const data = load(blob);
    const snap = vec.nonascending.restored;
    const host = mkBlankState(snap.tanks.length, snap.w, snap.h);
    apply(data, host);
    expectStateRestored(host, snap, "nonascending");
  });
  // The Python serializer emitted INSERTION order ("3":2,"0":1,"2":4). The TS
  // serializer, reading the JS-reordered (ascending) map, emits "0":1,"2":4,"3":2.
  // This is the known JS object-key-order divergence -- pin it explicitly so it is
  // documented, not silently passing.
  it("TS serializes the equivalent state in ASCENDING key order (divergence)", () => {
    const snap = vec.nonascending.restored;
    const state = mkState(snap);
    const body = new TextDecoder().decode(save(state).subarray(8));
    // TS ascending form is present...
    expect(body).toContain('"hits_this_round":{"0":1,"2":4,"3":2}');
    // ...and the Python insertion-order substring is NOT what TS produced.
    expect(body).not.toContain('"hits_this_round":{"3":2,"0":1,"2":4}');
    // confirm the Python golden body DID carry the non-ascending order (sanity)
    expect(vec.nonascending.py_body).toContain('"hits_this_round":{"3":2,"0":1,"2":4}');
  });
});
