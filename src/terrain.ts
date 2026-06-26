/**
 * Terrain: the destructible dirt layer as a pixel framebuffer -- a faithful
 * TypeScript port of scorch-py/scorch/terrain.py (the fidelity oracle, itself
 * verified against the DOS binary). Control flow, RNG draw order, and numeric
 * behavior are identical to the Python; the differential gate
 * (test/terrain.test.ts) asserts every result against Python-dumped vectors.
 *
 * Key architectural finding (catalog 11 section 2.1): there is NO height array.
 * Terrain lives as pixels; "dirt" is any pixel whose palette index is in the dirt
 * band (0x50, 0x58..0x68). Here the framebuffer is a (W,H) uint8 index plane -
 * exactly the VGA framebuffer - and read/write-pixel are array indexing
 * (the DAT_5f38_eef8/eef4 indirection).
 *
 * Generation = 1D midpoint displacement (MECHANICS addenda), optionally replaced
 * by a scanned .MTN range with probability MTN_PERCENT. One filled-circle
 * primitive both carves craters (clears dirt) and deposits dirt, switched by color
 * (catalog 11 section 2.3/2.4). Dirt settle = per-column gravity (section 2.5).
 *
 * STORAGE NOTE: the Python uses a numpy (W,H) uint8 array indexed grid[x, y].
 * Here grid is a single Uint8Array of length w*h in COLUMN-MAJOR order
 * (grid[x*h + y]), so a "column" grid[x] is the contiguous slice
 * [x*h .. x*h + h). This matches numpy's grid[x] row (a length-h view) and keeps
 * every per-column scan a contiguous walk, exactly as the Python column code does.
 *
 * NUMERIC NOTE: all height/index/pixel/boolean outputs are integers and asserted
 * EXACT. The only transcendental site is carve_wedge (math.cos/sin via
 * Math.cos/sin); its outputs are integer pixel writes, so they are asserted exact
 * too -- see test/terrain.test.ts for the libm-vs-V8 note.
 */
import * as C from "./constants";
import { surfaceProfile } from "./mtn";

/**
 * The subset of the game Config that terrain reads. The full Config lives in
 * src/config.ts (owned elsewhere); terrain only ever touches these fields/method,
 * so we depend on this minimal shape rather than the whole class. `is_on(key)`
 * mirrors Config.is_on: str(getattr(self,key)).upper() == "ON".
 */
export interface TerrainCfg {
  MTN_PERCENT: number;
  LAND1: number;
  LAND2: number;
  SUSPEND_DIRT: number;
  is_on(key: string): boolean;
}

/** RNG surface terrain uses (scorch.rng.Rng): pick / chance / uniform. */
export interface TerrainRng {
  pick(n: number): number;
  chance(num: number, den: number): boolean;
  uniform(a: number, b: number): number;
}

/** A loaded/decoded .MTN, addressable for _from_mtn. The Python takes a path and
 * calls port.mtn.surface_profile(path); the browser build pre-fetches the bytes,
 * so a "path" here is a label plus the raw file bytes. */
export interface MtnFile {
  /** label (mirrors the Python file path; used only for messages). */
  name: string;
  /** raw .MTN file bytes. */
  data: Uint8Array;
}

/**
 * Python's int(round(x)) -- round-half-to-even (banker's rounding), then truncate
 * toward zero. JS Math.round is round-half-up and differs on exact .5 values, so
 * _rasterize (the one round() site) must use this, not Math.round.
 */
function pyRoundToEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  // exactly .5 -> round to even
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python int(x): truncate toward zero (matches numpy int cast on a float). */
function trunc(x: number): number {
  return Math.trunc(x);
}

/**
 * numpy.linspace(start, stop, num) with endpoint=True. For num>1:
 * step = (stop-start)/(num-1); result[i] = start + i*step; result[-1] = stop
 * (numpy pins the last sample to stop exactly). For num==1: [start].
 * Verified bit-exact against numpy across the .MTN width/playfield batteries.
 */
function linspace(start: number, stop: number, num: number): Float64Array {
  const out = new Float64Array(num);
  if (num <= 0) return out;
  /* v8 ignore next 4 -- unreachable: the sole caller (_from_mtn L358) passes num=this.w only on the narrow-MTN scale-up branch (mw<this.w), which requires this.w>=2; mw>=1>=this.w otherwise takes the slice branch, so num is never 1. */
  if (num === 1) {
    out[0] = start;
    return out;
  }
  const step = (stop - start) / (num - 1);
  for (let i = 0; i < num; i++) out[i] = start + i * step;
  out[num - 1] = stop;
  return out;
}

/**
 * numpy.interp(x, xp, fp) for a strictly increasing xp. Per point: clamp to the
 * endpoints, else find j = (searchsorted(xp, xv, side='right') - 1), the index of
 * the interval start, and linearly interpolate
 *   slope = (fp[j+1]-fp[j]) / (xp[j+1]-xp[j]);  res = slope*(xv-xp[j]) + fp[j].
 * Verified bit-exact against numpy.interp on a real .MTN slice (xp = arange(mw)).
 */
function interp(x: Float64Array, xp: number[] | Float64Array, fp: number[] | Float64Array): Float64Array {
  const n = xp.length;
  const out = new Float64Array(x.length);
  const xp0 = xp[0];
  const xpLast = xp[n - 1];
  const fp0 = fp[0];
  const fpLast = fp[n - 1];
  for (let i = 0; i < x.length; i++) {
    const xv = x[i];
    if (xv <= xp0) {
      out[i] = fp0;
      continue;
    }
    if (xv >= xpLast) {
      out[i] = fpLast;
      continue;
    }
    // searchsorted(side='right'): first index where xp[idx] > xv; j = that - 1.
    let lo = 0;
    let hi = n; // [lo, hi)
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (xp[mid] <= xv) lo = mid + 1;
      else hi = mid;
    }
    let j = lo - 1;
    if (j < 0) j = 0;
    /* v8 ignore next 4 -- unreachable: xv>=xpLast returns at L122, so values reaching here have xv<xpLast => the right-bisect gives lo<=n-1 => j=lo-1<=n-2; j>=n-1 cannot occur. */
    if (j >= n - 1) {
      out[i] = fpLast;
      continue;
    }
    const slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
    out[i] = slope * (xv - xp[j]) + fp[j];
  }
  return out;
}

export class Terrain {
  readonly w: number;
  readonly h: number;
  /** grid[x*h + y] = palette index. Column-major; column x = [x*h .. x*h+h). */
  grid: Uint8Array;

  constructor(width: number, height: number) {
    this.w = width;
    this.h = height;
    this.grid = new Uint8Array(width * height); // numpy zeros((w,h), uint8)
  }

  // ---- pixel access (DAT_5f38_eef8 / eef4) ----
  read(x: number, y: number): number {
    if (0 <= x && x < this.w && 0 <= y && y < this.h) {
      return this.grid[x * this.h + y];
    }
    return C.COL_SKY;
  }

  write(x: number, y: number, color: number): void {
    if (0 <= x && x < this.w && 0 <= y && y < this.h) {
      this.grid[x * this.h + y] = color;
    }
  }

  is_dirt(x: number, y: number): boolean {
    return C.is_dirt(this.read(x, y));
  }

  is_solid(x: number, y: number): boolean {
    return C.is_solid(this.read(x, y));
  }

  drop_to_footprint(cx: number, half_width: number): number {
    /* Seat row for a tank at column `cx`. FACT, FUN_33a1_08e7 (the conform that
       actually WRITES the placed tank's y at tank+0x10, 08e7:36): it seats on the
       CENTER column -- scan UP from the floor DAT_5f38_ef38 at x=tank+0xe to the
       first non-dirt row (08e7:20-36), i.e. column_top(cx)-1 -- then
       level_under_tank flattens the [-half_width..+half_width] footprint to that
       height (the carve / fill loops 08e7:38-75). So the placed y is the
       center-column surface, NOT a full-footprint support test. column_top()
       already skips a top-attached CAVERN ceiling, so this seats on the floor
       below the roof, never inside it.

       REGRESSION FIXED (user Image #1): a prior rewrite required the ENTIRE
       footprint be dirt-below AND sky-at-row simultaneously. Those two clauses are
       unsatisfiable on any non-flat footprint -- a column over a peak is solid at
       every row below its own surface -- so the scan fell through to `self.h - 2`
       and every tank spawned on the screen floor under a full column of dirt.
       FUN_4a4c_0fbf's full-footprint drop is the post-fall SETTLE, not the
       placement y-setter; conform overwrites that y with the center seat. */
    return Math.max(2, Math.min(this.h - 2, this.column_top(cx) - 1));
  }

  column_top(x: number): number {
    /* GROUND surface row of a column: the topmost dirt that has open sky ABOVE it.
       A top-attached solid band (the CAVERN ceiling stamped by
       hazard.install_cavern_ceiling) is SKIPPED, so tanks and shells use the floor
       below it, not the roof -- otherwise placement dropped tanks at y=2 INSIDE the
       cavern ceiling (a round could start with an instant loss). Returns self.h for
       an empty or fully-filled column. */
    if (!(0 <= x && x < this.w)) {
      return this.h;
    }
    const h = this.h;
    const base = x * h;
    const grid = this.grid;
    // solid[y] = (col==COL_DIRT) | (DIRT_SHADE_LO <= col <= DIRT_SHADE_HI)
    const isSolidAt = (y: number): boolean => {
      const v = grid[base + y];
      return v === C.COL_DIRT || (v >= C.DIRT_SHADE_LO && v <= C.DIRT_SHADE_HI);
    };
    if (!isSolidAt(0)) {
      // normal: sky at the top. idx = argmax(solid) over the FULL column = first
      // solid row (absolute), or 0 if the whole column is sky.
      const idx = this._argmaxSolid(base, 0, h, false);
      return isSolidAt(idx) ? idx : h;
    }
    // column starts solid (cavern ceiling): skip it + the sky gap to the ground.
    // gap = argmax(~solid) over the FULL column = first sky row (absolute).
    const gap = this._argmaxSolid(base, 0, h, true);
    if (isSolidAt(gap)) {
      // np.argmax(~solid) returned 0 because there is no sky at all -> fully filled.
      return h;
    }
    // Python: sub = solid[gap:]; idx = argmax(sub) (RELATIVE); return gap + idx.
    // _argmaxSolid(base, gap, h, false) already returns the ABSOLUTE row of the
    // first solid in [gap, h) (= gap + that relative idx), so return it directly --
    // do NOT add gap again. The guard reproduces `if sub[idx]` (else self.h).
    const idxAbs = this._argmaxSolid(base, gap, h, false);
    return isSolidAt(idxAbs) ? idxAbs : h;
  }

  /**
   * Absolute row index of the first set bit of the boolean solid mask of column
   * `base` on rows [start, end), matching np.argmax of that slice OFFSET BY start:
   * np.argmax(solid[start:end]) is relative, so the absolute index is start + that;
   * this returns that absolute index directly (or `start` when the whole range is
   * uniform -- numpy argmax of all-equal returns 0 = the first element = row
   * `start`). When `wantSky` is true the mask is ~solid (first sky row).
   */
  private _argmaxSolid(base: number, start: number, end: number, wantSky: boolean): number {
    const grid = this.grid;
    for (let y = start; y < end; y++) {
      const v = grid[base + y];
      const solid = v === C.COL_DIRT || (v >= C.DIRT_SHADE_LO && v <= C.DIRT_SHADE_HI);
      const bit = wantSky ? !solid : solid;
      if (bit) return y;
    }
    return start; // all False -> argmax == 0 (the first element of the range)
  }

  // ---- generation ----
  generate(cfg: TerrainCfg, rng: TerrainRng, mtnFiles?: MtnFile[] | null): void {
    this.grid.fill(C.COL_SKY);
    // Use the real scanned .MTN mountains when available (the user-chosen terrain
    // source); MTN_PERCENT gates the blend with procedural land, but default to
    // mountains-present when files exist.
    let heights: number[] | null = null;
    if (mtnFiles && mtnFiles.length > 0) {
      const pct = Math.max(trunc(cfg.MTN_PERCENT), 60); // favor real mountains
      if (rng.chance(pct, 100)) {
        const path = mtnFiles[rng.pick(mtnFiles.length)];
        heights = this._from_mtn(path, rng);
      }
    }
    if (heights === null) {
      heights = this._midpoint(cfg, rng);
    }
    this._rasterize(heights, rng);
  }

  _midpoint(cfg: TerrainCfg, rng: TerrainRng): number[] {
    const w = this.w;
    const h = this.h;
    const heights = new Array<number>(w).fill(0.0);
    // Slope (LAND2): endpoint height difference; Bumpiness (LAND1): roughness.
    let bump: number;
    let slope: number; // bound but no longer tilts (see below)
    let flat: boolean;
    if (cfg.is_on("RANDOM_LAND")) {
      bump = 100;
      slope = 50;
      flat = false;
    } else {
      bump = cfg.LAND1;
      slope = cfg.LAND2;
      flat = cfg.is_on("FLATLAND");
    }
    void slope; // matches Python: `slope` is left bound but no longer tilts.
    // FULL MOUNTAINS: large vertical relief so peaks reach the top of the
    // (tall 360x480) screen and valleys drop near the floor. Bumpiness adds
    // amplitude; Slope tilts the baseline.
    const base = h * 0.55;
    const amp = (0.45 + (bump / 100.0) * 0.45) * h; // peak-to-baseline relief
    // EQUAL endpoints: the binary builds the heightfield with
    // FUN_2d4f_0645(iVar1, iVar1, ...), so cf60[0] == cf60[last] -- the recovered
    // midpoint generator (FUN_2d4f_071d/_0645) has NO slope/tilt term. The prior
    // slope_amt (driven by LAND2, FORCED to 50 under RANDOM_LAND) invented the
    // near-monotonic sky-to-dirt diagonal ramp the binary cannot produce (the
    // user's Image #4). FLAG: LAND2/Slope's real effect, if any, lives in the
    // unrecovered terrain-style layer (FUN_323a_* vtable build); this matches the
    // recovered generator core only. `slope` is left bound but no longer tilts.
    heights[0] = base;
    heights[w - 1] = base;
    const rough = amp;

    const disp = (l: number, r: number, rgh: number): void => {
      if (r - l < 2) {
        return;
      }
      const m = Math.floor((l + r) / 2); // (l + r) // 2
      heights[m] = (heights[l] + heights[r]) / 2.0 + rng.uniform(-1.0, 1.0) * rgh;
      disp(l, m, rgh * 0.58); // >0.5 keeps rugged mountain detail
      disp(m, r, rgh * 0.58);
    };

    disp(0, w - 1, rough);

    const top_margin = h * 0.05; // peaks may climb near the top
    const floor = h - 2;
    const peak_cap = h * 0.28; // FLATLAND clamps peaks
    for (let x = 0; x < w; x++) {
      let hh = heights[x];
      if (flat && hh < peak_cap) {
        hh = peak_cap;
      }
      heights[x] = Math.min(floor, Math.max(top_margin, hh));
    }
    return heights;
  }

  _from_mtn(path: MtnFile, rng: TerrainRng): number[] {
    /* Surface heights from a real scanned .MTN file (port.mtn decoder).
       The .MTN silhouette (surface row per column, 0..mtn_height) is windowed /
       scaled to the playfield width and mapped into the screen's vertical play
       area so peaks rise high and valleys drop toward the floor. */
    const prof = surfaceProfile(path.data, path.name);
    // native per-column top row, as float
    const surfInt = prof.surface; // Int32Array length width
    const mw = prof.width;
    const surf = new Float64Array(mw);
    for (let i = 0; i < mw; i++) surf[i] = surfInt[i];

    let samp: Float64Array;
    if (mw >= this.w) {
      // wide range -> random slice
      const start = rng.pick(mw - this.w + 1);
      samp = surf.subarray(start, start + this.w);
    } else {
      // narrow -> scale up
      const xs = linspace(0, mw - 1, this.w);
      const xpGrid = new Float64Array(mw);
      for (let i = 0; i < mw; i++) xpGrid[i] = i; // np.arange(mw)
      samp = interp(xs, xpGrid, surf);
    }
    // samp is already float (np.asarray(samp, dtype=float)).
    // NORMALIZE the slice into the screen's play band. The raw .MTN surface_row
    // (= mtn height - column count) is tiny or even NEGATIVE for very tall columns;
    // the old absolute map (samp / mh) turned those into dirt from row 0, so tanks
    // spawned at y=2 on an 80%-dirt wall and a round could start with an instant
    // loss. Per-slice min(tallest)->peak near the top, max(shortest)->valley near
    // the floor, guaranteeing a varied, playable surface every round with sky
    // headroom at the top.
    const top = this.h * 0.12;
    const floor = this.h - 2;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < samp.length; i++) {
      const v = samp[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    lo = lo; // float(samp.min())
    hi = hi; // float(samp.max())
    const heights = new Array<number>(samp.length);
    if (hi - lo < 1e-6) {
      // flat slice -> low plateau: np.full_like(samp, 0.6) then top + 0.6*(floor-top)
      const v = top + 0.6 * (floor - top);
      for (let i = 0; i < samp.length; i++) heights[i] = v;
    } else {
      const span = hi - lo;
      const range = floor - top;
      for (let i = 0; i < samp.length; i++) {
        const norm = (samp[i] - lo) / span;
        heights[i] = top + norm * range;
      }
    }
    return heights;
  }

  _rasterize(heights: number[], rng: TerrainRng): void {
    /* Fill SOLID dirt from each column's surface down to the floor, shaded by
       depth (light crust -> mid body -> darker base). Not per-pixel random (that
       rendered as noise); the original fills solid earth with a crust. */
    void rng; // signature parity with Python (unused; no per-pixel randomness)
    const h = this.h;
    const crust = C.DIRT_SHADE_HI; // 0x68 bright surface crust
    const body = C.DIRT_SHADE_LO + 8; // 0x60 mid dirt
    const deep = C.DIRT_SHADE_LO + 3; // 0x5b darker at depth
    const grid = this.grid;
    for (let x = 0; x < this.w; x++) {
      const top = Math.max(0, Math.min(h - 1, pyRoundToEven(heights[x])));
      const n = h - top;
      /* v8 ignore next 3 -- unreachable: top is clamped to [0, h-1] above, so n = h - top >= 1 always; n <= 0 cannot occur (h >= 1 for any constructed terrain). */
      if (n <= 0) {
        continue;
      }
      const colBase = x * h;
      // col[top:h] = body
      for (let y = top; y < h; y++) grid[colBase + y] = body;
      // darken the lower third: mid = top + (n * 2) // 3
      const mid = top + Math.floor((n * 2) / 3);
      if (mid < h) {
        for (let y = mid; y < h; y++) grid[colBase + y] = deep;
      }
      // 2px bright crust at the surface: col[top:min(h, top+2)] = crust
      const crustEnd = Math.min(h, top + 2);
      for (let y = top; y < crustEnd; y++) grid[colBase + y] = crust;
    }
  }

  // ---- destruction primitives (shared filled circle, switched by color) ----
  /**
   * The Python _circle_mask returns (x0,x1,y0,y1, mask) where mask is a boolean
   * (x,y)-ordered sub-array: mask[i][j] true iff ((x0+i)-cx)^2 + ((y0+j)-cy)^2 <=
   * r^2. Here we expose a predicate evaluated inline at each cell (same test),
   * plus the clip rect, since TS has no numpy broadcast. Returns null when the clip
   * rect is empty (matches Python's `return None`).
   */
  private _circleRect(cx: number, cy: number, r: number): [number, number, number, number] | null {
    const x0 = Math.max(0, cx - r);
    const x1 = Math.min(this.w, cx + r + 1);
    const y0 = Math.max(0, cy - r);
    const y1 = Math.min(this.h, cy + r + 1);
    if (x0 >= x1 || y0 >= y1) {
      return null;
    }
    return [x0, x1, y0, y1];
  }

  clear_index_band(lo: number, hi: number, fill: number | null = null): void {
    /* Reset every pixel whose index is in [lo..hi] back to `fill` (default sky).
       Used to retire the digger trail glow band (0xAF..0xB8) once its palette cycle
       ends: FUN_352c_00c9.c:143-152 sweeps the bored columns and restores the
       carved cells via the background renderer (FUN_42c2_1519), so the tunnel reads
       as empty bore, not as a solid glow band, afterwards. */
    const f = fill === null ? C.COL_SKY : fill;
    const grid = this.grid;
    // band = (grid >= lo) & (grid <= hi); if band.any(): grid[band] = fill
    for (let i = 0; i < grid.length; i++) {
      const v = grid[i];
      if (v >= lo && v <= hi) grid[i] = f;
    }
  }

  carve_circle(cx: number, cy: number, r: number): void {
    /* Crater: clear dirt pixels in the circle (set to sky). */
    const ri = trunc(r);
    const rect = this._circleRect(cx, cy, ri);
    if (!rect) {
      return;
    }
    const [x0, x1, y0, y1] = rect;
    const rr = ri * ri;
    const h = this.h;
    const grid = this.grid;
    for (let x = x0; x < x1; x++) {
      const dx = x - cx;
      const dx2 = dx * dx;
      const colBase = x * h;
      for (let y = y0; y < y1; y++) {
        const dy = y - cy;
        if (dx2 + dy * dy <= rr) {
          const v = grid[colBase + y];
          const dirt = v === C.COL_DIRT || (v >= C.DIRT_SHADE_LO && v <= C.DIRT_SHADE_HI);
          if (dirt) grid[colBase + y] = C.COL_SKY;
        }
      }
    }
  }

  deposit_circle(cx: number, cy: number, r: number): void {
    /* Dirt weapon: stamp a sphere of dirt (same circle, dirt color). */
    const ri = trunc(r);
    const rect = this._circleRect(cx, cy, ri);
    if (!rect) {
      return;
    }
    const [x0, x1, y0, y1] = rect;
    const rr = ri * ri;
    const fill = C.DIRT_SHADE_LO + 8; // solid mid dirt (not per-pixel noise)
    const h = this.h;
    const grid = this.grid;
    for (let x = x0; x < x1; x++) {
      const dx = x - cx;
      const dx2 = dx * dx;
      const colBase = x * h;
      for (let y = y0; y < y1; y++) {
        const dy = y - cy;
        if (dx2 + dy * dy <= rr) {
          grid[colBase + y] = fill;
        }
      }
    }
  }

  level_under_tank(cx: number, seat_y: number, half_width: number): void {
    /* Conform the terrain to the tank: carve a flat seat so the tank body sits
       level even on a slope (the "notch" under each tank). FACT, byte for byte from
       FUN_33a1_08e7 ("conform tank to terrain"), called from the per-round
       placement FUN_33a1_0a43 after the drop-settle FUN_4a4c_0fbf:

         - seat_y = ground top under the tank CENTER column (08e7:21-36 scans up
           from the floor at x=cx while dirt 0x50..0x68; the first sky row is the
           seat). The port already computes this as column_top(cx)-1, passed in.
         - CARVE: across the footprint [cx-half_width .. cx+half_width], every dirt
           pixel AT OR ABOVE seat_y is erased to sky (08e7:37-56). Removes the
           high-side dirt that would otherwise bury the level base.
         - FILL: across the same span, every sky pixel BELOW seat_y down to the
           floor is filled with dirt (08e7:57-75). Plugs the low-side gap so the
           shelf is solid up to the seat.

       The binary's two loops SHORT-CIRCUIT on the first all-clear (carve) /
       all-solid (fill) row, so the carve never reaches a detached cavern ceiling
       and the fill never runs past the existing surface to the floor. The
       per-column form below restores the short-circuit. half_width = 7
       (objects.py:78, tank+0x08), so the footprint is 15px. */
    const x0 = Math.max(0, cx - half_width);
    const x1 = Math.min(this.w, cx + half_width + 1);
    if (x0 >= x1) {
      return;
    }
    const h = this.h;
    const seat = Math.max(0, Math.min(h - 1, trunc(seat_y)));
    const DIRT = C.DIRT_SHADE_LO + 8;
    const reach = Math.max(8, 2 * half_width + 2); // bound: only the immediate notch
    const grid = this.grid;

    const isDirtVal = (v: number): boolean => {
      return v === C.COL_DIRT || (C.DIRT_SHADE_LO <= v && v <= C.DIRT_SHADE_HI);
    };

    for (let x = x0; x < x1; x++) {
      const colBase = x * h;
      // carve the high-side bump down to the shelf: walk UP from the seat erasing
      // CONTIGUOUS dirt, stopping at the first sky (never punches a detached
      // ceiling), bounded by reach.
      let yy = seat;
      const lo = Math.max(0, seat - reach);
      while (yy >= lo && isDirtVal(grid[colBase + yy])) {
        grid[colBase + yy] = C.COL_SKY;
        yy -= 1;
      }
      // fill the low-side gap up to the shelf: walk DOWN from seat+1 depositing over
      // CONTIGUOUS sky, stopping at the first dirt (never pillars past the surface),
      // bounded by reach.
      yy = seat + 1;
      const hi = Math.min(h, seat + 1 + reach);
      while (yy < hi && !isDirtVal(grid[colBase + yy])) {
        grid[colBase + yy] = DIRT;
        yy += 1;
      }
    }
  }

  carve_wedge(cx: number, cy: number, r: number, half_angle_deg = 45, aim_deg = 90): void {
    /* Riot Charge/Blast: clear a wedge of dirt CENTERED ON THE TURRET AIM.
       Byte-exact geometry (RECOVERED_FP.md T1, FUN_3f76_000d + tables
       5f38:60f8/60fc): angular span [aim-H, aim+H], radial extent r rings.
       H = 45deg (Riot Charge) / 60deg (Riot Blast); aim_deg = the firing tank's
       turret angle (0=E, 90=up, 180=W). Default aim 90 = straight up.

       NUMERIC: cos/sin via Math.cos/Math.sin. Outputs are integer pixel writes
       (int(cx + cos*rr)); the differential test asserts the resulting grid exactly.
       See test/terrain.test.ts for the libm-vs-V8 note.

       math.radians/math.degrees: CPython computes these as a SINGLE multiply by a
       precomputed constant (degToRad = pi/180, radToDeg = 180/pi), NOT x*pi/180.
       The two-op form rounds differently and flips trunc(degrees(a1-a0)) (the spoke
       count `steps`) by 1 on boundary cases (e.g. aim=135,H=60 -> 119 vs 120;
       H=1 -> 1 vs 2), shifting EVERY spoke. Use the exact CPython constants. */
    const DEG_TO_RAD = 0.017453292519943295; // CPython degToRad = pi/180
    const RAD_TO_DEG = 57.29577951308232; // CPython radToDeg = 180/pi
    const a0 = (aim_deg - half_angle_deg) * DEG_TO_RAD; // math.radians
    const a1 = (aim_deg + half_angle_deg) * DEG_TO_RAD;
    const steps = Math.max(1, trunc((a1 - a0) * RAD_TO_DEG)); // ~1deg spokes; math.degrees
    const rInt = trunc(r);
    for (let k = 0; k <= steps; k++) {
      const ang = a0 + ((a1 - a0) * k) / steps;
      const dxu = Math.cos(ang);
      const dyu = -Math.sin(ang); // screen-up = -sin (y grows down)
      for (let rr = 1; rr <= rInt; rr++) {
        const px = trunc(cx + dxu * rr);
        const py = trunc(cy + dyu * rr);
        if (this.is_dirt(px, py)) {
          this.write(px, py, C.COL_SKY);
        }
      }
    }
  }

  // ---- dirt settle / collapse (catalog 11 section 2.5) ----
  settle(cfg: TerrainCfg, rng: TerrainRng, x_lo = 0, x_hi: number | null = null): void {
    /* Per-column gravity: unsupported dirt falls. Gated by SUSPEND_DIRT
       (DAT_5f38_5158 = 100 - SUSPEND_DIRT; settle prob = 5158/100). */
    const s5158 = 100 - cfg.SUSPEND_DIRT;
    if (s5158 <= 0) {
      return;
    }
    if (s5158 !== 100 && !rng.chance(s5158, 100)) {
      return;
    }
    let hi = x_hi === null ? this.w : x_hi;
    let lo = Math.max(0, x_lo);
    hi = Math.min(this.w, hi);
    for (let x = lo; x < hi; x++) {
      this._settle_column(x);
    }
  }

  _settle_column(x: number): void {
    /* Drop the single topmost SUSPENDED dirt run in column x onto the solid below
       it, preserving every other void (caves, tunnels, overhangs) and any dirt
       already resting on dirt/floor.

       Model (FACT, catalog 11 section 2.5 lines 284-286): FUN_2a1e_0007 starts the
       scan at the top, FUN_2a1e_0059 detects one contiguous dirt run (0x50..0x68)
       sitting ABOVE a `<0x50` gap = "suspended dirt" and records its top + landing
       row; the animate loop drops THAT run one pixel per pass until it rests on
       solid. Only ONE record exists per column per settle; it does NOT rescan for
       runs that become suspended after a lower run lands. The terminal state is the
       run translated down to rest on the next solid; a deeper second gap is left
       untouched, which keeps a bored channel / cave standing.

       Encoding (catalog 11 line 243): `<0x50` = sky/gap, `0x50..0x68` = dirt,
       `>=0x69` = object; here the bottom boundary (self.h) is the solid floor. */
    const h = this.h;
    const colBase = x * h;
    const grid = this.grid;
    const isDirtAt = (y: number): boolean => {
      const v = grid[colBase + y];
      return v === C.COL_DIRT || (v >= C.DIRT_SHADE_LO && v <= C.DIRT_SHADE_HI);
    };
    // Scan DOWN from the top for the first dirt run; record it iff a gap sits
    // directly below it.
    let y = 0;
    while (y < h) {
      if (!isDirtAt(y)) {
        // skip sky/gap above the run
        y += 1;
        continue;
      }
      const top = y; // run start (dirt)
      while (y < h && isDirtAt(y)) {
        // walk through the dirt body
        y += 1;
      }
      const run_bottom = y; // first non-dirt row below the run
      if (run_bottom >= h) {
        return; // run rests on the floor: not suspended
      }
      // run_bottom is a gap (sky). Find the landing: the next solid below the gap;
      // the floor (h) is solid.
      const gap = run_bottom;
      let land = gap;
      while (land < h && !isDirtAt(land)) {
        // descend the gap to the next dirt
        land += 1;
      }
      const drop = land - run_bottom; // rows of empty gap to fall through
      /* v8 ignore next 3 -- unreachable: L665 guarantees run_bottom<h and the inner-while exit guarantees run_bottom is non-dirt, so the L672 descent advances land by >=1 before the next dirt; drop = land-run_bottom >= 1 always. */
      if (drop <= 0) {
        return; // no gap (defensive): not suspended
      }
      // vals = col[top:run_bottom].copy(); preserve the per-pixel shades
      const runLen = run_bottom - top;
      const vals = new Uint8Array(runLen);
      for (let i = 0; i < runLen; i++) vals[i] = grid[colBase + top + i];
      // col[top:run_bottom] = COL_SKY (erase the old run, gap opens above)
      for (let i = top; i < run_bottom; i++) grid[colBase + i] = C.COL_SKY;
      // col[top+drop:run_bottom+drop] = vals (re-plot it `drop` rows lower)
      for (let i = 0; i < runLen; i++) grid[colBase + top + drop + i] = vals[i];
      return; // ONE run per column per settle
    }
  }

  support_count(cx: number, base_y: number, half_width: number): number {
    /* Count of SOLID-DIRT pixels directly under the tank footprint, one row below
       (FUN_2975_0318:28-40 / FUN_2975_01a6:32-41: '< 3 support => fall').

       The engine's predicate reads `pixel < 0x69` against ITS framebuffer encoding;
       this port encodes the plane differently (dirt in [0x50..0x68], sky = 0x00),
       so the behaviorally-faithful support test here is "is the pixel below DIRT"
       (is_solid: dirt or an object pixel >= 0x69). */
    let cnt = 0;
    const y = base_y + 1;
    for (let dx = -half_width; dx <= half_width; dx++) {
      if (this.is_solid(cx + dx, y)) {
        cnt += 1;
      }
    }
    return cnt;
  }

  is_supported(cx: number, base_y: number, half_width: number): boolean {
    /* Negation of the will-fall scan (FUN_2975_0318:41-43 / FUN_2975_01a6:34-51): a
       tank rests when >= 3 support pixels under the footprint, OR any of the three
       center columns (dx in {-1,0,+1}) is solid one row below. Stop-falling
       predicate used by the per-pixel fall walk. */
    const y = base_y + 1;
    let cnt = 0;
    for (let dx = -half_width; dx <= half_width; dx++) {
      if (this.is_solid(cx + dx, y)) {
        cnt += 1;
      }
    }
    if (cnt >= C.TANK_FALL_SUPPORT_PIXELS) {
      // 3+ support
      return true;
    }
    for (const dx of [-1, 0, 1]) {
      // any center column solid
      if (this.is_solid(cx + dx, y)) {
        return true;
      }
    }
    return false;
  }
}
