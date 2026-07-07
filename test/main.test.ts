/**
 * Differential gate: TS main == Python scorch.main (the fidelity oracle) for the
 * NUMERIC surface of the App integrator.
 *
 * Golden vectors come from oracle/dump_main.py and live in oracle/vectors/main.json.
 * The Python dumper drives the REAL scorch.main functions headless; this test
 * asserts src/main.ts reproduces them.
 *
 * WHAT IS TESTED HERE (DOM-free, no GameState, no pygame surfaces):
 *   1. _wants_zoom_wipe(screen): the opaque/panel-rect predicate, over every
 *      attribute combination the oracle enumerated.  EXACT bool.
 *   2. _ZoomWipeMath: the _ZoomWipe ANIMATION math (TRANSITION_FRAMES / _FRAME_DT /
 *      _FLASH_PEAK + the frame accumulator advance(), _scale(), _flash_level(), the
 *      additive flash amount), step-by-step against the oracle for OPEN/CLOSE and a
 *      skip() case.  _ZoomWipeMath is constructed directly (it touches only
 *      palette.LiveLUT, which is DOM-free); the _ZoomWipe SURFACE side (subsurface/
 *      smoothscale/BLEND_RGB_ADD) needs a canvas and defers to Phase 3.
 *   3. The run-loop time base: stepPlan's fixed-step catch-up.  INTENTIONAL
 *      DIVERGENCE from the oracle (main.py:649 dt = min(elapsed, 1/30)): the
 *      oracle formula under-advances game time below 30 fps (slow motion on
 *      weak hardware); the port banks real elapsed time and consumes it in
 *      exact STEP_DT steps, capped at MAX_FRAME_DEBT_S so a pause does not
 *      replay as a burst.  The old dt_clamp oracle vectors are no longer
 *      asserted (the formula they pin is the defect that was fixed); the
 *      engine-math gates are untouched.
 *
 * EPSILON POLICY:
 *   frame / done / amt / want / dt are integers / booleans / exactly-representable
 *   and asserted EXACT (.toBe).  _scale() and _flash_level() are pure +,-,*,/,abs,max
 *   on doubles (frame/20, 1-|2t-1|, max(1/w, s)); IEEE754 makes identical operation
 *   sequences yield identical doubles in CPython and V8, so they are ALSO asserted
 *   EXACT (.toBe).  There is no transcendental on this module's numeric path, so no
 *   toBeCloseTo is needed (the oracle's flash doubles like 0.09999999999999998 must
 *   match bit-for-bit, and do).
 *
 * NOT TESTED (deferred): App.run / _act / the GameState sequencing (needs the
 * unported engine + sprites; its outputs are pixels or full-engine state already
 * covered by the game/render/ingame/screens gates), and every screen .draw() (DOM
 * pixels -> Phase-3 visual gate).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  _wants_zoom_wipe,
  _ZoomWipeMath,
  TRANSITION_FRAMES,
  _FRAME_DT,
  stepPlan,
  STEP_DT,
  MAX_FRAME_DEBT_S,
} from "../src/main";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "main.json");

interface WantCase {
  opaque: boolean | null;
  has_panel: boolean;
  has_rect: boolean;
  want: boolean;
}
interface WipeStep {
  frame: number;
  done: boolean;
  scale: number;
  flash: number;
  amt: number;
}
interface WipeRun {
  rect: [number, number];
  opening: boolean;
  label: string;
  dt: number[];
  steps: WipeStep[];
}
interface MainVectors {
  wants: { cases: WantCase[] };
  wipe: {
    TRANSITION_FRAMES: number;
    FRAME_DT: number;
    FLASH_PEAK: number;
    runs: WipeRun[];
    skip: { pre: { frame: number; done: boolean }; post: { frame: number; done: boolean; scale: number; flash: number } };
  };
  dt_clamp: { cap: number; samples: Array<{ elapsed_s: number; dt: number }> };
}

const V: MainVectors = JSON.parse(readFileSync(VECTORS, "utf8"));

/** Build a stub screen with exactly the attributes the predicate probes, matching
 *  oracle/dump_main.py's _Stub (opaque absent when null; panel/rect optional). */
function mkStub(c: WantCase): {
  opaque?: boolean;
  panel?: { rect?: unknown } | null;
} {
  const s: { opaque?: boolean; panel?: { rect?: unknown } } = {};
  if (c.opaque !== null) {
    s.opaque = c.opaque;
  }
  if (c.has_panel) {
    const p: { rect?: unknown } = {};
    if (c.has_rect) {
      // any non-null rect; the predicate only checks presence (rect !== None).
      p.rect = { x: 10, y: 20, w: 30, h: 40 };
    }
    s.panel = p;
  }
  return s;
}

describe("main._wants_zoom_wipe predicate", () => {
  it("matches the oracle for every opaque x panel x rect combination", () => {
    expect(V.wants.cases.length).toBeGreaterThan(0);
    for (const c of V.wants.cases) {
      const got = _wants_zoom_wipe(mkStub(c) as never);
      expect(got).toBe(c.want);
    }
  });
});

describe("main._ZoomWipeMath constants", () => {
  it("TRANSITION_FRAMES / _FRAME_DT / _FLASH_PEAK match the oracle", () => {
    expect(TRANSITION_FRAMES).toBe(V.wipe.TRANSITION_FRAMES);
    expect(_FRAME_DT).toBe(V.wipe.FRAME_DT);
    expect(_ZoomWipeMath._FLASH_PEAK).toBe(V.wipe.FLASH_PEAK);
  });
});

describe("main._ZoomWipeMath animation math", () => {
  for (const run of V.wipe.runs) {
    it(`rect=${run.rect.join("x")} opening=${run.opening} seq=${run.label} reproduces every step`, () => {
      const m = new _ZoomWipeMath(run.rect[0], run.rect[1], run.opening);
      // step 0 = initial state (before any advance), matching the oracle's first sample.
      const s0 = run.steps[0];
      expect(m.frame).toBe(s0.frame);
      expect(m.done).toBe(s0.done);
      expect(m._scale()).toBe(s0.scale);
      expect(m._flash_level()).toBe(s0.flash);
      expect(m.flashAmount()).toBe(s0.amt);
      // then one recorded step per advance(dt).
      for (let i = 0; i < run.dt.length; i++) {
        m.advance(run.dt[i]);
        const st = run.steps[i + 1];
        expect(m.frame).toBe(st.frame);
        expect(m.done).toBe(st.done);
        expect(m._scale()).toBe(st.scale);
        expect(m._flash_level()).toBe(st.flash);
        expect(m.flashAmount()).toBe(st.amt);
      }
    });
  }

  it("skip() jumps to the last frame from a partial state", () => {
    const m = new _ZoomWipeMath(40, 30, true);
    m.advance(_FRAME_DT * 3.0);
    expect(m.frame).toBe(V.wipe.skip.pre.frame);
    expect(m.done).toBe(V.wipe.skip.pre.done);
    m.skip();
    expect(m.frame).toBe(V.wipe.skip.post.frame);
    expect(m.done).toBe(V.wipe.skip.post.done);
    expect(m._scale()).toBe(V.wipe.skip.post.scale);
    expect(m._flash_level()).toBe(V.wipe.skip.post.flash);
  });
});

describe("main run-loop fixed-step plan (intentional divergence from main.py:649)", () => {
  it("consumes elapsed time in whole STEP_DT steps, carrying the exact remainder", () => {
    let debt = 0;
    let stepped = 0;
    let wall = 0;
    // a steady 24 fps frame train: every frame is longer than STEP_DT
    for (let i = 0; i < 240; i++) {
      const elapsed = 1 / 24;
      wall += elapsed;
      const plan = stepPlan(elapsed, debt);
      debt = plan.debt;
      stepped += plan.steps;
      expect(plan.debt).toBeGreaterThanOrEqual(0);
      expect(plan.debt).toBeLessThan(STEP_DT);
    }
    // game time tracks wall time to within one carried step (no dilation; the
    // oracle clamp would have advanced only (1/30)/(1/24) = 0.8x here)
    expect(Math.abs(stepped * STEP_DT - wall)).toBeLessThan(STEP_DT);
  });

  it("runs 1 step per frame at 60 fps and 2 at 30 fps", () => {
    expect(stepPlan(1 / 60, 0).steps).toBe(1);
    const p30 = stepPlan(1 / 30, 0);
    expect(p30.steps).toBe(2);
    expect(p30.debt).toBeLessThan(1e-12);
  });

  it("caps a pause-resume spike at MAX_FRAME_DEBT_S instead of replaying it", () => {
    const p = stepPlan(300.0, 0);
    expect(p.steps).toBe(Math.floor(MAX_FRAME_DEBT_S / STEP_DT));
    expect(p.steps * STEP_DT + p.debt).toBeCloseTo(MAX_FRAME_DEBT_S, 12);
  });

  it("never goes negative on clock weirdness", () => {
    const p = stepPlan(-0.5, -1);
    expect(p.steps).toBe(0);
    expect(p.debt).toBe(0);
  });
});
