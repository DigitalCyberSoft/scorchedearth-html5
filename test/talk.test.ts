/**
 * Differential gate: TS `talk` == Python `scorch.talk` (the fidelity oracle,
 * itself byte-verified against 1.5/SCORCH.EXE + the shipped TALK1.CFG/TALK2.CFG).
 *
 * Golden vectors come from oracle/dump_talk.py and live in
 * oracle/vectors/talk.json. The talk module is fully discrete: pick indices,
 * parsed lines, war-quote strings, gate booleans, and taunt strings. There is
 * NO transcendental math on any path (no sin/cos/pow/sqrt/atan2), so EVERY
 * assertion here is EXACT (expect(...).toBe(...)). No epsilon is used or needed.
 *
 * The seeded runs share the RNG-stream contract proven in rng.test.ts: a single
 * `new Rng(seed)` driven through the same call sequence the Python dumper used
 * reproduces CPython's MT19937 stream value-for-value, hence the same picks.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, it, expect } from "vitest";
import { Rng } from "../src/rng";
import {
  WAR_QUOTES,
  TalkConfig,
  TalkSettingsSource,
  _parse,
  _read,
  _resolve,
  load,
  load_from_config,
  _talks,
  _draw,
  maybe_attack_taunt,
  die_taunt,
  war_quote,
  set_speech,
  tick,
  SpeechState,
} from "../src/talk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "talk.json");

type TalkVectors = {
  data_dir: string;
  attack: string[];
  die: string[];
  settings: { talking: string; probability: number; delay: number };
  parse: { raw: string; out: string[] }[];
  war_quotes: [string, string][];
  war_quote_runs: { seed: number; idx: number[]; picks: [string, string][] }[];
  draw_runs: { pool: string; seed: number; out: (string | null)[] }[];
  taunt_runs: {
    talking: string;
    prob: number;
    ai_class: number;
    seed: number;
    attack_out: (string | null)[];
    die_out: (string | null)[];
  }[];
  talks_table: { talking: string; ai_class: number; result: boolean }[];
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as TalkVectors;

// Node fs primitives injected into the env-agnostic loader, matching Python's
// os.path.join / os.path.exists / os.listdir / open(rb).read() semantics.
const NODE_FS = {
  joinPath: (a: string, b: string) => join(a, b),
  pathExists: (p: string) => existsSync(p),
  listDir: (p: string): string[] | null => {
    try {
      return readdirSync(p);
    } catch {
      return null;
    }
  },
  readFile: (p: string): Uint8Array | null => {
    try {
      return readFileSync(p);
    } catch {
      return null;
    }
  },
};

// A cfg-like object carrying exactly the keys TalkConfig reads.
function mkCfgSource(
  talking: string,
  probability: number,
  delay = 50,
  attackName = "talk1.cfg",
  dieName = "talk2.cfg",
): TalkSettingsSource {
  return {
    TALKING_TANKS: talking,
    TALK_PROBABILITY: probability,
    TALK_DELAY: delay,
    ATTACK_COMMENTS: attackName,
    DIE_COMMENTS: dieName,
  };
}

// Reusable TalkConfig built from the golden pools + a talking/prob pair (the TS
// twin of the dumper's _mk_cfg). Pools are copied so draws never mutate them.
function mkTalkConfig(talking: string, probability: number): TalkConfig {
  return new TalkConfig(
    vec.attack.slice(),
    vec.die.slice(),
    mkCfgSource(talking, probability),
  );
}

// ---------------------------------------------------------------------------
// 1. Parsed taunt pools (verbatim) + snapshot settings, via the real loader.
// ---------------------------------------------------------------------------
describe("talk: load_from_config parses the shipped pools verbatim", () => {
  const tc = load_from_config(
    mkCfgSource("OFF", 100, 50),
    vec.data_dir,
    NODE_FS,
  );

  it(`attack pool has ${vec.attack.length} lines, matching the oracle exactly`, () => {
    expect(tc.attack.length).toBe(vec.attack.length);
    for (let i = 0; i < vec.attack.length; i++) {
      expect(tc.attack[i], `attack line ${i}`).toBe(vec.attack[i]);
    }
  });

  it(`die pool has ${vec.die.length} lines, matching the oracle exactly`, () => {
    expect(tc.die.length).toBe(vec.die.length);
    for (let i = 0; i < vec.die.length; i++) {
      expect(tc.die[i], `die line ${i}`).toBe(vec.die[i]);
    }
  });

  it("snapshots talking/probability/delay as the oracle did", () => {
    expect(tc.talking).toBe(vec.settings.talking);
    expect(tc.probability).toBe(vec.settings.probability);
    expect(tc.delay).toBe(vec.settings.delay);
  });
});

// load() with explicit resolved paths (case-insensitive _resolve) reproduces
// the same pools, proving _resolve + _read + _parse end-to-end on real bytes.
describe("talk: _resolve + load on the real files (DOS case-insensitive)", () => {
  it("resolves lowercase cfg names to the uppercase shipped files", () => {
    const ap = _resolve(vec.data_dir, "talk1.cfg", NODE_FS);
    const dp = _resolve(vec.data_dir, "talk2.cfg", NODE_FS);
    // The shipped files are TALK1.CFG/TALK2.CFG; the resolver must find them.
    expect(existsSync(ap)).toBe(true);
    expect(existsSync(dp)).toBe(true);
    const tc = load(ap, dp, mkCfgSource("OFF", 100), NODE_FS.readFile);
    expect(tc.attack.length).toBe(vec.attack.length);
    expect(tc.die.length).toBe(vec.die.length);
    for (let i = 0; i < vec.attack.length; i++) {
      expect(tc.attack[i], `attack ${i}`).toBe(vec.attack[i]);
    }
    for (let i = 0; i < vec.die.length; i++) {
      expect(tc.die[i], `die ${i}`).toBe(vec.die[i]);
    }
  });

  it("a missing file yields an empty pool, not an error", () => {
    const missing = _resolve(vec.data_dir, "nope-does-not-exist.cfg", NODE_FS);
    expect(_read(missing, NODE_FS.readFile)).toBe("");
    const tc = load(
      missing,
      missing,
      mkCfgSource("ALL", 100),
      NODE_FS.readFile,
    );
    expect(tc.attack.length).toBe(0);
    expect(tc.die.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 1b. _parse unit battery: CRLF/CR/LF, trailing-terminator drop, interior
//     blanks kept, duplicates kept, whitespace untouched.
// ---------------------------------------------------------------------------
describe("talk: _parse terminator/blank/duplicate handling", () => {
  for (let i = 0; i < vec.parse.length; i++) {
    const { raw, out } = vec.parse[i];
    it(`parse case ${i} (${JSON.stringify(raw)}) -> ${out.length} lines`, () => {
      const got = _parse(raw);
      expect(got.length, `length for case ${i}`).toBe(out.length);
      for (let j = 0; j < out.length; j++) {
        expect(got[j], `case ${i} line ${j}`).toBe(out[j]);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 2. War-quote table, verbatim (15 {text, author} pairs).
// ---------------------------------------------------------------------------
describe("talk: WAR_QUOTES table is verbatim (15 entries)", () => {
  it(`has ${vec.war_quotes.length} entries`, () => {
    expect(WAR_QUOTES.length).toBe(vec.war_quotes.length);
  });
  for (let i = 0; i < vec.war_quotes.length; i++) {
    it(`entry ${i} text + author match the binary strings`, () => {
      expect(WAR_QUOTES[i][0], `quote ${i} text`).toBe(vec.war_quotes[i][0]);
      expect(WAR_QUOTES[i][1], `quote ${i} author`).toBe(vec.war_quotes[i][1]);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. war_quote(seed): picker over many fixed seeds. Index AND returned pair
//    must match across the whole consumed stream.
// ---------------------------------------------------------------------------
describe("talk: war_quote picks match the seeded MT stream", () => {
  for (const run of vec.war_quote_runs) {
    it(`seed ${run.seed}: ${run.idx.length} war_quote() draws match`, () => {
      const r = new Rng(run.seed);
      for (let i = 0; i < run.idx.length; i++) {
        const q = war_quote(r);
        // The index the picker chose is recoverable; assert both index and text.
        expect(q[0], `seed ${run.seed} draw ${i} text`).toBe(run.picks[i][0]);
        expect(q[1], `seed ${run.seed} draw ${i} author`).toBe(run.picks[i][1]);
        expect(WAR_QUOTES[run.idx[i]][0], `seed ${run.seed} draw ${i} idx`).toBe(
          q[0],
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 4. _draw(pool, rng): uniform line incl. empty (->null), single, blanks, dups,
//    and the real attack/die pools, over many seeds.
// ---------------------------------------------------------------------------
describe("talk: _draw uniform pool draws match the seeded stream", () => {
  // Rebuild the same synthetic pools the dumper used (the named pools).
  const POOLS: Record<string, string[]> = {
    attack: vec.attack.slice(),
    die: vec.die.slice(),
    empty: [],
    single: ["only"],
    blanks: ["a", "", "b", "", ""],
    dups: ["x", "x", "y", "x"],
  };
  for (const run of vec.draw_runs) {
    it(`pool ${run.pool} seed ${run.seed}: ${run.out.length} draws match`, () => {
      const pool = POOLS[run.pool];
      expect(pool, `pool ${run.pool} known`).toBeDefined();
      const r = new Rng(run.seed);
      for (let i = 0; i < run.out.length; i++) {
        const v = _draw(pool.slice(), r);
        expect(v, `_draw ${run.pool} #${i} seed ${run.seed}`).toBe(run.out[i]);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 5. maybe_attack_taunt / die_taunt: full gate-then-roll-then-draw, across
//    talking modes, probabilities, ai_class, and seeds. Strings + null exact.
//    Each call must consume the identical RNG quantity (gate: 0; failed roll:
//    one pick(100); passed roll: pick(100) then pick(len(pool))), so attack and
//    die are each driven on their own fresh Rng(seed) to match the dumper.
// ---------------------------------------------------------------------------
describe("talk: maybe_attack_taunt / die_taunt gate-roll-draw", () => {
  for (const run of vec.taunt_runs) {
    const label =
      `talking=${run.talking} prob=${run.prob} ai=${run.ai_class} seed=${run.seed}`;
    it(`${label}: ${run.attack_out.length} attack + die taunts match`, () => {
      const tcfg = mkTalkConfig(run.talking, run.prob);
      const tank = { ai_class: run.ai_class };
      const ra = new Rng(run.seed);
      const rd = new Rng(run.seed);
      for (let i = 0; i < run.attack_out.length; i++) {
        expect(
          maybe_attack_taunt(tank, tcfg, ra),
          `attack ${label} #${i}`,
        ).toBe(run.attack_out[i]);
        expect(die_taunt(tank, tcfg, rd), `die ${label} #${i}`).toBe(
          run.die_out[i],
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 6. _talks gate truth table (no RNG).
// ---------------------------------------------------------------------------
describe("talk: _talks gate truth table", () => {
  for (let i = 0; i < vec.talks_table.length; i++) {
    const row = vec.talks_table[i];
    it(`talking=${row.talking} ai=${row.ai_class} -> ${row.result}`, () => {
      const tcfg = mkTalkConfig(row.talking, 100);
      const tank = { ai_class: row.ai_class };
      expect(_talks(tank, tcfg)).toBe(row.result);
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Display model: set_speech / tick. No RNG and no oracle vector (these are
//    pure state-machine functions); assert the Python control flow directly.
//    Frame math is exact: dt/DT with DT = 1/60, and the chosen dts land on
//    exact frame boundaries, so no epsilon is involved.
// ---------------------------------------------------------------------------
describe("talk: set_speech / tick speech-bubble state machine", () => {
  it("set_speech with falsy text clears the bubble", () => {
    const state: SpeechState = { speech: { tank: 1, text: "hi", until_frame: 9 } };
    set_speech(state, 7, null);
    expect(state.speech).toBe(null);
    const state2: SpeechState = { speech: { tank: 1, text: "hi", until_frame: 9 } };
    set_speech(state2, 7, "");
    expect(state2.speech).toBe(null);
  });

  it("set_speech parks {tank,text,until_frame} using cfg.delay (TalkConfig)", () => {
    const state: SpeechState = {};
    const tcfg = mkTalkConfig("ALL", 100); // delay = 50
    const tank = { id: 3 };
    set_speech(state, tank, "boom", tcfg);
    expect(state._speech_frame).toBe(0);
    expect(state.speech).not.toBe(null);
    expect(state.speech!.tank).toBe(tank);
    expect(state.speech!.text).toBe("boom");
    expect(state.speech!.until_frame).toBe(0 + tcfg.delay);
  });

  it("set_speech falls back to cfg.TALK_DELAY when cfg has no .delay", () => {
    const state: SpeechState = {};
    set_speech(state, 1, "x", { TALK_DELAY: 30 });
    expect(state.speech!.until_frame).toBe(30);
  });

  it("set_speech uses state.cfg.TALK_DELAY when cfg arg is omitted", () => {
    const state: SpeechState = { cfg: { TALK_DELAY: 12 } };
    set_speech(state, 1, "x");
    expect(state.speech!.until_frame).toBe(12);
  });

  it("set_speech defaults delay to 50 when nothing supplies one", () => {
    const state: SpeechState = {};
    set_speech(state, 1, "x");
    expect(state.speech!.until_frame).toBe(50);
  });

  it("set_speech clamps delay to a minimum of 1 frame", () => {
    const state: SpeechState = {};
    set_speech(state, 1, "x", { delay: 0 } as unknown as { delay: number });
    expect(state.speech!.until_frame).toBe(1);
    const state2: SpeechState = {};
    set_speech(state2, 1, "x", { delay: -5 } as unknown as { delay: number });
    expect(state2.speech!.until_frame).toBe(1);
  });

  it("set_speech preserves an existing _speech_frame as the base", () => {
    const state: SpeechState = { _speech_frame: 100 };
    set_speech(state, 1, "x", { delay: 5 } as unknown as { delay: number });
    expect(state.speech!.until_frame).toBe(105);
  });

  it("tick advances _speech_frame by dt/DT and expires at until_frame", () => {
    const state: SpeechState = {};
    set_speech(state, 1, "x", { delay: 2 } as unknown as { delay: number });
    expect(state.speech!.until_frame).toBe(2);
    // DT = 1/60 -> one frame per (1/60)s. Advance one frame: still live (1 < 2).
    tick(state, 1 / 60);
    expect(state._speech_frame).toBe(1);
    expect(state.speech).not.toBe(null);
    // Advance a second frame: _speech_frame == 2 >= until_frame -> expire.
    tick(state, 1 / 60);
    expect(state._speech_frame).toBe(2);
    expect(state.speech).toBe(null);
  });

  it("tick initializes _speech_frame and no-ops when there is no bubble", () => {
    const state: SpeechState = {};
    tick(state, 1 / 60);
    expect(state._speech_frame).toBe(1);
    expect(state.speech === null || state.speech === undefined).toBe(true);
  });
});
