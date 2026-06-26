/**
 * Differential gate: TS src/sound.ts synthesis == Python scorch.sound (the
 * byte-verified oracle).  Golden vectors are produced by oracle/dump_sound.py and
 * written to oracle/vectors/sound.json.
 *
 * WHAT IS TESTED NUMERICALLY (the heart of the task):
 *   - _square_array(freq, ms)         steady square tone int16 plane  -> EXACT
 *   - _square_array(freq, ms, f_end)  linear-chirp sweep int16 plane  -> EXACT
 *   - _seq_array(tones)               back-to-back blip int16 plane    -> EXACT
 *   - _sweep_steps(...)               shield-sweep (freq,ms) blip list -> EXACT
 *   - _fly_freq_for(POS/VEL, proj)    flight-tone pitch formula        -> EXACT
 *   - every play()/beep() EVENT TONE TABLE rebuilt and compared        -> EXACT
 *   - raw sin(phase) floats (_square_wave's transcendental substrate)  -> 1e-12
 *
 * EPSILON POLICY:  The synthesis OUTPUT is Math.sign(Math.sin(phase)) quantized to
 *   int16 by Math.trunc(x * AMPLITUDE * 32767).  The sign() collapse plus the
 *   numpy-exact linspace envelope makes the int16 planes reproduce numpy
 *   bit-for-bit (measured 0/259379 sample mismatches incl. all zero-crossings), so
 *   the int16 arrays are asserted EXACT (.toBe).  The only continuous quantity is
 *   the pre-sign sin(phase); per the brief's transcendental rule it is asserted
 *   within 1e-12 (.toBeCloseTo(.,12)).
 *
 * WHAT DEFERS:  Audio PLAYBACK (WebAudio AudioContext) is not Node-testable and is
 *   validated by the Phase-3 visual/runtime gate; this test exercises SAMPLE
 *   GENERATION only.  pixelsDeferredToPhase3 = false (this module emits audio, not
 *   pixels).  The Phase-1 no-op surface (init()===false, methods return undefined
 *   with no AudioContext) is owned by test/constants.test.ts and stays green here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { Sfx, sfx, type Tone } from "../src/sound";
import * as C from "../src/sound";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "sound.json");

// ---------------------------------------------------------------------------
// Vector types -- mirror oracle/dump_sound.py's payload shape.
// ---------------------------------------------------------------------------
type Consts = {
  SAMPLE_RATE: number; CHANNELS: number; AMPLITUDE: number;
  MIN_FREQ_HZ: number; MAX_FREQ_HZ: number; UI_BEEP_HZ: number; UI_BEEP_MS: number;
};
type SquareCase = { freq: number; ms: number; n: number; plane: number[] };
type SweepCase = { f0: number; ms: number; f1: number; n: number; plane: number[] };
type RawCase = { freq: number; ms: number; f_end: number | null; n: number; sin: number[] };
type SeqCase = { name: string; tones: number[][]; n: number; plane: number[] };
type SweepStepsCase = {
  start: number; step: number; count: number; blip_ms: number; out: number[][];
};
type FlyCase =
  | { mode: "POS"; launch: number | null; sy: number; out: number }
  | { mode: "VEL"; vx: number; vy: number; out: number };
type EventCase =
  | { kind: "seq"; tones: number[][]; plane: number[] }
  | { kind: "tone"; freq: number; ms: number; plane: number[] }
  | { kind: "sweep"; f0: number; f1: number; ms: number; plane: number[] };

type SoundVectors = {
  module: string;
  consts: Consts;
  square: SquareCase[];
  sweep: SweepCase[];
  raw: RawCase[];
  seq: SeqCase[];
  sweep_steps: SweepStepsCase[];
  fly: FlyCase[];
  events: { [name: string]: EventCase };
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as SoundVectors;

// A fresh synthesis instance (no AudioContext in Node -> _mix_rate=44100,
// _mix_channels=2, exactly like the dumper's mixer-less _Sfx()).
function freshSfx(): Sfx {
  return new Sfx();
}

/** Coerce the JSON number[][] tone lists into the TS Tone tuple type. */
function asTones(rows: number[][]): Tone[] {
  return rows.map((r) => (r.length > 2 ? ([r[0], r[1], r[2]] as Tone) : ([r[0], r[1]] as Tone)));
}

/** Exact int16-plane comparison with a helpful first-mismatch report. */
function expectPlaneExact(got: Int16Array, want: number[], label: string): void {
  expect(got.length, `${label} length`).toBe(want.length);
  for (let i = 0; i < want.length; i++) {
    if (got[i] !== want[i]) {
      // Fail with the specific sample so a desync is pinpointed, not buried.
      expect(got[i], `${label} sample[${i}]`).toBe(want[i]);
    }
  }
}

// ---------------------------------------------------------------------------
describe("sound: module constants match the oracle", () => {
  it("module tag", () => {
    expect(vec.module).toBe("sound");
  });
  it("synthesis constants", () => {
    expect(C.SAMPLE_RATE).toBe(vec.consts.SAMPLE_RATE);
    expect(C.CHANNELS).toBe(vec.consts.CHANNELS);
    expect(C.AMPLITUDE).toBe(vec.consts.AMPLITUDE);
    expect(C.MIN_FREQ_HZ).toBe(vec.consts.MIN_FREQ_HZ);
    expect(C.MAX_FREQ_HZ).toBe(vec.consts.MAX_FREQ_HZ);
    expect(C.UI_BEEP_HZ).toBe(vec.consts.UI_BEEP_HZ);
    expect(C.UI_BEEP_MS).toBe(vec.consts.UI_BEEP_MS);
  });
  it("battery is non-trivial", () => {
    const n =
      vec.square.length + vec.sweep.length + vec.raw.length + vec.seq.length +
      vec.sweep_steps.length + vec.fly.length + Object.keys(vec.events).length;
    expect(n).toBeGreaterThan(60);
  });
});

describe("sound: _square_array steady tones (int16 plane, EXACT)", () => {
  const s = freshSfx();
  for (let i = 0; i < vec.square.length; i++) {
    const c = vec.square[i];
    it(`#${i} ${c.freq}Hz ${c.ms}ms (n=${c.n})`, () => {
      const got = s._square_array(c.freq, c.ms);
      expectPlaneExact(got, c.plane, `square ${c.freq}/${c.ms}`);
    });
  }
});

describe("sound: _square_array sweeps (linear chirp, int16 plane, EXACT)", () => {
  const s = freshSfx();
  for (let i = 0; i < vec.sweep.length; i++) {
    const c = vec.sweep[i];
    it(`#${i} ${c.f0}->${c.f1}Hz ${c.ms}ms (n=${c.n})`, () => {
      const got = s._square_array(c.f0, c.ms, c.f1);
      expectPlaneExact(got, c.plane, `sweep ${c.f0}->${c.f1}/${c.ms}`);
    });
  }
});

describe("sound: _square_wave raw sin(phase) floats (epsilon 1e-12)", () => {
  const s = freshSfx();
  for (let i = 0; i < vec.raw.length; i++) {
    const c = vec.raw[i];
    it(`#${i} ${c.freq}Hz ${c.ms}ms f_end=${c.f_end} (n=${c.n})`, () => {
      // Recompute the underlying sin(phase) with the EXACT _square_wave phase
      // formula (sign() is applied inside _square_wave; here we test the float
      // substrate the brief calls out, so we recompute the phase directly).
      const rate = vec.consts.SAMPLE_RATE;
      const n = c.n;
      const freq = c.freq;
      const f_end = c.f_end;
      for (let k = 0; k < n; k++) {
        const t = k / rate;
        let phase: number;
        if (f_end === null || f_end === freq) {
          phase = 2.0 * Math.PI * freq * t;
        } else {
          const dur_s = n / rate;
          const slope = dur_s > 0 ? (f_end - freq) / dur_s : 0.0;
          phase = 2.0 * Math.PI * (freq * t + 0.5 * slope * t * t);
        }
        expect(Math.sin(phase), `sin #${i}[${k}]`).toBeCloseTo(c.sin[k], 12);
      }
      // And the quantized square (sign) is consistent: spot-check it equals
      // sign(recorded sin) for every sample (proves the int16 path is robust).
      const wave = s._square_wave(freq, n, rate, f_end);
      for (let k = 0; k < n; k++) {
        expect(wave[k], `sign #${i}[${k}]`).toBe(Math.sign(c.sin[k]));
      }
    });
  }
});

describe("sound: _seq_array blip sequences (sub-19 silence, clamp, EXACT)", () => {
  const s = freshSfx();
  for (let i = 0; i < vec.seq.length; i++) {
    const c = vec.seq[i];
    it(`#${i} ${c.name} (n=${c.n})`, () => {
      const got = s._seq_array(asTones(c.tones));
      expectPlaneExact(got, c.plane, `seq ${c.name}`);
    });
  }
});

describe("sound: _sweep_steps shield-sweep blip lists (EXACT)", () => {
  const s = freshSfx();
  for (let i = 0; i < vec.sweep_steps.length; i++) {
    const c = vec.sweep_steps[i];
    it(`#${i} start=${c.start} step=${c.step} count=${c.count}`, () => {
      const got = s._sweep_steps(c.start, c.step, c.count, c.blip_ms);
      const gotRows = got.map((t) => Array.from(t));
      expect(gotRows, `sweep_steps #${i}`).toEqual(c.out);
    });
  }
});

describe("sound: _fly_freq_for POS/VEL pitch (EXACT)", () => {
  for (let i = 0; i < vec.fly.length; i++) {
    const c = vec.fly[i];
    if (c.mode === "POS") {
      it(`#${i} POS launch=${c.launch} sy=${c.sy} -> ${c.out}`, () => {
        const s = freshSfx(); // fresh -> _fly_launch_y null (the launch===null case)
        if (c.launch !== null) s.set_launch_y(c.launch);
        const got = s._fly_freq_for("POS", { sy: c.sy });
        expect(got, `fly POS #${i}`).toBe(c.out);
      });
    } else {
      it(`#${i} VEL v=(${c.vx},${c.vy}) -> ${c.out}`, () => {
        const s = freshSfx();
        const got = s._fly_freq_for("VEL", { vx: c.vx, vy: c.vy });
        expect(got, `fly VEL #${i}`).toBe(c.out);
      });
    }
  }
});

describe("sound: play()/beep() EVENT TONE TABLES (rebuilt int16 plane, EXACT)", () => {
  const s = freshSfx();
  for (const name of Object.keys(vec.events)) {
    const e = vec.events[name];
    it(`event "${name}" (${e.kind})`, () => {
      let got: Int16Array;
      if (e.kind === "seq") {
        got = s._seq_array(asTones(e.tones));
      } else if (e.kind === "tone") {
        got = s._square_array(e.freq, e.ms);
      } else {
        got = s._square_array(e.f0, e.ms, e.f1);
      }
      expectPlaneExact(got, e.plane, `event ${name}`);
    });
  }
});

// ---------------------------------------------------------------------------
// No-audio degradation: in Node there is no AudioContext, so every public method
// must be a silent no-op (this is the Phase-1 contract that keeps the 14320 logic
// tests green; test/constants.test.ts asserts the same surface).  Verified here
// against the REAL port to lock it against regressions in THIS module's file.
// ---------------------------------------------------------------------------
describe("sound: no-AudioContext degradation (Node no-op contract)", () => {
  it("init() reports no audio, public methods return undefined, state unchanged", () => {
    expect(sfx.init()).toBe(false);
    expect(sfx.beep(440, 50)).toBeUndefined();
    expect(sfx.beep(440, 50, true)).toBeUndefined();
    expect(sfx.play("ui_beep")).toBeUndefined();
    expect(sfx.play("explosion", true, { size: 80 })).toBeUndefined();
    expect(sfx.play("fire", true)).toBeUndefined();
    expect(sfx.play("not_an_event", true)).toBeUndefined();
    expect(sfx.set_launch_y(100)).toBeUndefined();
    expect(sfx.start_fly("VEL")).toBeUndefined();
    expect(sfx.fly_tone("VEL", { vx: 10, vy: 10 })).toBeUndefined();
    expect(sfx.fly_tone("OFF", {})).toBeUndefined();
    expect(sfx.stop_fly()).toBeUndefined();
  });
  it("default gating attributes match the Python singleton", () => {
    expect(sfx.enabled).toBe(true);
    expect(sfx.fly_mode).toBe("OFF");
    expect(sfx.field_height).toBe(480);
  });
  it("a gated-off call is a no-op even with the gate forced", () => {
    expect(sfx.beep(440, 50, false)).toBeUndefined();
    expect(sfx.play("ui_beep", false)).toBeUndefined();
  });
});
