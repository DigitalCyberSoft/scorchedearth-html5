/**
 * Browser-targeted pygame shim over Canvas2D -- the IO contract the Phase-2 port
 * agents (render / sprites / ui / widgets / screens / ingame / game / main) write
 * against, so the ported modules read ~1:1 with scorch-py's pygame usage.
 *
 * This is a faithful re-expression of the EXACT pygame surface the Python port
 * touches (enumerated by grepping the whole scorch/ tree). It is NOT a general
 * pygame port: only the calls the port makes are implemented, but each of those
 * is implemented in full (no stubs). Where Canvas semantics differ from SDL the
 * difference is documented at the call so the pixel-diff gate (Phase 3, which
 * compares this output against the Python pygame renders) has a written contract.
 *
 * IMPORT SHAPE: ports do `import * as pygame from "./pygame"` and call
 *   pygame.Surface, pygame.Rect, pygame.draw.rect, pygame.surfarray.blit_array,
 *   pygame.transform.smoothscale, pygame.font.SysFont, pygame.BLEND_RGB_ADD, ...
 * mirroring the Python `import pygame` namespace.
 *
 * DOM SAFETY: top-level module code is DOM-free. `document`/canvas are touched
 * only inside functions/constructors (Surface(), Font.render(), etc.), so the
 * module is import-safe under Node (vitest collects it without a DOM). A Surface
 * cannot be CONSTRUCTED without a DOM, but importing the module never constructs
 * one.
 *
 * ARRAY REPRESENTATION (load-bearing -- the render/terrain/sprites ports MUST
 * follow this; see surfarray below):
 *   blit_array  accepts EITHER pygame's flat column-major `(x, y, channel)`
 *               Uint8Array of length w*h*3, OR an {w,h,data} object whose data is
 *               column-major `(x*h + y)*3 + c`. Both transpose to the canvas's
 *               row-major RGBA `(y*w + x)*4` with alpha 255.
 *   pixels_alpha(surf).set(plane) writes the alpha channel from a column-major
 *               `(x*h + y)` Uint8Array of length w*h.
 *   make_surface(rgb) builds a new Surface from such an rgb array.
 */

// ===========================================================================
// Color normalization
// ===========================================================================

/** A pygame color argument: [r,g,b], [r,g,b,a], or a CSS color string. */
export type ColorArg =
  | [number, number, number]
  | [number, number, number, number]
  | readonly number[]
  | string;

/** Normalized RGBA, components 0..255. */
export type RGBA = [number, number, number, number];

/**
 * Normalize a pygame color into RGBA once. pygame accepts (r,g,b), (r,g,b,a), or
 * a string; the port passes tuples almost everywhere (render.py/widgets.py) and
 * occasionally a literal. A 3-tuple gets alpha 255 (pygame's default opaque).
 */
export function normColor(c: ColorArg): RGBA {
  if (typeof c === "string") {
    return cssToRgba(c);
  }
  const r = c[0] | 0;
  const g = c[1] | 0;
  const b = c[2] | 0;
  const a = c.length >= 4 ? (c[3] as number) | 0 : 255;
  return [r & 255, g & 255, b & 255, a & 255];
}

/** "rgb(r,g,b)" CSS string for fillStyle/strokeStyle from RGBA. */
function rgbaToCss(c: RGBA): string {
  // Use rgba() so a sub-255 alpha (set_at on per-pixel-alpha surfaces is the only
  // path that would carry one) composites; opaque fills round-trip identically.
  if (c[3] === 255) return `rgb(${c[0]},${c[1]},${c[2]})`;
  return `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;
}

// One offscreen 1x1 canvas, lazily built, to resolve named/hex CSS colors to
// RGBA bytes. DOM-free at module scope: created on first string color only.
let _colorProbe: { ctx: CanvasRenderingContext2D; data: Uint8ClampedArray } | null = null;
const _colorCache = new Map<string, RGBA>();

function cssToRgba(s: string): RGBA {
  const hit = _colorCache.get(s);
  if (hit) return hit;
  if (_colorProbe === null) {
    const cv = document.createElement("canvas");
    cv.width = 1;
    cv.height = 1;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    _colorProbe = { ctx, data: new Uint8ClampedArray(4) };
  }
  const { ctx } = _colorProbe;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = "#000";
  ctx.fillStyle = s; // browser parses the CSS color; invalid leaves it #000
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  const out: RGBA = [d[0], d[1], d[2], d[3]];
  _colorCache.set(s, out);
  return out;
}

// ===========================================================================
// Rect
// ===========================================================================

/** A point/size pair as the port passes them: [x, y] or (rarely) a Rect. */
export type Point = [number, number] | readonly [number, number];

/**
 * pygame.Rect. Only the members the port uses are provided, but they behave like
 * pygame's: assigning a "virtual" attribute (center, right, ...) MOVES the rect
 * (keeps its size) rather than resizing it (Rect docs: "assignment to ... moves
 * the rectangle"). Construction supports Rect(x,y,w,h), Rect([x,y],[w,h]), and
 * Rect(otherRect) (copy) -- the three forms main.py/widgets.py exercise.
 */
export class Rect {
  x: number;
  y: number;
  w: number;
  h: number;

  constructor(
    x: number | Rect | [number, number] | readonly number[],
    y?: number | [number, number] | readonly number[],
    w?: number,
    h?: number,
  ) {
    if (x instanceof Rect) {
      this.x = x.x;
      this.y = x.y;
      this.w = x.w;
      this.h = x.h;
    } else if (Array.isArray(x) && Array.isArray(y)) {
      // Rect([x,y], [w,h])
      this.x = x[0];
      this.y = x[1];
      this.w = (y as number[])[0];
      this.h = (y as number[])[1];
    } else if (Array.isArray(x)) {
      // Rect([x,y,w,h])
      const a = x as number[];
      this.x = a[0];
      this.y = a[1];
      this.w = a[2];
      this.h = a[3];
    } else {
      this.x = x as number;
      this.y = (y as number) ?? 0;
      this.w = w ?? 0;
      this.h = h ?? 0;
    }
  }

  // --- size aliases (pygame: width/height mirror w/h) ---
  get width(): number {
    return this.w;
  }
  set width(v: number) {
    this.w = v;
  }
  get height(): number {
    return this.h;
  }
  set height(v: number) {
    this.h = v;
  }
  get size(): [number, number] {
    return [this.w, this.h];
  }
  set size(v: [number, number]) {
    this.w = v[0];
    this.h = v[1];
  }

  // --- edges (assignment MOVES, keeping size) ---
  get left(): number {
    return this.x;
  }
  set left(v: number) {
    this.x = v;
  }
  get top(): number {
    return this.y;
  }
  set top(v: number) {
    this.y = v;
  }
  get right(): number {
    return this.x + this.w;
  }
  set right(v: number) {
    this.x = v - this.w;
  }
  get bottom(): number {
    return this.y + this.h;
  }
  set bottom(v: number) {
    this.y = v - this.h;
  }
  get centerx(): number {
    return this.x + (this.w >> 1);
  }
  set centerx(v: number) {
    this.x = v - (this.w >> 1);
  }
  get centery(): number {
    return this.y + (this.h >> 1);
  }
  set centery(v: number) {
    this.y = v - (this.h >> 1);
  }

  // --- corners (as [x,y]; assignment moves) ---
  get topleft(): [number, number] {
    return [this.x, this.y];
  }
  set topleft(v: [number, number]) {
    this.x = v[0];
    this.y = v[1];
  }
  get topright(): [number, number] {
    return [this.x + this.w, this.y];
  }
  set topright(v: [number, number]) {
    this.x = v[0] - this.w;
    this.y = v[1];
  }
  get bottomleft(): [number, number] {
    return [this.x, this.y + this.h];
  }
  set bottomleft(v: [number, number]) {
    this.x = v[0];
    this.y = v[1] - this.h;
  }
  get bottomright(): [number, number] {
    return [this.x + this.w, this.y + this.h];
  }
  set bottomright(v: [number, number]) {
    this.x = v[0] - this.w;
    this.y = v[1] - this.h;
  }
  get center(): [number, number] {
    return [this.x + (this.w >> 1), this.y + (this.h >> 1)];
  }
  set center(v: [number, number]) {
    this.x = v[0] - (this.w >> 1);
    this.y = v[1] - (this.h >> 1);
  }
  get midtop(): [number, number] {
    return [this.x + (this.w >> 1), this.y];
  }
  get midbottom(): [number, number] {
    return [this.x + (this.w >> 1), this.y + this.h];
  }
  get midleft(): [number, number] {
    return [this.x, this.y + (this.h >> 1)];
  }
  get midright(): [number, number] {
    return [this.x + this.w, this.y + (this.h >> 1)];
  }

  copy(): Rect {
    return new Rect(this.x, this.y, this.w, this.h);
  }

  /** pygame: True iff the point is inside (left/top inclusive, right/bottom exclusive). */
  collidepoint(p: Point): boolean;
  collidepoint(x: number, y: number): boolean;
  collidepoint(px: Point | number, py?: number): boolean {
    const x = typeof px === "number" ? px : px[0];
    const y = typeof px === "number" ? (py as number) : px[1];
    return x >= this.x && x < this.x + this.w && y >= this.y && y < this.y + this.h;
  }

  /** pygame Rect.inflate: grow/shrink about the center, returns a NEW rect. */
  inflate(dw: number, dh: number): Rect {
    return new Rect(this.x - (dw >> 1), this.y - (dh >> 1), this.w + dw, this.h + dh);
  }

  /** in-place inflate (pygame inflate_ip). */
  inflate_ip(dw: number, dh: number): void {
    this.x -= dw >> 1;
    this.y -= dh >> 1;
    this.w += dw;
    this.h += dh;
  }

  /** pygame Rect.move: translate, returns a NEW rect. */
  move(dx: number, dy: number): Rect {
    return new Rect(this.x + dx, this.y + dy, this.w, this.h);
  }

  /** in-place move (pygame move_ip). */
  move_ip(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
  }

  /**
   * pygame Rect.clip: the intersection of this rect with `other`, as a NEW rect.
   * When they do not overlap, pygame returns a zero-area rect positioned at this
   * rect's origin-ish; we match by returning a 0x0 rect inside `other`'s/this'
   * overlap origin (main.py:95 only clips a rect that is known to overlap).
   */
  clip(other: Rect): Rect {
    const x1 = Math.max(this.x, other.x);
    const y1 = Math.max(this.y, other.y);
    const x2 = Math.min(this.x + this.w, other.x + other.w);
    const y2 = Math.min(this.y + this.h, other.y + other.h);
    const w = x2 - x1;
    const h = y2 - y1;
    if (w <= 0 || h <= 0) return new Rect(this.x, this.y, 0, 0);
    return new Rect(x1, y1, w, h);
  }
}

// ===========================================================================
// Surface
// ===========================================================================

/** Internal: a 2-element [w,h] size as the port passes it to Surface(...). */
export type Size = [number, number] | readonly [number, number];

/**
 * pygame.Surface backed by an HTMLCanvasElement + 2D context.
 *
 * The context is GPU-backed by default. Pass the port-private READBACK flag for
 * surfaces whose pixels are READ programmatically (surfarray.pixels_alpha /
 * repeated get_at): it sets { willReadFrequently: true }, keeping those canvases
 * CPU-side so getImageData does not stall. Everything else (the backbuffer, text,
 * widget chrome) stays on the GPU -- a blanket willReadFrequently used to force
 * the WHOLE game into software raster, measured ~190x slower per full-frame fill
 * on Intel ADL GT2 (0.378 ms vs 0.002 ms; 2026-07-07 device profile). One-shot
 * reads on unhinted surfaces (smoothscale sources, the wipe card, gate pixel
 * compares) pay a single GPU sync, which is the right trade.
 *
 * A per-pixel-alpha surface (constructed via convert_alpha / make from RGBA, or
 * the SRCALPHA flag) tracks alpha; a plain surface is opaque. set_colorkey /
 * set_alpha record their values; blit honors a colorkey (skip matching source
 * pixels) and a surface alpha (global blit opacity), matching pygame.
 */
export class Surface {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  private _w: number;
  private _h: number;
  private _colorkey: RGBA | null = null;
  private _alpha: number | null = null; // global surface alpha 0..255, or null=opaque
  private _hasAlpha: boolean; // per-pixel alpha (SRCALPHA / convert_alpha)

  /**
   * Surface([w,h], flags?). The optional second arg mirrors pygame's `flags`;
   * only SRCALPHA is meaningful here (per-pixel alpha). The port constructs most
   * surfaces opaque and calls convert_alpha() where it needs alpha; SRCALPHA is
   * passed directly in sprites.load_title_mountain (Surface((w,h), SRCALPHA)).
   */
  constructor(size: Size, flags = 0) {
    this._w = Math.max(1, size[0] | 0);
    this._h = Math.max(1, size[1] | 0);
    this._hasAlpha = (flags & SRCALPHA) !== 0;
    this.canvas = document.createElement("canvas");
    this.canvas.width = this._w;
    this.canvas.height = this._h;
    this.ctx = this.canvas.getContext(
      "2d",
      (flags & READBACK) !== 0 ? { willReadFrequently: true } : undefined,
    )!;
    // A fresh pygame Surface (no SRCALPHA) is opaque black; an SRCALPHA surface
    // is fully transparent. Canvas starts transparent-black, so seed the opaque
    // case to black so get_at/blit see pygame's initial state.
    if (!this._hasAlpha) {
      this.ctx.fillStyle = "#000";
      this.ctx.fillRect(0, 0, this._w, this._h);
    }
  }

  get_size(): [number, number] {
    return [this._w, this._h];
  }
  get_width(): number {
    return this._w;
  }
  get_height(): number {
    return this._h;
  }
  /** A Rect of this surface at the given origin (default 0,0), like pygame. */
  get_rect(opts?: { topleft?: [number, number]; center?: [number, number] }): Rect {
    const r = new Rect(0, 0, this._w, this._h);
    if (opts) {
      if (opts.topleft) r.topleft = opts.topleft;
      if (opts.center) r.center = opts.center;
    }
    return r;
  }

  /**
   * Surface.fill(color, rect?). With no rect the whole surface is filled; with a
   * rect only that region (pygame clips the rect to the surface). Filling is an
   * opaque source copy in pygame, so we clear the region first when this surface
   * carries per-pixel alpha (a translucent fill color would otherwise composite
   * over old pixels). For the common opaque fill the clear is a no-op visually.
   */
  fill(color: ColorArg, rect?: Rect | [number, number, number, number]): void {
    const c = normColor(color);
    let x = 0;
    let y = 0;
    let w = this._w;
    let h = this._h;
    if (rect) {
      if (rect instanceof Rect) {
        x = rect.x;
        y = rect.y;
        w = rect.w;
        h = rect.h;
      } else {
        x = rect[0];
        y = rect[1];
        w = rect[2];
        h = rect[3];
      }
    }
    if (this._hasAlpha) this.ctx.clearRect(x, y, w, h);
    this.ctx.fillStyle = rgbaToCss(c);
    this.ctx.fillRect(x, y, w, h);
  }

  /**
   * Surface.blit(src, dest, area?, special_flags?). `dest` is [x,y] or a Rect
   * (pygame uses the rect's topleft). `area` crops the source. special_flags ===
   * BLEND_RGB_ADD switches to additive compositing (ctx 'lighter'), used by the
   * lightning/dialog flash overlays (render.py:914, main.py:177).
   *
   * Colorkey and surface-alpha on the SOURCE are honored: a colorkey skips the
   * matching pixels (drawn via a masked temp), a surface alpha applies a global
   * opacity. Both are read off `src`. Returns the affected Rect like pygame.
   */
  blit(
    src: Surface,
    dest: Point | Rect,
    area?: Rect | null,
    special_flags = 0,
  ): Rect {
    const dx = dest instanceof Rect ? dest.x : dest[0];
    const dy = dest instanceof Rect ? dest.y : dest[1];

    // Source crop rectangle (full source when no area).
    let sx = 0;
    let sy = 0;
    let sw = src._w;
    let sh = src._h;
    if (area) {
      sx = area.x;
      sy = area.y;
      sw = area.w;
      sh = area.h;
    }

    const prevOp = this.ctx.globalCompositeOperation;
    const prevAlpha = this.ctx.globalAlpha;
    if ((special_flags & BLEND_RGB_ADD) !== 0) {
      // Additive blend. NOTE (faithful to render.py:905-914 / main.py:171-177):
      // under SDL's BLEND_RGB_ADD the source surface_alpha is IGNORED -- the full
      // source RGB is added. Canvas 'lighter' adds source*globalAlpha, so to
      // match SDL we DO NOT apply src._alpha here (leave globalAlpha at 1).
      this.ctx.globalCompositeOperation = "lighter";
    } else if (src._alpha !== null) {
      // Plain blit with a per-surface alpha (Surface.set_alpha): global opacity.
      this.ctx.globalAlpha = src._alpha / 255;
    }

    const drawSrc = src._colorkey !== null ? src._withColorkeyStripped() : src.canvas;
    this.ctx.drawImage(drawSrc, sx, sy, sw, sh, dx, dy, sw, sh);

    this.ctx.globalCompositeOperation = prevOp;
    this.ctx.globalAlpha = prevAlpha;
    return new Rect(dx, dy, sw, sh);
  }

  /** A canvas copy of this surface with colorkey pixels made transparent. */
  private _withColorkeyStripped(): HTMLCanvasElement {
    const key = this._colorkey!;
    const tmp = document.createElement("canvas");
    tmp.width = this._w;
    tmp.height = this._h;
    const tctx = tmp.getContext("2d", { willReadFrequently: true })!;
    const img = this.ctx.getImageData(0, 0, this._w, this._h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === key[0] && d[i + 1] === key[1] && d[i + 2] === key[2]) {
        d[i + 3] = 0;
      }
    }
    tctx.putImageData(img, 0, 0);
    return tmp;
  }

  /** Surface.copy(): a new independent Surface with identical pixels + flags. */
  copy(): Surface {
    const s = new Surface([this._w, this._h], this._hasAlpha ? SRCALPHA : 0);
    if (this._hasAlpha) s.ctx.clearRect(0, 0, this._w, this._h);
    s.ctx.drawImage(this.canvas, 0, 0);
    s._colorkey = this._colorkey;
    s._alpha = this._alpha;
    return s;
  }

  /**
   * Surface.subsurface(rect): in pygame this is a VIEW sharing pixels. The port
   * only uses it as `.subsurface(rect).copy()` (main.py:95), i.e. immediately
   * copied, so a detached copy is behaviorally identical there. Returns a new
   * Surface holding the rect's pixels.
   */
  subsurface(rect: Rect): Surface {
    const s = new Surface([rect.w, rect.h], this._hasAlpha ? SRCALPHA : 0);
    if (this._hasAlpha) s.ctx.clearRect(0, 0, rect.w, rect.h);
    s.ctx.drawImage(this.canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    return s;
  }

  /** Surface.set_at([x,y], color): write a single pixel (used for sprite stamps). */
  set_at(pos: Point, color: ColorArg): void {
    const c = normColor(color);
    this.ctx.fillStyle = rgbaToCss(c);
    // clearRect first so an alpha-carrying surface replaces (not composites) the
    // pixel, matching pygame set_at (a direct pixel store).
    if (this._hasAlpha || c[3] !== 255) this.ctx.clearRect(pos[0], pos[1], 1, 1);
    this.ctx.fillRect(pos[0], pos[1], 1, 1);
  }

  /** Surface.get_at([x,y]) -> [r,g,b,a]. */
  get_at(pos: Point): RGBA {
    const d = this.ctx.getImageData(pos[0], pos[1], 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  }

  /**
   * Surface.set_colorkey(color | null): pixels equal to `color` are treated as
   * transparent on blit. Stored and applied per-blit (pygame builds a mask).
   */
  set_colorkey(color: ColorArg | null): void {
    this._colorkey = color === null ? null : normColor(color);
  }
  get_colorkey(): RGBA | null {
    return this._colorkey;
  }

  /** Surface.set_alpha(a | null): global blit opacity (None = opaque). */
  set_alpha(a: number | null): void {
    this._alpha = a === null ? null : a & 255;
  }
  get_alpha(): number | null {
    return this._alpha;
  }

  /**
   * convert_alpha(): in pygame this returns a copy in the display format WITH
   * per-pixel alpha. Here it returns a copy flagged as alpha-carrying (the canvas
   * already stores RGBA), so subsequent blits/per-pixel-alpha writes treat it as
   * transparent-capable. convert() is the opaque equivalent.
   */
  convert_alpha(): Surface {
    const s = this.copy();
    s._hasAlpha = true;
    return s;
  }
  convert(): Surface {
    const s = this.copy();
    s._hasAlpha = false;
    return s;
  }

  /** True if this surface carries per-pixel alpha (SRCALPHA / convert_alpha). */
  get hasAlpha(): boolean {
    return this._hasAlpha;
  }
}

// ===========================================================================
// draw -- match pygame's pixel conventions (these feed the Phase-3 pixel gate)
// ===========================================================================

export const draw = {
  /**
   * draw.rect(surf, color, rect, width=0). width 0 = filled; width>0 = an outline
   * `width` px thick drawn INSIDE the rect edges (pygame draws the border inward).
   * pygame fills the half-open box [x, x+w) x [y, y+h); fillRect matches.
   */
  rect(
    surf: Surface,
    color: ColorArg,
    rect: Rect | [number, number, number, number],
    width = 0,
  ): Rect {
    const x = rect instanceof Rect ? rect.x : rect[0];
    const y = rect instanceof Rect ? rect.y : rect[1];
    const w = rect instanceof Rect ? rect.w : rect[2];
    const h = rect instanceof Rect ? rect.h : rect[3];
    const c = normColor(color);
    const ctx = surf.ctx;
    ctx.fillStyle = rgbaToCss(c);
    if (width <= 0) {
      ctx.fillRect(x, y, w, h);
    } else {
      // Border inward: four filled bands, clamped so thick borders on small rects
      // do not overdraw past the opposite edge (pygame caps similarly).
      const bw = Math.min(width, Math.ceil(w / 2));
      const bh = Math.min(width, Math.ceil(h / 2));
      ctx.fillRect(x, y, w, bh); // top
      ctx.fillRect(x, y + h - bh, w, bh); // bottom
      ctx.fillRect(x, y, bw, h); // left
      ctx.fillRect(x + w - bw, y, bw, h); // right
    }
    return new Rect(x, y, w, h);
  },

  /**
   * draw.circle(surf, color, center, radius, width=0). width 0 = filled disk;
   * width>0 = a ring `width` px thick. pygame rasterizes a midpoint circle; we
   * use a path arc with integer center/radius, which the pixel gate tolerates for
   * the radii the game draws (shield rings, explosion disks, radio bullets).
   */
  circle(
    surf: Surface,
    color: ColorArg,
    center: Point,
    radius: number,
    width = 0,
  ): Rect {
    const cx = center[0] | 0;
    const cy = center[1] | 0;
    const r = Math.max(0, radius | 0);
    const c = normColor(color);
    const ctx = surf.ctx;
    if (r === 0) {
      // pygame draws a single pixel for radius 0.
      surf.set_at([cx, cy], c);
      return new Rect(cx, cy, 1, 1);
    }
    if (width <= 0 || width >= r) {
      ctx.fillStyle = rgbaToCss(c);
      ctx.beginPath();
      ctx.arc(cx + 0.5, cy + 0.5, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = rgbaToCss(c);
      ctx.lineWidth = width;
      ctx.beginPath();
      // stroke centered on radius - width/2 so the band lies inside r, like pygame.
      ctx.arc(cx + 0.5, cy + 0.5, r - width / 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    return new Rect(cx - r, cy - r, r * 2, r * 2);
  },

  /**
   * draw.line(surf, color, start, end, width=1). A single segment. pygame centers
   * the stroke on the line; Canvas does too. Half-pixel offset on odd widths
   * lands the 1px line on the pixel grid the way pygame's Bresenham does.
   */
  line(
    surf: Surface,
    color: ColorArg,
    start: Point,
    end: Point,
    width = 1,
  ): void {
    strokePolyline(surf, normColor(color), [start, end], false, Math.max(1, width));
  },

  /**
   * draw.lines(surf, color, closed, points, width=1). Connected polyline; closed
   * appends the first point. Used for laser beams, lightning bolts, the wind/aim
   * arrowheads, speech-bubble tails (via polygon elsewhere).
   */
  lines(
    surf: Surface,
    color: ColorArg,
    closed: boolean,
    points: ReadonlyArray<Point>,
    width = 1,
  ): void {
    strokePolyline(surf, normColor(color), points, closed, Math.max(1, width));
  },

  /**
   * draw.polygon(surf, color, points, width=0). width 0 = filled; width>0 = the
   * outline. Used for the active-shooter marker, speech-bubble tail, arrowheads.
   */
  polygon(
    surf: Surface,
    color: ColorArg,
    points: ReadonlyArray<Point>,
    width = 0,
  ): void {
    const c = normColor(color);
    const ctx = surf.ctx;
    if (points.length === 0) return;
    if (width <= 0) {
      ctx.fillStyle = rgbaToCss(c);
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
      ctx.closePath();
      ctx.fill();
    } else {
      strokePolyline(surf, c, points, true, Math.max(1, width));
    }
  },
};

/** Shared polyline stroker for line/lines/polygon-outline. */
function strokePolyline(
  surf: Surface,
  c: RGBA,
  points: ReadonlyArray<Point>,
  closed: boolean,
  width: number,
): void {
  if (points.length === 0) return;
  const ctx = surf.ctx;
  ctx.strokeStyle = rgbaToCss(c);
  ctx.lineWidth = width;
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  // Half-pixel snap for odd widths so a 1px stroke sits ON the pixel row/col
  // (matches pygame's integer-coordinate Bresenham lines). Even widths straddle
  // the boundary, which is also pygame's behavior for thick lines.
  const off = width % 2 === 1 ? 0.5 : 0;
  ctx.beginPath();
  ctx.moveTo(points[0][0] + off, points[0][1] + off);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i][0] + off, points[i][1] + off);
  }
  if (closed) ctx.closePath();
  ctx.stroke();
}

// ===========================================================================
// surfarray -- the pixel-array bridge (load-bearing representation, see header)
// ===========================================================================

/**
 * The TS form of a pygame "(w, h, 3)" RGB array. The render/terrain/sprites port
 * MUST emit one of these to blit_array / make_surface:
 *
 *   (A) a raw Uint8Array in pygame's flat COLUMN-MAJOR order: index = (x*h + y)*3
 *       + c, length w*h*3 -- passed WITH a Surface (the surface gives w,h); or
 *   (B) an {w, h, data} object whose `data` is that same column-major Uint8Array.
 *
 * Form (B) is RECOMMENDED for new port code because it is self-describing (the
 * shim does not have to infer w,h from the surface). Both transpose to the
 * canvas's row-major RGBA: dst[(y*w + x)*4 + c] = src[(x*h + y)*3 + c], alpha 255.
 *
 * Provenance: the Python port feeds blit_array a numpy (W,H,3) array
 * (render.py:83/448, sprites.py:1185). numpy's (W,H,3) C-order flatten IS the
 * column-major (x*h + y)*3 layout, so this matches the oracle byte-for-byte.
 */
export interface RgbArray {
  w: number;
  h: number;
  /** column-major: data[(x*h + y)*3 + c], length w*h*3. */
  data: Uint8Array;
}

export const surfarray = {
  /**
   * surfarray.blit_array(surf, rgb): write an (w,h,3) column-major RGB array onto
   * `surf` as opaque pixels. Accepts the {w,h,data} object form OR a bare
   * Uint8Array (sized to the surface). Transposes to row-major RGBA and puts.
   */
  blit_array(surf: Surface, rgb: RgbArray | Uint8Array): void {
    const [w, h] = surf.get_size();
    const data = rgb instanceof Uint8Array ? rgb : rgb.data;
    if (data.length !== w * h * 3) {
      throw new Error(
        `blit_array: rgb length ${data.length} != ${w}*${h}*3 (${w * h * 3})`,
      );
    }
    const img = surf.ctx.createImageData(w, h);
    const out = img.data;
    // dst[(y*w + x)*4 + c] = src[(x*h + y)*3 + c]; alpha 255.
    for (let x = 0; x < w; x++) {
      const colBase = x * h * 3;
      for (let y = 0; y < h; y++) {
        const s = colBase + y * 3;
        const d = (y * w + x) * 4;
        out[d] = data[s];
        out[d + 1] = data[s + 1];
        out[d + 2] = data[s + 2];
        out[d + 3] = 255;
      }
    }
    surf.ctx.putImageData(img, 0, 0);
  },

  /**
   * surfarray.pixels_alpha(surf): pygame returns a live (w,h) view of the alpha
   * plane; the port writes it as `pixels_alpha(surf)[:, :] = plane`
   * (sprites.py:1189). The shim cannot return a numpy-assignable view, so it
   * returns an object with `.set(plane)` taking a column-major (x*h + y) alpha
   * Uint8Array of length w*h, writing it into the surface's ImageData alpha
   * channel (leaving RGB intact). Ports call `pixels_alpha(surf).set(plane)`.
   */
  pixels_alpha(surf: Surface): { set(plane: Uint8Array): void } {
    const [w, h] = surf.get_size();
    return {
      set(plane: Uint8Array): void {
        if (plane.length !== w * h) {
          throw new Error(`pixels_alpha.set: plane length ${plane.length} != ${w}*${h}`);
        }
        const img = surf.ctx.getImageData(0, 0, w, h);
        const d = img.data;
        for (let x = 0; x < w; x++) {
          const colBase = x * h;
          for (let y = 0; y < h; y++) {
            d[(y * w + x) * 4 + 3] = plane[colBase + y];
          }
        }
        surf.ctx.putImageData(img, 0, 0);
      },
    };
  },

  /**
   * surfarray.make_surface(rgb): build a NEW opaque Surface from an (w,h,3)
   * column-major RGB array. Mirrors pygame.surfarray.make_surface (the port uses
   * it where it wants a surface straight from an array rather than blitting onto
   * an existing one).
   */
  make_surface(rgb: RgbArray): Surface {
    const s = new Surface([rgb.w, rgb.h]);
    surfarray.blit_array(s, rgb);
    return s;
  },
};

// ===========================================================================
// transform
// ===========================================================================

export const transform = {
  /** transform.scale(surf, [w,h]) -> NEAREST-neighbor resized copy (no smoothing). */
  scale(surf: Surface, size: Size): Surface {
    return resample(surf, size[0] | 0, size[1] | 0, false);
  },

  /** transform.smoothscale(surf, [w,h]) -> SMOOTH (bilinear-ish) resized copy. */
  smoothscale(surf: Surface, size: Size): Surface {
    return resample(surf, size[0] | 0, size[1] | 0, true);
  },

  /**
   * transform.flip(surf, x, y): mirror horizontally (x) and/or vertically (y).
   * Provided for completeness of the transform namespace; the port's sprite
   * mirroring path may use it.
   */
  flip(surf: Surface, x: boolean, y: boolean): Surface {
    const [w, h] = surf.get_size();
    const out = new Surface([w, h], surf.hasAlpha ? SRCALPHA : 0);
    const ctx = out.ctx;
    if (surf.hasAlpha) ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(x ? w : 0, y ? h : 0);
    ctx.scale(x ? -1 : 1, y ? -1 : 1);
    ctx.drawImage(surf.canvas, 0, 0);
    ctx.restore();
    return out;
  },
};

function resample(surf: Surface, w: number, h: number, smooth: boolean): Surface {
  const tw = Math.max(1, w);
  const th = Math.max(1, h);
  const out = new Surface([tw, th], surf.hasAlpha ? SRCALPHA : 0);
  const ctx = out.ctx;
  if (surf.hasAlpha) ctx.clearRect(0, 0, tw, th);
  ctx.imageSmoothingEnabled = smooth;
  // imageSmoothingQuality is advisory; 'low' best matches pygame's box smoothscale
  // when supported. Cast: the property is not in every lib.dom version.
  (ctx as unknown as { imageSmoothingQuality?: string }).imageSmoothingQuality = smooth
    ? "low"
    : "low";
  ctx.drawImage(surf.canvas, 0, 0, surf.get_width(), surf.get_height(), 0, 0, tw, th);
  return out;
}

// ===========================================================================
// font
// ===========================================================================

// Resolve the port's "consolas,couriernew,monospace" family to a real CSS
// monospace stack. The browser has no Consolas guarantee, but the canonical
// monospace metrics are close enough for the gate; the keyword `monospace` is the
// backstop so text always renders without a bundled TTF (per the task brief).
const MONO_STACK = `"Consolas","Courier New",monospace`;

function resolveFamily(name: string): string {
  // The port passes exactly "consolas,couriernew,monospace". Map that (and any
  // string containing "mono") to the CSS monospace stack; otherwise pass through
  // quoted so a single family name is honored.
  const n = name.toLowerCase();
  if (n.includes("mono") || n.includes("consolas") || n.includes("courier")) {
    return MONO_STACK;
  }
  return `"${name}",monospace`;
}

/**
 * pygame.font.Font (as returned by SysFont). render() rasterizes text onto a new
 * Surface sized by measureText; size()/get_height() report metrics. Antialias is
 * always on in the browser (Canvas text is AA); the `antialias` flag is accepted
 * to match the signature but does not toggle (pygame AA off is not reproducible
 * on Canvas and the port always passes True).
 */
export class Font {
  readonly size_px: number;
  readonly bold: boolean;
  private readonly family: string;
  private readonly cssFont: string;
  private _ascentDescent: { ascent: number; descent: number } | null = null;

  constructor(name: string, size: number, bold = false) {
    this.size_px = size | 0;
    this.bold = bold;
    this.family = resolveFamily(name);
    this.cssFont = `${bold ? "bold " : ""}${this.size_px}px ${this.family}`;
  }

  /** A measuring context (shared, lazily built). DOM-free until first call. */
  private static _measureCtx: CanvasRenderingContext2D | null = null;
  private measureCtx(): CanvasRenderingContext2D {
    if (Font._measureCtx === null) {
      const cv = document.createElement("canvas");
      Font._measureCtx = cv.getContext("2d", { willReadFrequently: true })!;
    }
    const ctx = Font._measureCtx;
    ctx.font = this.cssFont;
    ctx.textBaseline = "alphabetic";
    return ctx;
  }

  // -------------------------------------------------------------------------
  // Text caches. Menus re-render/measure the SAME strings every frame (measured
  // 73-138 fresh canvases per frame before caching); both maps are keyed by
  // cssFont + text (+ colors for render) and evicted oldest-first at a cap.
  // -------------------------------------------------------------------------
  private static _sizeCache = new Map<string, number>();
  private static _renderCache = new Map<string, Surface>();
  private static readonly _SIZE_CACHE_CAP = 4096;
  private static readonly _RENDER_CACHE_CAP = 1024;

  private static _evict(cache: Map<string, unknown>, cap: number): void {
    while (cache.size > cap) {
      const oldest = cache.keys().next().value as string;
      cache.delete(oldest);
    }
  }

  /** font.size(text) -> [w, h]: pixel width of `text` and the font's line height. */
  size(text: string): [number, number] {
    const key = this.cssFont + "\x00" + text;
    let w = Font._sizeCache.get(key);
    if (w === undefined) {
      const ctx = this.measureCtx();
      w = Math.ceil(ctx.measureText(text).width);
      Font._sizeCache.set(key, w);
      Font._evict(Font._sizeCache, Font._SIZE_CACHE_CAP);
    }
    return [w, this.get_height()];
  }

  /**
   * font.get_height(): the font's line height in px. Derived from the font's
   * actual ascent+descent (measured once) so it matches the glyph box the port
   * lays out against; falls back to a 1.2x ratio if the metrics are unavailable.
   */
  get_height(): number {
    const ad = this.metrics();
    return Math.ceil(ad.ascent + ad.descent);
  }

  private metrics(): { ascent: number; descent: number } {
    if (this._ascentDescent === null) {
      const ctx = this.measureCtx();
      const m = ctx.measureText("Mg");
      // fontBoundingBox* is the font's design ascent/descent; actualBoundingBox*
      // is glyph-specific. Prefer fontBoundingBox (stable line height), else
      // approximate from the size.
      const asc =
        (m as TextMetrics & { fontBoundingBoxAscent?: number }).fontBoundingBoxAscent ??
        this.size_px * 0.8;
      const desc =
        (m as TextMetrics & { fontBoundingBoxDescent?: number }).fontBoundingBoxDescent ??
        this.size_px * 0.2;
      this._ascentDescent = { ascent: asc, descent: desc };
    }
    return this._ascentDescent;
  }

  /**
   * font.render(text, antialias, color, bg?) -> Surface. The surface is sized to
   * the measured text box and `color` text is drawn; with `bg` the whole surface
   * is filled first (opaque) else it is transparent (per-pixel alpha), matching
   * pygame.font.Font.render. Returns a 1-px-min surface for empty text.
   *
   * CACHED + SHARED: repeat (font, text, color, bg) calls return the SAME
   * Surface, so callers MUST NOT mutate the result (no set_alpha/set_colorkey/
   * draw-into). Audited 2026-07-07: every call site blits the result and drops
   * it; the set_alpha overlays in render.ts/widgets.ts are fresh plain Surfaces,
   * never text.
   */
  render(text: string, _antialias: boolean, color: ColorArg, bg?: ColorArg | null): Surface {
    const fg = normColor(color);
    const bgc = bg === undefined || bg === null ? null : normColor(bg);
    const key =
      this.cssFont + "\x00" + text + "\x00" + fg.join(",") + "\x00" + (bgc === null ? "-" : bgc.join(","));
    const hit = Font._renderCache.get(key);
    if (hit !== undefined) return hit;
    const ctx0 = this.measureCtx();
    const w = Math.max(1, Math.ceil(ctx0.measureText(text).width));
    const ad = this.metrics();
    const h = Math.max(1, Math.ceil(ad.ascent + ad.descent));
    const surf = new Surface([w, h], bgc ? 0 : SRCALPHA);
    const ctx = surf.ctx;
    if (bgc) {
      ctx.fillStyle = rgbaToCss(bgc);
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.clearRect(0, 0, w, h);
    }
    ctx.font = this.cssFont;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = rgbaToCss(fg);
    // Draw at the baseline (ascent down from the top), so the glyph box matches
    // the surface the port blits at (x, y) top-left.
    ctx.fillText(text, 0, ad.ascent);
    Font._renderCache.set(key, surf);
    Font._evict(Font._renderCache, Font._RENDER_CACHE_CAP);
    return surf;
  }
}

export const font = {
  /**
   * font.SysFont(name, size, bold=false) -> Font. The port asks for
   * "consolas,couriernew,monospace"; resolveFamily maps it to a CSS monospace
   * stack so it renders without a bundled font (no init/quit needed in the
   * browser, unlike pygame.font.init()).
   */
  SysFont(name: string, size: number, bold = false): Font {
    return new Font(name, size, bold);
  },
  /** pygame.font.init() is a no-op in the browser (Canvas text needs no init). */
  init(): void {
    /* no-op: Canvas text is always available. */
  },
  Font,
};

// ===========================================================================
// Constants -- blend flags, surface flags, event types, key/mod codes
// ===========================================================================

// Blend flags (only ADD is used by the port; the others are defined for any
// port code that references the BLEND_* namespace).
export const BLEND_RGB_ADD = 0x06; // pygame value; selects ctx 'lighter' in blit
export const BLEND_RGB_SUB = 0x07;
export const BLEND_RGB_MULT = 0x08;
export const BLEND_RGB_MIN = 0x09;
export const BLEND_RGB_MAX = 0x0a;

// Surface creation flags.
export const SRCALPHA = 0x00010000; // per-pixel alpha (SDL value)
export const SCALED = 0x00000200; // display-scale hint (display.set_mode flag)
// PORT-PRIVATE (no SDL equivalent): request a willReadFrequently 2D context for
// surfaces whose pixels are read programmatically (see the Surface docstring).
export const READBACK = 0x40000000;
export const FULLSCREEN = 0x00000800; // fullscreen hint (display.set_mode flag)

// --- Event types (SDL/pygame numeric values) ---
export const QUIT = 256;
export const KEYDOWN = 768;
export const KEYUP = 769;
export const MOUSEMOTION = 1024;
export const MOUSEBUTTONDOWN = 1025;
export const MOUSEBUTTONUP = 1026;

// --- Key codes: real SDL keycodes, EXACTLY the K_* the port references ---
export const K_BACKSPACE = 8;
export const K_TAB = 9;
export const K_RETURN = 13;
export const K_ESCAPE = 27;
export const K_SPACE = 32;
export const K_MINUS = 45;
export const K_LEFTBRACKET = 91;
export const K_RIGHTBRACKET = 93;

// Digits K_0..K_9 = 48..57.
export const K_0 = 48;
export const K_1 = 49;
export const K_2 = 50;
export const K_3 = 51;
export const K_4 = 52;
export const K_5 = 53;
export const K_6 = 54;
export const K_7 = 55;
export const K_8 = 56;
export const K_9 = 57;

// Letters K_a..K_z = 97..122 (SDL keycodes are the lowercase ASCII values).
export const K_a = 97;
export const K_b = 98;
export const K_c = 99;
export const K_d = 100;
export const K_e = 101;
export const K_f = 102;
export const K_g = 103;
export const K_h = 104;
export const K_i = 105;
export const K_j = 106;
export const K_k = 107;
export const K_l = 108;
export const K_m = 109;
export const K_n = 110;
export const K_o = 111;
export const K_p = 112;
export const K_q = 113;
export const K_r = 114;
export const K_s = 115;
export const K_t = 116;
export const K_u = 117;
export const K_v = 118;
export const K_w = 119;
export const K_x = 120;
export const K_y = 121;
export const K_z = 122;

// SDL2 "scancode | 0x40000000" keycodes for the named keys the port uses.
const SDLK_SCANCODE_MASK = 1 << 30; // 0x40000000
export const K_UP = SDLK_SCANCODE_MASK | 82; // 1073741906
export const K_DOWN = SDLK_SCANCODE_MASK | 81; // 1073741905
export const K_RIGHT = SDLK_SCANCODE_MASK | 79; // 1073741903
export const K_LEFT = SDLK_SCANCODE_MASK | 80; // 1073741904
export const K_PAGEUP = SDLK_SCANCODE_MASK | 75; // 1073741899
export const K_PAGEDOWN = SDLK_SCANCODE_MASK | 78; // 1073741902
export const K_F1 = SDLK_SCANCODE_MASK | 58; // 1073741882
export const K_F11 = SDLK_SCANCODE_MASK | 68; // 1073741892
export const K_KP_ENTER = SDLK_SCANCODE_MASK | 88; // 1073741912

// --- Key modifiers (SDL KMOD_*) ---
export const KMOD_NONE = 0x0000;
export const KMOD_LSHIFT = 0x0001;
export const KMOD_RSHIFT = 0x0002;
export const KMOD_SHIFT = 0x0003;
export const KMOD_LCTRL = 0x0040;
export const KMOD_RCTRL = 0x0080;
export const KMOD_CTRL = 0x00c0;
export const KMOD_LALT = 0x0100; // 256
export const KMOD_RALT = 0x0200; // 512
export const KMOD_ALT = 0x0300; // 768

// ===========================================================================
// Browser event adapters -- DOM KeyboardEvent/MouseEvent -> SDL constants
// ===========================================================================

// Map a DOM KeyboardEvent.code (physical key) to the SDL keycode for the named
// keys; printable keys fall through to the keycode-from-key path below. `code` is
// preferred for the named/navigation keys because it is layout-independent.
const CODE_TO_SDL: { readonly [code: string]: number } = {
  Backspace: K_BACKSPACE,
  Tab: K_TAB,
  Enter: K_RETURN,
  NumpadEnter: K_KP_ENTER,
  Escape: K_ESCAPE,
  Space: K_SPACE,
  Minus: K_MINUS,
  BracketLeft: K_LEFTBRACKET,
  BracketRight: K_RIGHTBRACKET,
  ArrowUp: K_UP,
  ArrowDown: K_DOWN,
  ArrowLeft: K_LEFT,
  ArrowRight: K_RIGHT,
  PageUp: K_PAGEUP,
  PageDown: K_PAGEDOWN,
  F1: K_F1,
  F11: K_F11,
};

/**
 * keyToPygame(e): the SDL keycode for a DOM KeyboardEvent, so main.ts can build a
 * pygame-shaped event {type, key, mod, unicode}. Named/navigation keys resolve by
 * physical `code`; letters and digits resolve to their lowercase-ASCII SDL
 * keycode (K_a..K_z = 97.., K_0..K_9 = 48..). Unknown keys return 0.
 */
export function keyToPygame(e: KeyboardEvent): number {
  const byCode = CODE_TO_SDL[e.code];
  if (byCode !== undefined) return byCode;
  const k = e.key;
  if (k.length === 1) {
    const ch = k.toLowerCase();
    const cc = ch.charCodeAt(0);
    if (cc >= 97 && cc <= 122) return cc; // a..z
    if (cc >= 48 && cc <= 57) return cc; // 0..9
    if (ch === " ") return K_SPACE;
    if (ch === "-") return K_MINUS;
    if (ch === "[") return K_LEFTBRACKET;
    if (ch === "]") return K_RIGHTBRACKET;
  }
  return 0;
}

/**
 * modsToPygame(e): the SDL KMOD_* bitmask for a DOM Keyboard/MouseEvent's live
 * modifier state (alt/ctrl/shift), so e.mod matches pygame. The port only tests
 * KMOD_ALT (main.py:659), but ctrl/shift are included for completeness. Left vs
 * right is not distinguishable from the DOM boolean flags, so both L and R bits
 * are set when the combined modifier is down (KMOD_ALT == LALT|RALT etc.).
 */
export function modsToPygame(e: KeyboardEvent | MouseEvent): number {
  let m = 0;
  if (e.altKey) m |= KMOD_ALT;
  if (e.ctrlKey) m |= KMOD_CTRL;
  if (e.shiftKey) m |= KMOD_SHIFT;
  return m;
}

/**
 * unicodeFor(e): the pygame `event.unicode` for a KEYDOWN -- the printable
 * character produced, or "" for non-printing keys. widgets.TextField.on_text_key
 * and Frame.take_key read event.unicode (widgets.py:266,466), so main.ts sets it
 * from here. DOM `e.key` is already the produced character for printable keys
 * (length 1) and a name (e.g. "Enter") otherwise.
 */
export function unicodeFor(e: KeyboardEvent): string {
  // Enter yields "\r" in pygame; match that since on_text_key compares K_RETURN
  // by keycode but Frame.take_key stores event.unicode for the captured key.
  if (e.key === "Enter") return "\r";
  if (e.key === "Tab") return "\t";
  if (e.key === "Backspace") return "\b";
  if (e.key === "Escape") return "\x1b";
  if (e.key.length === 1) return e.key;
  return "";
}

/**
 * mouseButtonToPygame(e): pygame mouse button number (1=left, 2=middle, 3=right)
 * from a DOM MouseEvent.button (0=left, 1=middle, 2=right). widgets/ingame test
 * `event.button == 3` for right-click (widgets.py:176,209,345).
 */
export function mouseButtonToPygame(button: number): number {
  if (button === 0) return 1;
  if (button === 1) return 2;
  if (button === 2) return 3;
  return button + 1;
}
