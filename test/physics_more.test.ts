/**
 * Coverage mop-up: the launch-time Ballistic POWER solve (selected_guidance==34)
 * and the live_elastic-absent fallback in handle_walls, both untouched by
 * physics.test.ts (which always passes an explicit power and always sets
 * cfg.live_elastic).
 *
 * The launch battery is differential vs oracle/dump_more.py (scorch.physics.launch
 * with a real ballistic solve). EPSILON: vx/vy/px/py are cos/sin-derived ->
 * toBeCloseTo(.,12); sx/sy integer pixel -> exact.
 *
 * The handle_walls fallback is a CONTRACT test (no oracle): with cfg.live_elastic
 * absent, src reads cfg.elastic; assert it produces byte-identical flight state to
 * the same shot with live_elastic explicitly set to cfg.elastic.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import * as physics from "../src/physics";
import { Projectile, Tank } from "../src/objects";
import { ITEMS } from "../src/weapons";
import { Config } from "../src/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "physics_more.json");
const vec = JSON.parse(readFileSync(VECTORS, "utf-8"));
const EPS = 12;

function mkCfg(gravity = 0.2, wind = 0): Config {
  const cfg = new Config();
  cfg.GRAVITY = gravity;
  cfg.AIR_VISCOSITY = 0;
  cfg.live_elastic = cfg.elastic;
  cfg.wind = wind;
  return cfg;
}

describe("physics(more): launch-time Ballistic power solve", () => {
  for (const r of vec.launch) {
    it(`${r.label}`, () => {
      const cfg = mkCfg(0.2, 0);
      const t = new Tank(0, "P0", 0, 0);
      t.x = r.tank[0];
      t.y = r.tank[1];
      t.angle = r.angle;
      t.power = 500;
      t.selected_guidance = r.guidance;
      t.guidance_target =
        r.tgt === null
          ? null
          : Object.assign(new Tank(1, "T", 0, 0), { x: r.tgt[0], y: r.tgt[1] });
      t.guidance_target_pt = null;
      const proj = physics.launch(t, cfg, ITEMS[r.weapon_idx], null, r.angle);
      const [vx, vy, px, py, sx, sy] = r.snap;
      expect(proj.vx, `${r.label} vx`).toBeCloseTo(vx, EPS);
      expect(proj.vy, `${r.label} vy`).toBeCloseTo(vy, EPS);
      expect(proj.px, `${r.label} px`).toBeCloseTo(px, EPS);
      expect(proj.py, `${r.label} py`).toBeCloseTo(py, EPS);
      expect(proj.sx, `${r.label} sx`).toBe(sx);
      expect(proj.sy, `${r.label} sy`).toBe(sy);
    });
  }

  it("angle omitted (null) uses the tank's current firing angle", () => {
    // Covers the `if (angle === null) angle = tank.angle` default: an explicit
    // angle equal to tank.angle must produce byte-identical launch state.
    const cfg = mkCfg(0.2, 0);
    const t = new Tank(0, "P0", 0, 0);
    t.x = 300;
    t.y = 500;
    t.angle = 37;
    t.power = 640;
    const a = physics.launch(t, cfg, ITEMS[0], 640, null);
    const b = physics.launch(t, cfg, ITEMS[0], 640, 37);
    expect([a.vx, a.vy, a.px, a.py, a.sx, a.sy]).toEqual([
      b.vx,
      b.vy,
      b.px,
      b.py,
      b.sx,
      b.sy,
    ]);
    // sanity: a non-trivial 37-degree shot, not the (cos45) default.
    expect(a.vx).toBeGreaterThan(0);
  });

  it("launch_ballistic_solved differs from the un-guided (tank.power) shot", () => {
    // Guard against a no-op: the solved power must move vx away from the
    // power=500 baseline, proving the solve branch actually ran.
    const solved = vec.launch.find(
      (r: { label: string }) => r.label === "launch_ballistic_solved",
    );
    const baseline = vec.launch.find(
      (r: { label: string }) => r.label === "launch_ballistic_no_target",
    );
    expect(solved.snap[0]).not.toBeCloseTo(baseline.snap[0], 3);
  });
});

describe("physics(more): handle_walls falls back to cfg.elastic when live_elastic absent", () => {
  it("live_elastic-absent == live_elastic set to cfg.elastic (RUBBER floor bounce)", () => {
    function run(deleteLive: boolean): [boolean, number, number, number, number, number] {
      const cfg = mkCfg();
      cfg.ELASTIC = "RUBBER"; // enum index 3
      // re-derive elastic getter base; live_elastic mirrors __post_init__
      cfg.live_elastic = cfg.elastic;
      if (deleteLive) {
        delete (cfg as unknown as { live_elastic?: number }).live_elastic;
      }
      const p = new Projectile(null, ITEMS[0], 100.0, 150 + 1, 5.0, -200.0);
      p.guidance = null;
      const alive = physics.handle_walls(p, cfg, 200, 150);
      return [alive, p.px, p.py, p.vx, p.vy, p.bounce_count];
    }
    const withLive = run(false);
    const noLive = run(true);
    expect(noLive).toEqual(withLive);
    // and the bounce actually happened (not a degenerate both-null compare)
    expect(withLive[5]).toBe(1);
    expect(withLive[0]).toBe(true);
  });
});
