/**
 * Coverage mop-up: real-flight edges weapon_behaviors.test.ts's per-case vectors
 * never hit -- the laser CUTTING dirt, the plasma-laser EMPTY-trail terminus, the
 * plasma_laser detonator dispatch, and the roller's field-edge / steep-drop steps.
 *
 * No clean numeric oracle (these are terrain-state machines); assertions follow
 * the documented control flow, which mirrors scorch/weapon_behaviors.py verbatim
 * (read directly): laser cuts dirt to COL_SKY and records a beam; the roller
 * resolves (detonates, goes inactive) at the wall and descends a steep drop.
 */
import { describe, it, expect } from "vitest";
import * as wb from "../src/weapon_behaviors";
import type { BState, BProjectile } from "../src/weapon_behaviors";
import { Rng } from "../src/rng";
import * as C from "../src/constants";
import { ITEMS, Item } from "../src/weapons";

const key = (x: number, y: number) => `${x},${y}`;

class Terrain {
  w: number;
  h: number;
  grid = new Map<string, number>();
  carve_circles: number[][] = [];
  carve_wedges: number[][] = [];
  deposit_circles: number[][] = [];
  settles: Array<[number, number | null]> = [];
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
  }
  /** fill a column with dirt from `top` down to the floor. */
  fillColumn(x: number, top: number): void {
    for (let y = top; y < this.h; y++) this.grid.set(key(x, y), C.COL_DIRT);
  }
  read(x: number, y: number): number {
    if (0 <= x && x < this.w && 0 <= y && y < this.h)
      return this.grid.get(key(x, y)) ?? C.COL_SKY;
    return C.COL_SKY;
  }
  write(x: number, y: number, color: number): void {
    if (0 <= x && x < this.w && 0 <= y && y < this.h) this.grid.set(key(x, y), color);
  }
  is_dirt(x: number, y: number): boolean {
    return C.is_dirt(this.read(x, y));
  }
  is_solid(x: number, y: number): boolean {
    return C.is_solid(this.read(x, y));
  }
  column_top(x: number): number {
    if (!(0 <= x && x < this.w)) return this.h;
    for (let y = 0; y < this.h; y++) if (this.is_solid(x, y)) return y;
    return this.h;
  }
  carve_circle(cx: number, cy: number, r: number): void {
    this.carve_circles.push([Math.trunc(cx), Math.trunc(cy), Math.trunc(r)]);
  }
  carve_wedge(...a: number[]): void {
    this.carve_wedges.push(a.map(Math.trunc));
  }
  deposit_circle(cx: number, cy: number, r: number): void {
    this.deposit_circles.push([Math.trunc(cx), Math.trunc(cy), Math.trunc(r)]);
  }
  settle(_cfg: unknown, _rng: unknown, a: number, b: number): void {
    this.settles.push([a, b]);
  }
}

class State {
  cfg = { is_on: (_k: string) => false };
  terrain: Terrain;
  tanks: unknown[] = [];
  rng = new Rng(0);
  explosion_scale = 1.0;
  projectiles: unknown[] = [];
  current_weapon: unknown = null;
  current_shooter: unknown = null;
  economy = { unit_price: (s: number) => s };
  explosions: Array<[number, number, number]> = [];
  plasma_rings: number[][] = [];
  beams: Array<Array<[number, number]>> = [];
  constructor(terrain: Terrain) {
    this.terrain = terrain;
  }
  add_explosion(x: number, y: number, r: number): void {
    this.explosions.push([Math.trunc(x), Math.trunc(y), Math.trunc(r)]);
  }
  add_plasma_ring(x: number, y: number, r: number): void {
    this.plasma_rings.push([x, y, r]);
  }
  add_beam(pts: Array<[number, number]>): void {
    this.beams.push(pts.map((p) => [p[0], p[1]] as [number, number]));
  }
  on_tank_destroyed(): void {}
}

function mkProj(
  weapon: Item,
  o: { px?: number; py?: number; vx?: number; vy?: number; state?: Record<string, unknown> } = {},
): BProjectile {
  return {
    weapon,
    px: o.px ?? 100,
    py: o.py ?? 100,
    vx: o.vx ?? 0,
    vy: o.vy ?? 0,
    state: o.state ?? {},
    trail: [],
    active: true,
  } as unknown as BProjectile;
}

const ROLLER = ITEMS[13]; // behavior "roller"
const PLASMA_LASER = new Item(99, "PlasmaLaser", 0, 1, 0, "energy", {
  behavior: "plasma_laser",
  blast: 40,
});

describe("weapon_behaviors(more): plasma_laser detonator dispatch", () => {
  it("detonate() routes behavior 'plasma_laser' to a plasma burst", () => {
    const t = new Terrain(360, 480);
    const st = new State(t) as unknown as BState;
    const proj = mkProj(PLASMA_LASER, { px: 200, py: 300 });
    wb.detonate(st, proj, 200, 300);
    // _det_plasma_laser -> _det_plasma: a real burst (explosion and/or ring), and
    // the current weapon latched for the death-crater radius.
    const s = st as unknown as State;
    expect(s.explosions.length + s.plasma_rings.length).toBeGreaterThan(0);
    expect((st.current_weapon as Item).behavior).toBe("plasma_laser");
  });
});

describe("weapon_behaviors(more): step_roller field-edge and steep-drop", () => {
  it("resolves (detonates, goes inactive) at the field wall", () => {
    const t = new Terrain(20, 100);
    for (let x = 0; x < 20; x++) t.fillColumn(x, 60);
    const st = new State(t) as unknown as BState;
    const proj = mkProj(ROLLER, { px: 18, py: 59, state: { dir: 1 } });
    const live = wb.step_roller(st, proj); // nx = 19 >= w-1 -> resolve
    expect(live).toBe(false);
    expect(proj.active).toBe(false);
    expect((st as unknown as State).explosions.length).toBeGreaterThan(0);
  });

  it("descends a steep drop ahead (keeps rolling onto the lower surface)", () => {
    const t = new Terrain(60, 200);
    t.fillColumn(30, 100); // here: surface row 100
    t.fillColumn(31, 130); // ahead: surface row 130 (> 100 + 6) -> steep drop
    const st = new State(t) as unknown as BState;
    const proj = mkProj(ROLLER, { px: 30, py: 99, state: { dir: 1 } });
    const live = wb.step_roller(st, proj);
    expect(live).toBe(true); // not resolved: it fell to the lower shelf
    expect(proj.px).toBe(31);
    expect(proj.py).toBe(129); // surf - 1 = column_top(31) - 1
  });
});

describe("weapon_behaviors(more): laser cuts dirt; plasma-laser empty-trail terminus", () => {
  it("fire_laser carves dirt cells along the beam to COL_SKY and records a beam", () => {
    const t = new Terrain(360, 480);
    for (let x = 10; x < 60; x++) t.write(x, 100, C.COL_DIRT); // dirt along y=100
    const st = new State(t) as unknown as BState;
    // energy bleeds 0x28 (40)/px, so a 50px march needs ~2000 energy.
    const proj = mkProj(ITEMS[32], { px: 10, py: 100, vx: 1, vy: 0, state: { energy: 2000 } });
    expect(t.is_dirt(15, 100)).toBe(true);
    wb.fire_laser(st, proj);
    // a horizontal beam from x=10 cut the dirt it crossed to sky.
    expect(t.read(15, 100)).toBe(C.COL_SKY);
    expect((st as unknown as State).beams.length).toBe(1);
    expect((st as unknown as State).beams[0].length).toBeGreaterThan(0);
    expect(proj.active).toBe(false);
  });

  it("fire_plasma_laser falls back to (px,py) when the beam yields no trail", () => {
    const t = new Terrain(360, 480);
    const st = new State(t) as unknown as BState;
    // start off-field: the laser march loop never runs -> empty trail.
    const proj = mkProj(PLASMA_LASER, { px: -5, py: 100, vx: 1, vy: 0, state: { energy: 50 } });
    wb.fire_plasma_laser(st, proj);
    expect(proj.trail.length).toBe(0);
    // the plasma burst still happened at the (truncated) projectile position.
    const s = st as unknown as State;
    expect(s.explosions.length + s.plasma_rings.length).toBeGreaterThan(0);
  });
});
