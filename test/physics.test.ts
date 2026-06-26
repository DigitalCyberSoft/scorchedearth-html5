/**
 * Differential gate: TS src/physics.ts == scorch/physics.py (the byte-verified
 * oracle), driven by oracle/dump_ai_cluster.py -> oracle/vectors/physics.json.
 *
 * EPSILON POLICY (per task + module docstring):
 *   - Launch velocities (vx,vy), trajectory positions (px,py), and post-step
 *     velocities are TRANSCENDENTAL-DERIVED (Math.cos/sin/sqrt in launch + the
 *     forward-Euler accumulation). The TS V8 libm and CPython's libm can differ
 *     in the last ULP of sin/cos/sqrt, so these are asserted toBeCloseTo(.,12)
 *     (a tight 1e-12 absolute tolerance; trajectories here stay |value| < ~1e5,
 *     so 12 fractional digits is far tighter than any physical resolution).
 *   - Integer screen coords sx,sy (via pyRound), booleans (alive, apogee), and
 *     bounce_count are EXACT (toBe). bounce_energy is an exactly-representable
 *     0.8 product chain -> EXACT.
 *
 * NOTE on sx/sy exact-ness: sx,sy round a transcendental px/py. A last-ULP px
 * difference COULD in principle flip a round at an exact .5 boundary. The battery
 * is built from real launch/step arithmetic (not hand-picked .5 ties), and the
 * run is green with toBe on every sx/sy, so no tie is hit; if the libm split ever
 * produced one it would surface here as a failure (not be silently masked).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import * as physics from "../src/physics";
import { Projectile } from "../src/objects";
import { Tank } from "../src/objects";
import { ITEMS } from "../src/weapons";
import { Config } from "../src/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "physics.json");
const vec = JSON.parse(readFileSync(VECTORS, "utf-8"));

const EPS = 12; // toBeCloseTo digits for transcendental-derived floats

function mkCfg(gravity = 0.2, visc = 0, wind = 0, elastic = "NONE"): Config {
  const cfg = new Config();
  cfg.GRAVITY = gravity;
  cfg.AIR_VISCOSITY = visc;
  cfg.ELASTIC = elastic;
  cfg.live_elastic = cfg.elastic; // mirror __post_init__ after mutating ELASTIC
  cfg.wind = wind;
  return cfg;
}

function mkTank(pi: number, x: number, y: number): Tank {
  const t = new Tank(pi, `P${pi}`);
  t.x = x;
  t.y = y;
  return t;
}

describe("physics: module constants", () => {
  it("DEG2RAD / TURRET_LEN / derived factors match", () => {
    const c = vec.consts[0];
    expect(physics.DEG2RAD).toBe(c.DEG2RAD);
    expect(physics.TURRET_LEN).toBe(c.TURRET_LEN);
  });
});

describe("physics: launch decomposition (System 3 battery)", () => {
  for (const r of vec.launch) {
    it(`angle ${r.angle} power ${r.power}`, () => {
      const t = mkTank(0, r.tank_x, r.tank_y);
      const cfg = mkCfg();
      const proj = physics.launch(t, cfg, ITEMS[0], r.power, r.angle);
      // vx,vy,px,py from cos/sin -> tight epsilon
      expect(proj.vx).toBeCloseTo(r.vx, EPS);
      expect(proj.vy).toBeCloseTo(r.vy, EPS);
      expect(proj.px).toBeCloseTo(r.px, EPS);
      expect(proj.py).toBeCloseTo(r.py, EPS);
      // sx,sy integer pixel; bounce/mode exact
      expect(proj.sx).toBe(r.sx);
      expect(proj.sy).toBe(r.sy);
      expect(proj.bounce_energy).toBe(r.bounce_energy);
      expect(proj.bounce_count).toBe(r.bounce_count);
      expect(proj.mode).toBe(r.mode);
      expect(proj.guidance === null).toBe(r.guidance_is_none);
    });
  }
});

describe("physics: step trajectories (System 2 grid)", () => {
  for (const r of vec.step) {
    it(`g=${r.gravity} visc=${r.visc} wind=${r.wind} ang=${r.angle} pw=${r.power}`, () => {
      const cfg = mkCfg(r.gravity, r.visc, r.wind);
      const t = mkTank(0, 100, 400);
      const proj = physics.launch(t, cfg, ITEMS[0], r.power, r.angle);
      proj.guidance = null;
      let snapIdx = 0;
      for (let i = 1; i <= r.nsteps; i++) {
        physics.step(proj, cfg);
        if (i % r.stride === 0 || i === r.nsteps) {
          const [px, py, vx, vy, sx, sy] = r.snaps[snapIdx++];
          expect(proj.px).toBeCloseTo(px, EPS);
          expect(proj.py).toBeCloseTo(py, EPS);
          expect(proj.vx).toBeCloseTo(vx, EPS);
          expect(proj.vy).toBeCloseTo(vy, EPS);
          expect(proj.sx).toBe(sx);
          expect(proj.sy).toBe(sy);
        }
      }
    });
  }
});

describe("physics: apogee_reached", () => {
  for (const r of vec.apogee) {
    it(`vy=${r.vy}`, () => {
      const p = new Projectile(null, ITEMS[0], 100.0, 100.0, 10.0, r.vy);
      expect(physics.apogee_reached(p)).toBe(r.out);
    });
  }
});

describe("physics: handle_walls (every wall sub-mode x boundary)", () => {
  for (const r of vec.handle_walls) {
    if (r.fn === "handle_walls_repeat") {
      it(`repeat bounces mode ${r.mode} (6-bounce energy decay)`, () => {
        const cfg = mkCfg();
        cfg.live_elastic = r.mode;
        const p = new Projectile(null, ITEMS[0], 100.0, 150 + 1, 5.0, -200.0);
        p.guidance = null;
        for (let k = 0; k < r.log.length; k++) {
          p.px = 100.0;
          p.py = 150 + 1;
          p.vy = -200.0;
          const alive = physics.handle_walls(p, cfg, 200, 150);
          const [exAlive, exVy, exBounce, exEnergy] = r.log[k];
          expect(alive).toBe(exAlive);
          expect(p.vy).toBeCloseTo(exVy, EPS);
          expect(p.bounce_count).toBe(exBounce);
          expect(p.bounce_energy).toBeCloseTo(exEnergy, EPS);
        }
      });
      continue;
    }
    it(`mode ${r.mode} @ (${r.px_in},${r.py_in}) v=(${r.vx_in},${r.vy_in})`, () => {
      const cfg = mkCfg();
      cfg.live_elastic = r.mode;
      const p = new Projectile(
        null,
        ITEMS[0],
        r.px_in,
        r.py_in,
        r.vx_in,
        r.vy_in,
      );
      p.guidance = null;
      const alive = physics.handle_walls(p, cfg, 200, 150);
      expect(alive).toBe(r.alive);
      // px/py after a reflect are either an integer edge (exact) or unchanged
      // (== the float input, exact); vx/vy after coef-scale are exact products
      // of the input by a clean coef (-1/-0.5/-2). So all EXACT here.
      expect(p.px).toBe(r.px);
      expect(p.py).toBe(r.py);
      expect(p.vx).toBe(r.vx);
      expect(p.vy).toBe(r.vy);
      expect(p.sx).toBe(r.sx);
      expect(p.sy).toBe(r.sy);
      expect(p.bounce_count).toBe(r.bounce_count);
      expect(p.bounce_energy).toBe(r.bounce_energy);
    });
  }
});
