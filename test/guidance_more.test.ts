/**
 * Coverage mop-up (differential): the per-step steering GUARD branches and the
 * solve tgt-tank / "confused" paths that guidance.test.ts did not reach.
 *
 * Golden vectors come from oracle/dump_more.py -> oracle/vectors/guidance_more.json,
 * which drives the REAL scorch.guidance.apply / solve_ballistic_* over crafted
 * inputs. Each apply scenario carries its full SPEC (positions, velocities, the
 * hand-set guidance dict) so this test reconstructs the identical Projectile +
 * guidance state and asserts src/guidance.ts reproduces the post-apply snapshot.
 *
 * EPSILON: steered vx/vy/px/py are hypot/blend-derived -> toBeCloseTo(.,12);
 * the armed latch is exact; solve_ballistic_* return an integer power -> exact.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import * as guidance from "../src/guidance";
import { Projectile, Tank } from "../src/objects";
import { ITEMS } from "../src/weapons";
import { Config } from "../src/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "guidance_more.json");
const vec = JSON.parse(readFileSync(VECTORS, "utf-8"));
const EPS = 12;

interface TankSpec {
  x: number;
  y: number;
  team_id?: number;
  alive?: boolean;
  angle?: number;
  power?: number;
}
function mkTank(s: TankSpec): Tank {
  const t = new Tank(0, "T", 0, s.team_id ?? 0);
  t.x = s.x;
  t.y = s.y;
  t.alive = s.alive ?? true;
  if (s.angle !== undefined) t.angle = s.angle;
  if (s.power !== undefined) t.power = s.power;
  return t;
}

function mkCfg(gravity = 0.2, wind = 0): Config {
  const cfg = new Config();
  cfg.GRAVITY = gravity;
  cfg.AIR_VISCOSITY = 0;
  cfg.live_elastic = cfg.elastic;
  cfg.wind = wind;
  return cfg;
}

describe("guidance(more): apply() per-step steering guard branches", () => {
  for (const r of vec.apply) {
    const s = r.spec;
    it(`${s.label}`, () => {
      const owner = s.owner ? mkTank(s.owner) : null;
      const proj = new Projectile(
        owner,
        ITEMS[0],
        s.p0[0],
        s.p0[1],
        s.v0[0],
        s.v0[1],
      );
      const g = s.g;
      if (g === null) {
        proj.guidance = null;
      } else {
        const target = g.target ? mkTank(g.target) : null;
        let tanks: Tank[] | null = null;
        if (g.tanks_specs !== null && g.tanks_specs !== undefined) {
          const mapped = g.tanks_specs.map((t: TankSpec) => mkTank(t));
          tanks = g.tanks_include_owner && owner ? [owner, ...mapped] : mapped;
        } else if (g.tanks_include_owner && owner) {
          tanks = [owner];
        }
        proj.guidance = {
          type: g.type,
          target,
          point: g.point ?? null,
          tanks,
          armed: g.armed ?? false,
          _last_x: g._last_x ?? null,
          _last_y: g._last_y ?? null,
        };
      }
      guidance.apply(proj, mkCfg(), null);
      const [vx, vy, px, py, armed] = r.snap;
      expect(proj.vx, `${s.label} vx`).toBeCloseTo(vx, EPS);
      expect(proj.vy, `${s.label} vy`).toBeCloseTo(vy, EPS);
      expect(proj.px, `${s.label} px`).toBeCloseTo(px, EPS);
      expect(proj.py, `${s.label} py`).toBeCloseTo(py, EPS);
      const gg = proj.guidance as guidance.Guidance | null;
      expect(gg ? gg.armed : false, `${s.label} armed`).toBe(armed);
    });
  }
});

describe("guidance(more): solve_ballistic tgt-tank path + confused->1000", () => {
  for (const s of vec.solve) {
    it(`${s.label} (fn=${s.fn}) -> power ${s.power}`, () => {
      const cfg = mkCfg(s.gravity, s.wind);
      const tank = mkTank({ x: s.tank[0], y: s.tank[1], angle: s.angle });
      tank.guidance_target = mkTank({ x: s.tgt[0], y: s.tgt[1] });
      tank.guidance_target_pt = null;
      let res: number | null;
      if (s.fn === "power") {
        res = guidance.solve_ballistic_power(
          { cfg, w: 1024, h: 768 },
          tank,
          ITEMS[0],
        );
      } else {
        res = guidance.solve_ballistic_power_launch(cfg, tank, ITEMS[0]);
      }
      expect(res === null ? -1 : res, s.label).toBe(s.power);
    });
  }
});
