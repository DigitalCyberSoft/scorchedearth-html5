/**
 * Scorched Earth v1.5 ".MTN" scanned-mountain decoder -- a faithful TypeScript
 * port of scorch-py/port/mtn.py (the fidelity oracle, itself read byte-for-byte
 * from the FP-patched DOS binary and cross-checked against the 10 shipped .MTN
 * files).
 *
 * Format provenance (carried verbatim from the Python port so the lineage
 * survives):
 *   - find_mtn_file = FUN_3c44_0676 globs *.mtn, checks the 4-byte magic
 *     'M' 'T' 0xBE 0xEF and a 10-name whitelist.
 *   - The MTN "picture" vtable is at data 5f38:0x5078 (FUN_3c44_056a stores only
 *     the filename); the body is decoded+blitted inside the object's DRAW method,
 *     raw seg 2c44:0004 (Ghidra FUN_3c44_0004), dispatched from FUN_323a_083f:35.
 *     Code base in the .EXE for these segments = 0x6a00; draw method @ 0x32e44.
 *
 * HEADER (24 bytes, one fread(buf,size=0x18,count=1) @ .EXE 0x32ee6):
 *   off size field
 *   0   4    magic  'M' 'T' 0xBE 0xEF  (4D 54 BE EF)
 *   4   2    version (BIG-endian) == 1
 *   6   2    width   (u16 LE)                [bp-0x2e] in draw
 *   8   2    xoff    (u16 LE) = min column height / baseline   [bp-0x2c]
 *   10  2    height  (u16 LE)                [bp-0x2a]
 *   12  2    ncolors (u16 LE) == 16          [bp-0x28]
 *   14  2    extra0  (unused by decode)
 *   16  2    sky_index (u16 LE) == 0; palette[sky_index] = background DAC color
 *   18  2    extra1  / 20 extra2 / 22 extra3 (unused by decode)
 *
 * PALETTE (@ file offset 24): ncolors RGB triples, 3 bytes each (48 bytes for 16
 *   colors), fread(buf,size=3,count=1) in a 0..ncolors loop @ .EXE 0x32fc3.
 *   Stored bytes are 8-bit (0..255); the VGA path shifts each >>2 to a 6-bit DAC
 *   value (sar ax,2 @ .EXE 0x32fd8/0x32fe1/0x32fee). We keep the raw 0..255.
 *   palette[0] == (255,255,255) (white) in all 10 files = sky/transparent slot.
 *
 * BODY (@ file offset 24+ncolors*3): exactly `width` columns, left to right.
 *   Each column = [u16 count][ceil(count/2) bytes].
 *     count  : u16 LE = stored (GROUND) pixel count, fread([bp-8],size=2,count=1)
 *              @ .EXE 0x3311f. 0 <= count <= height. The (height-count) SKY pixels
 *              at the top of the column are NOT stored (the compression).
 *     pixels : ceil(count/2) bytes, two 4-bit palette indices per byte, fread
 *              one byte at a time ([bp-0x13],size=1,count=1) @ .EXE 0x3313a.
 *              LOW nibble (b & 0xf) = lower/earlier-read pixel, HIGH nibble
 *              ((b>>4)&0xf) = next pixel. Decode order is BOTTOM-UP: nibble 0 is
 *              the DEEPEST ground pixel (screen row height-1); index count-1 is
 *              the SURFACE pixel (screen row height-count). On-screen index =
 *              base + 0x58 (terrain palette region).
 *
 * Verified on all 10 shipped files: reading `width` columns consumes each file
 * exactly (0 bytes leftover, 0 over/underrun).
 *
 * NUMERIC NOTE: this decoder has NO transcendental math and NO RNG. Every output
 * is an integer palette index, a u16 header field, or an (r,g,b) byte. The
 * differential gate (test/mtn.test.ts) asserts all of them with EXACT equality.
 */

export const MAGIC = new Uint8Array([0x4d, 0x54, 0xbe, 0xef]); // 'M' 'T' 0xBE 0xEF
export const HEADER_LEN = 24;
// The on-screen VGA palette base the draw method adds to each nibble (cosmetic;
// not needed to recover indices, recorded for fidelity). .EXE: add ax,0x58.
export const TERRAIN_VGA_BASE = 0x58;
// Index used for "sky" in the decoded plane (the engine leaves these unstored).
// -1 so callers can distinguish unstored sky from a stored index-0 pixel (the
// white sky color genuinely written into a column).
export const SKY = -1;

/** An (r,g,b) palette triple, each component 0..255. */
export type Rgb = [number, number, number];

export interface MtnHeader {
  version: number;
  width: number;
  height: number;
  xoff: number;
  ncolors: number;
  sky_index: number;
  palette: Rgb[];
  /** the 4 decode-unused header words extra0/extra1/extra2/extra3. */
  header_extra: [number, number, number, number];
  palette_offset: number;
  body_offset: number;
}

export interface SurfaceProfile {
  /** surface[x] = top-most GROUND row of column x (= height - count[x]). */
  surface: Int32Array;
  /** stored ground-pixel count per column. */
  counts: Int32Array;
  height: number;
  width: number;
  xoff: number;
  /** sky = {sky_index}. */
  sky_indices: number[];
  /** sorted palette indices occurring as stored GROUND pixels, excluding sky. */
  ground_indices: number[];
}

/** Little-endian u16 read at `off`. */
function readU16LE(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8);
}

/** Big-endian u16 read at `off`. */
function readU16BE(buf: Uint8Array, off: number): number {
  return (buf[off] << 8) | buf[off + 1];
}

/**
 * Parse the .MTN header from raw file bytes.
 *
 * Mirrors mtn.parse_header(path). The Python version takes a path and opens the
 * file; in the browser build the bytes are fetched ahead of time, so this takes
 * the already-read Uint8Array. `name` is used only for error messages (the
 * Python f-strings embed the path).
 */
export function parseHeader(data: Uint8Array, name = "<mtn>"): MtnHeader {
  if (data.length < HEADER_LEN || !magicMatches(data)) {
    const m = Array.from(data.subarray(0, 4));
    throw new Error(`${name}: bad MTN magic ${JSON.stringify(m)}`);
  }
  const version = readU16BE(data, 4);
  const width = readU16LE(data, 6);
  const xoff = readU16LE(data, 8);
  const height = readU16LE(data, 10);
  const ncolors = readU16LE(data, 12);
  const extra0 = readU16LE(data, 14);
  const sky_index = readU16LE(data, 16);
  const extra1 = readU16LE(data, 18);
  const extra2 = readU16LE(data, 20);
  const extra3 = readU16LE(data, 22);
  const palEnd = HEADER_LEN + ncolors * 3;
  if (data.length < palEnd) {
    throw new Error(`${name}: truncated palette`);
  }
  const palette: Rgb[] = [];
  for (let i = 0; i < ncolors; i++) {
    const b = HEADER_LEN + i * 3;
    palette.push([data[b], data[b + 1], data[b + 2]]);
  }
  return {
    version,
    width,
    height,
    xoff,
    ncolors,
    sky_index,
    palette,
    header_extra: [extra0, extra1, extra2, extra3],
    palette_offset: HEADER_LEN,
    body_offset: HEADER_LEN + ncolors * 3,
  };
}

/** True iff the first 4 bytes are the MTN magic. */
function magicMatches(data: Uint8Array): boolean {
  return (
    data[0] === MAGIC[0] &&
    data[1] === MAGIC[1] &&
    data[2] === MAGIC[2] &&
    data[3] === MAGIC[3]
  );
}

interface DecodedColumns {
  hdr: MtnHeader;
  counts: Int32Array;
  /**
   * columns[x] is `counts[x]` palette indices ordered bottom->top (index 0 =
   * deepest ground, index counts[x]-1 = surface), exactly as the file stores
   * them.
   */
  columns: Int16Array[];
}

/**
 * Parse header + body and return (header, counts, columns). Mirrors
 * mtn._decode_columns. Raises on any over/underrun.
 */
function decodeColumns(data: Uint8Array, name = "<mtn>"): DecodedColumns {
  const hdr = parseHeader(data, name);
  const width = hdr.width;
  const height = hdr.height;
  let pos = hdr.body_offset;
  const counts = new Int32Array(width);
  const columns: Int16Array[] = [];
  for (let x = 0; x < width; x++) {
    if (pos + 2 > data.length) {
      throw new Error(`${name}: underrun reading count for column ${x}`);
    }
    const cnt = readU16LE(data, pos);
    pos += 2;
    if (cnt > height) {
      throw new Error(`${name}: column ${x} count ${cnt} exceeds height ${height}`);
    }
    const nbytes = (cnt + 1) >> 1; // (cnt + 1) // 2
    if (pos + nbytes > data.length) {
      throw new Error(`${name}: underrun reading pixels for column ${x}`);
    }
    // Unpack nibbles: low nibble first, then high nibble (per draw loop). The
    // Python builds a length nbytes*2 array then slices [:cnt]; the trailing
    // high nibble of the last byte is dropped when cnt is odd.
    const px = new Int16Array(cnt);
    for (let i = 0; i < nbytes; i++) {
      const b = data[pos + i];
      const lo = i * 2;
      if (lo < cnt) px[lo] = b & 0x0f;
      const hi = lo + 1;
      if (hi < cnt) px[hi] = (b >> 4) & 0x0f;
    }
    pos += nbytes;
    columns.push(px);
    counts[x] = cnt;
  }
  const leftover = data.length - pos;
  if (leftover !== 0) {
    throw new Error(
      `${name}: ${leftover} trailing bytes after ${width} columns (over/underrun)`,
    );
  }
  return { hdr, counts, columns };
}

/**
 * Decode a .MTN file into a flat row-major palette-index grid.
 *
 * Mirrors mtn.decode(path), which returns a numpy (height, width) int16 array
 * (row 0 = top of image). To stay dependency-free and to match the oracle's
 * serialization, this returns { width, height, data } where `data` is a flat
 * Int16Array of length height*width in ROW-MAJOR order (data[y*width + x]),
 * identical to numpy's C-order flatten of the (height, width) array.
 *
 * GROUND cells hold 0..ncolors-1 palette indices; unstored SKY cells hold
 * SKY (-1).
 */
export interface MtnGrid {
  width: number;
  height: number;
  /** flat row-major (data[y*width + x]); -1 = sky. */
  data: Int16Array;
}

export function decode(input: Uint8Array, name = "<mtn>"): MtnGrid {
  const { hdr, counts, columns } = decodeColumns(input, name);
  const width = hdr.width;
  const height = hdr.height;
  const grid = new Int16Array(width * height);
  grid.fill(SKY);
  for (let x = 0; x < width; x++) {
    const cnt = counts[x];
    if (cnt === 0) continue;
    const col = columns[x]; // bottom->top, length cnt
    // rows [height-cnt .. height-1] receive col[cnt-1 .. 0] (flip to top-down):
    // bottom pixel col[0] -> row height-1; surface col[cnt-1] -> row height-cnt.
    // numpy: grid[height-cnt:height, x] = col[::-1].
    for (let r = 0; r < cnt; r++) {
      const row = height - cnt + r; // r=0 -> top-most ground row (surface)
      grid[row * width + x] = col[cnt - 1 - r];
    }
  }
  return { width, height, data: grid };
}

/**
 * Return the mountain silhouette and the sky/ground index split. Mirrors
 * mtn.surface_profile(path).
 *
 *   surface[x]      = top-most GROUND row of column x (= height - count[x]);
 *                     equals height where the column is empty (count 0).
 *   counts[x]       = stored ground-pixel count per column.
 *   sky_indices     = [sky_index].
 *   ground_indices  = sorted palette indices occurring as stored GROUND pixels,
 *                     EXCLUDING the sky index (from the actual decoded image).
 */
export function surfaceProfile(input: Uint8Array, name = "<mtn>"): SurfaceProfile {
  const { hdr, counts, columns } = decodeColumns(input, name);
  const width = hdr.width;
  const height = hdr.height;
  const sky_index = hdr.sky_index;
  const surface = new Int32Array(width);
  for (let x = 0; x < width; x++) surface[x] = height - counts[x];
  const used = new Set<number>();
  for (const col of columns) {
    for (let i = 0; i < col.length; i++) used.add(col[i]);
  }
  used.delete(sky_index);
  const ground = Array.from(used).sort((a, b) => a - b);
  return {
    surface,
    counts: counts.slice(),
    height,
    width,
    xoff: hdr.xoff,
    sky_indices: [sky_index],
    ground_indices: ground,
  };
}

/**
 * Decode to a flat row-major RGB image (height*width*3 bytes). Mirrors
 * mtn.to_rgb(path, sky_rgb).
 *
 * GROUND pixels use the file palette. SKY cells (-1) are painted `sky_rgb` (the
 * engine draws a configurable sky gradient there; a flat blue is enough to
 * confirm the silhouette). Genuine white sky-color holes (palette index 0)
 * render as their palette white, distinct from the unstored sky.
 *
 * Returns { width, height, data } where data[(y*width + x)*3 + c] matches numpy's
 * C-order flatten of the (height, width, 3) uint8 array.
 */
export interface MtnRgb {
  width: number;
  height: number;
  /** flat row-major RGB (data[(y*width + x)*3 + c]). */
  data: Uint8Array;
}

export function toRgb(
  input: Uint8Array,
  skyRgb: Rgb = [96, 128, 192],
  name = "<mtn>",
): MtnRgb {
  const hdr = parseHeader(input, name);
  const palette = hdr.palette;
  const grid = decode(input, name);
  const { width, height, data: g } = grid;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < g.length; i++) {
    const idx = g[i];
    const o = i * 3;
    if (idx < 0) {
      // sky_mask: numpy first does rgb[:] = palette[where(mask,0,grid)] then
      // overwrites masked cells with sky_rgb; the net result for sky cells is
      // sky_rgb, which is what we write directly.
      rgb[o] = skyRgb[0];
      rgb[o + 1] = skyRgb[1];
      rgb[o + 2] = skyRgb[2];
    } else {
      const p = palette[idx];
      rgb[o] = p[0];
      rgb[o + 1] = p[1];
      rgb[o + 2] = p[2];
    }
  }
  return { width, height, data: rgb };
}
