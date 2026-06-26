/**
 * Differential gate: TS src/guidance.ts == scorch/guidance.py (the byte-verified
 * oracle), driven by oracle/dump_ai_cluster.py -> oracle/vectors/guidance.json.
 *
 * EPSILON POLICY (per task + module docstring):
 *   - Steered velocities (vx,vy) and positions come from unit-vector blends
 *     (Math.hypot/division) plus the forward-Euler step; they are
 *     transcendental-derived, so they are asserted toBeCloseTo(.,12). The arming
 *     latch (boolean) and the column/altitude axis snaps that produce an EXACT
 *     value (vy=0 on horizontal arm; px = tx integer snap on vertical arm) are
 *     compared with the same close-to tolerance since they ride alongside the
 *     transcendental vx/vy in one snapshot tuple -- 1e-12 still pins 0.0 and an
 *     integer column to the bit.
 *   - attach() outputs (installed flag, gtype string, armed bool, target/point)
 *     are EXACT (toBe / toEqual).
 *   - team_mode_active booleans are EXACT.
 *   - solve_ballistic_power / _launch return INTEGER power -> EXACT.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import * as guidance from "../src/guidance";
import * as physics from "../src/physics";
import { Projectile } from "../src/objects";
import { Tank } from "../src/objects";
import { ITEMS } from "../src/weapons";
import { Config } from "../src/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "guidance.json");
const vec = JSON.parse(readFileSync(VECTORS, "utf-8"));

const EPS = 12;

function mkCfg(gravity = 0.2, visc = 0, wind = 0): Config {
  const cfg = new Config();
  cfg.GRAVITY = gravity;
  cfg.AIR_VISCOSITY = visc;
  cfg.live_elastic = cfg.elastic;
  cfg.wind = wind;
  return cfg;
}

function mkTank(
  pi: number,
  x: number,
  y: number,
  team_id = 0,
  angle = 45,
): Tank {
  const t = new Tank(pi, `P${pi}`, 0, team_id);
  t.x = x;
  t.y = y;
  t.angle = angle;
  return t;
}

// Item index -> Item, for the weapon a vector references.
function weap(idx: number) {
  return ITEMS[idx];
}

describe("guidance: module constants", () => {
  it("HEAT_RANGE matches", () => {
    expect(guidance.HEAT_RANGE).toBe(vec.consts[0].HEAT_RANGE);
  });
  it("_IGNORES_GUIDANCE set matches", () => {
    expect([...guidance._IGNORES_GUIDANCE].sort()).toEqual(vec.consts[0].ignores);
  });
});

describe("guidance: attach (slot type / ignore weapons / invalid slot)", () => {
  for (const r of vec.attach) {
    it(`slot ${r.slot} weapon ${r.weapon_idx} (${r.behavior})`, () => {
      const t = mkTank(0, 200, 400);
      t.selected_guidance = r.slot === -1 ? null : r.slot;
      t.guidance_target = r.has_target ? mkTank(1, 800, 400) : null;
      // Seed the click point with the SAME value the dumper fed (carried in
      // r.g_point when a point was installed); attach copies it verbatim into
      // g.point, so the input must match to reproduce the recorded output.
      t.guidance_target_pt = r.has_point
        ? r.g_point !== null && r.g_point !== undefined
          ? (r.g_point as [number, number])
          : [600, 300]
        : null;
      const p = new Projectile(t, weap(r.weapon_idx), 200.0, 396.0, 100.0, 100.0);
      const g = guidance.attach(t, mkCfg(), weap(r.weapon_idx), p);
      expect(g !== null).toBe(r.installed);
      expect(p.guidance === null).toBe(r.proj_guidance_is_none);
      if (g !== null) {
        expect(g.type).toBe(r.gtype);
        expect(g.armed).toBe(r.g_armed);
        expect(g.target === null).toBe(r.g_target_is_none);
        if (r.g_point === null) {
          expect(g.point).toBe(null);
        } else {
          expect(g.point).toEqual(r.g_point);
        }
      }
    });
  }
});

describe("guidance: team_mode_active", () => {
  for (const r of vec.team_mode) {
    it(`ta=${r.ta} tb=${r.tb}`, () => {
      expect(
        guidance.team_mode_active({ team_id: r.ta }, { team_id: r.tb }),
      ).toBe(r.out);
    });
  }
});

describe("guidance: apply (per-step steering, integrated path)", () => {
  for (const r of vec.apply_steer) {
    it(`${r.label} (slot ${r.slot})`, () => {
      // reconstruct the dump's run_guided exactly. Each label fixes the
      // target/point/tanks; mirror that here from the label so the steering
      // inputs are identical.
      const cfg = mkCfg(0.2, 0, 0);
      const owner = mkTank(0, 200, 600, 0);
      owner.selected_guidance = r.slot;
      let gt: Tank | null = null;
      let gp: [number, number] | null = null;
      let tanks: Tank[] | null = null;
      switch (r.label) {
        case "heat_acquire":
          tanks = [mkTank(1, 230, 600, 0)];
          break;
        case "heat_out_of_range":
          tanks = [mkTank(2, 600, 300, 0)];
          break;
        case "horizontal_pt":
          gp = [500, 500];
          break;
        case "horizontal_tgt":
          gt = mkTank(3, 700, 520);
          break;
        case "vertical_pt":
          gp = [500, 400];
          break;
        case "vertical_tgt":
          gt = mkTank(4, 520, 450);
          break;
        case "lazyboy_pt":
          gp = [520, 480];
          break;
        case "lazyboy_tgt_fallback":
          gt = mkTank(5, 560, 500);
          break;
        case "ballistic_noop":
          gt = mkTank(6, 700, 600);
          break;
      }
      owner.guidance_target = gt;
      owner.guidance_target_pt = gp;
      const proj = new Projectile(
        owner,
        weap(r.weapon_idx),
        r.p0[0],
        r.p0[1],
        r.v0[0],
        r.v0[1],
      );
      guidance.attach(owner, cfg, weap(r.weapon_idx), proj);
      for (let i = 0; i < r.steps; i++) {
        physics.step(proj, cfg, undefined, tanks);
        const g = proj.guidance as guidance.Guidance | null;
        const [vx, vy, px, py, armed] = r.snaps[i];
        expect(proj.vx).toBeCloseTo(vx, EPS);
        expect(proj.vy).toBeCloseTo(vy, EPS);
        expect(proj.px).toBeCloseTo(px, EPS);
        expect(proj.py).toBeCloseTo(py, EPS);
        expect(g ? g.armed : false).toBe(armed);
      }
    });
  }
});

describe("guidance: solve_ballistic_power (wind-correcting, int power)", () => {
  for (const r of vec.solve_ballistic) {
    it(`g=${r.gravity} wind=${r.wind} angle=${r.angle} pt=${JSON.stringify(r.pt)}`, () => {
      const cfg = mkCfg(r.gravity, 0, r.wind);
      const st = { cfg, w: 1024, h: 768 };
      const tank = mkTank(0, r.tank_x, r.tank_y, 0, r.angle);
      tank.guidance_target = null;
      tank.guidance_target_pt = r.pt === null ? null : (r.pt as [number, number]);
      const sol = guidance.solve_ballistic_power(st, tank, ITEMS[0]);
      expect(sol === null ? -1 : sol).toBe(r.power);
    });
  }
});

describe("guidance: solve_ballistic_power_launch (closed form, int power)", () => {
  for (const r of vec.solve_ballistic_launch) {
    it(`g=${r.gravity} wind=${r.wind} angle=${r.angle} pt=${JSON.stringify(r.pt)}`, () => {
      const cfg = mkCfg(r.gravity, 0, r.wind);
      const tank = mkTank(0, r.tank_x, r.tank_y, 0, r.angle);
      tank.guidance_target = null;
      tank.guidance_target_pt = r.pt === null ? null : (r.pt as [number, number]);
      const sol = guidance.solve_ballistic_power_launch(cfg, tank, ITEMS[0]);
      expect(sol === null ? -1 : sol).toBe(r.power);
    });
  }
});
