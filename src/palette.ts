/**
 * 256-color VGA palette, recovered from SCORCH.EXE v1.5 by static RE.
 *
 * Faithful TypeScript port of scorch-py/scorch/palette.py (the fidelity oracle,
 * itself byte-verified against the DOS binary). Control flow and numeric behavior
 * are identical; the FUN_<seg>_<off> / DAT_ provenance from the Python source is
 * preserved verbatim so the lineage survives.
 *
 * NUMERIC NOTES (differential gate, test/palette.test.ts):
 *   - Integer/index/pixel/boolean RGB values are reproduced EXACTLY.
 *   - The Python original stores RGB in a numpy (256,3) uint8 array. uint8
 *     assignment of a Python float truncates toward zero (astype/store), so the
 *     port uses Math.trunc (toward zero) and clamps with min(255, ...) where the
 *     Python does. No value in build_palette/digger/firewall exceeds 255, so the
 *     uint8 wrap is never exercised; LiveLUT.reramp_band CLIPS to [0,255] first.
 *   - LiveLUT.reramp_band reproduces numpy's FLOAT32 ramp arithmetic. numpy
 *     linspace(0,1,n,dtype=float32) (v2.5.0) equals the float64 linspace cast to
 *     float32, and the ramp a*(1-t)+b*t runs in float32. The port computes the
 *     linspace in JS doubles (= float64) and applies Math.fround (= cast to
 *     float32) at each operation to match numpy bit-for-bit. (VERIFIED: 0
 *     mismatches over 18,960 channel values across n=1..79 and 6 endpoint sets.)
 *
 * --- PROVENANCE (from palette.py module head) ---------------------------------
 * The original builds its palette by writing VGA DAC registers one at a time
 * through `FUN_556b_0005(idx, r6, g6, b6)`.  Disassembly of that function
 * (SCORCH_FP.EXE 556b:0005, file_off 0x4c0b5) shows it stacks a 6-byte BIOS
 * parameter block {0x10, 0x10, idx:word, r:byte, g:byte, b:byte} and far-calls
 * `FUN_1000_3688`, which builds an `INT 10h` trampoline on the stack (1000:36bd:
 * `mov byte[bp-0xd],0xcd` + AL=0x10).  AH=0x10/AL=0x10 is VGA BIOS "set one DAC
 * register": BX=index, DH=R, CH=G, CL=B, each 6-bit (0..63).  The DAC presents
 * 6-bit channels; the canonical 6->8 expansion is `v8 = v6 << 2`.  All RGB below
 * is stored 8-bit (already <<2) so this table is the on-screen truth.
 *
 * There is NO single palette-generator function and NO master 256-entry RGB
 * table.  The base palette the engine shows is written DIRECTLY to the VGA DAC,
 * one register at a time, by ~40 `FUN_556b_0005(idx,r6,g6,b6)` call sites: literal
 * constants in the boot path (FUN_33a1_001d), or copies of two static data tables
 * (team @0x57e2, dirt @0x5036). Every static RGB below is byte-exact.
 *
 * Runtime-input-dependent bands (explosion ring 0xc9..0xdd, per-projectile body
 * 0xa3/0xa4, tank health-bar) have no single static RGB: the engine fades the
 * firing/owning tank's team color by remaining strength. The fade ALGORITHM is
 * exact; only its color INPUT is a runtime choice, always one of the 10 byte-exact
 * team colors. They are filled from the static team table so the index bands the
 * rest of the port reads stay intact.
 *
 * Index-band semantics consumed by the rest of the port are preserved verbatim:
 * constants.is_dirt = (idx==0x50 or 0x58<=idx<=0x68); explosion 0xc8..0xf0;
 * COL_LASER 0xe6; tank/object colors at idx >= 0x69.
 *
 * TANK STROKE SHADES band [player*8, player*8+7] (0x00..0x4f): written by lifted
 * code (FUN_3014_1a52 / FUN_3014_19e5 via the ef08/eefc far-ptr block-upload).
 * Per-slot rule: slot in {0,1,2,3,4,6} -> flat team color; slot 5 -> white shield
 * highlight; slot 7 -> dark grey tread; CGA/mono -> black. build_palette() leaves
 * 0x00..0x4f at EGA defaults because the port tints tank pixels by RGB through
 * sprites._shade_rgb, not by indexing this DAC band.
 */

import * as C from "./constants";

/** 6-bit DAC value -> 8-bit, the engine's `<< 2` expansion (see module head).
 *  Mirrors palette._e8: min(255, (int(v6) & 0x3F) << 2). The & 0x3F matches
 *  Python's two's-complement bitwise-and on negatives (e.g. -1 & 0x3F == 63),
 *  which TS bitwise-& also yields for 32-bit ints, so negative v6 agrees. */
function _e8(v6: number): number {
  return Math.min(255, (Math.trunc(v6) & 0x3f) << 2);
}

type RGB = [number, number, number];

function _rgb8(r6: number, g6: number, b6: number): RGB {
  return [_e8(r6), _e8(g6), _e8(b6)];
}

// ---------------------------------------------------------------------------
// Static data table DAT_5f38_57e2: the 10 team/tank colors (6-bit), byte-exact
// from SCORCH_FP.EXE data seg (file base 0x55d80, seg-off 0x57e2, per-entry
// stride 6 bytes = 3 words R,G,B).  Written to DAC indices 0x6e..0x77 by
// FUN_3a16_18d0; copied into every tank/projectile via obj+0x1c.
// ---------------------------------------------------------------------------
export const TANK_COLOR_BASE = 0x6e; // FUN_3a16_18d0: idx = 0x6e + player
const _TEAM_RGB6: RGB[] = [
  [63, 10, 10], // 0x6e  red
  [35, 55, 10], // 0x6f  yellow-green
  [40, 20, 63], // 0x70  violet
  [63, 63, 10], // 0x71  yellow
  [10, 63, 63], // 0x72  cyan
  [63, 10, 63], // 0x73  magenta
  [60, 60, 60], // 0x74  light grey / white
  [63, 40, 20], // 0x75  orange
  [20, 63, 40], // 0x76  mint green
  [0, 0, 63], // 0x77  blue
];
// 8-bit form, exposed for sprites.ts (it samples the 10 team hues by RGB).
export const TEAM_RGB: RGB[] = _TEAM_RGB6.map((c) => _rgb8(c[0], c[1], c[2]));

// Dirt table DAT @ seg 0x5036 (6 triples; FUN_323a_049c picks one per round).
// Index 0 is the default brown the boot palette/plain mode shows first.
// BYTE-EXACT: read direct from SCORCH.EXE data seg (file 0x55d80+0x5036); the
// 6-entry stride-6 layout and the per-round pick FUN_323a_049c.c:11-14
// (`iVar1=FUN_3bf9_048b(6); dd4c/4e/50 = *(iVar1*6+0x5036)`) are confirmed.
const _DIRT_RGB6: RGB[] = [
  [38, 25, 17], // 0  brown   (default)
  [54, 36, 28], // 1  tan
  [53, 53, 47], // 2  pale grey-tan
  [20, 62, 20], // 3  green
  [9, 35, 9], // 4  dark green
  [36, 54, 28], // 5  light green
];

// In-game sky gradient band 0x78..0x95, BYTE-EXACT from the sky builder
// FUN_42c2_0ba5.c:12-15:  for k in 0..29: staging[k] = (0x1d-k, 0x1d-k, 0x3f),
// then `(*eefc)(0x78, 0x1e)` uploads those 30 entries to DAC idx 0x78..0x95.
// So DAC index (0x78+k) holds 6-bit RGB (0x1d-k, 0x1d-k, 0x3f): a light blue-white
// at 0x78 fading to pure blue (0,0,0x3f) at 0x95.  This is the engine's default
// (PLAIN) sky ramp; STORMY/SUNSET/etc. re-ramp the same band at runtime via
// LiveLUT.reramp_band.  (FACT, recovered from the builder's literal arithmetic.)
export const SKY_RAMP_LEN = 0x1e; // 30 entries, the eefc count
function _sky_band_rgb6(): RGB[] {
  const out: RGB[] = [];
  for (let k = 0; k < SKY_RAMP_LEN; k++) out.push([0x1d - k, 0x1d - k, 0x3f]);
  return out;
}
export const SKY_RAMP_TOP6: RGB = [0x1d, 0x1d, 0x3f]; // idx 0x78 (k=0)
export const SKY_RAMP_BOTTOM6: RGB = [
  0x1d - (SKY_RAMP_LEN - 1),
  0x1d - (SKY_RAMP_LEN - 1),
  0x3f,
]; // idx 0x95 (k=29) = (0,0,0x3f)
// 8-bit endpoints, exposed so the renderer can seed the band from the recovered
// source instead of a reconstructed screenshot match.
export const SKY_RAMP_TOP: RGB = _rgb8(SKY_RAMP_TOP6[0], SKY_RAMP_TOP6[1], SKY_RAMP_TOP6[2]);
export const SKY_RAMP_BOTTOM: RGB = _rgb8(
  SKY_RAMP_BOTTOM6[0],
  SKY_RAMP_BOTTOM6[1],
  SKY_RAMP_BOTTOM6[2],
);

/** A (256,3) RGB table type. Stored as an array of [r,g,b] integer triples,
 *  the TS analogue of the Python numpy (256,3) uint8 array. */
export type PaletteTable = RGB[];

export function build_palette(): PaletteTable {
  // numpy.zeros((256,3), uint8) -> all black.
  const pal: PaletteTable = [];
  for (let i = 0; i < 256; i++) pal.push([0, 0, 0]);

  // --- 0x00 background / sky-empty (index < 0x50 reads as empty/sky/gap).
  // The boot palette leaves 0x00 black; the sky is drawn as a fill, not a DAC
  // color.  Keep a near-black so empties don't read as a hue.
  pal[C.COL_SKY] = [0, 0, 0];

  // --- 0x01..0x0F: standard EGA/CGA 16-color set for HUD text/frames.  The
  // engine inherits these from the BIOS default DAC (it never rewrites 1..0xF);
  // reproduce the canonical IBM 16-color palette.
  const ega: RGB[] = [
    [0, 0, 0],
    [0, 0, 170],
    [0, 170, 0],
    [0, 170, 170],
    [170, 0, 0],
    [170, 0, 170],
    [170, 85, 0],
    [170, 170, 170],
    [85, 85, 85],
    [85, 85, 255],
    [85, 255, 85],
    [85, 255, 255],
    [255, 85, 85],
    [255, 85, 255],
    [255, 255, 85],
    [255, 255, 255],
  ];
  for (let i = 0; i < ega.length; i++) pal[i] = [ega[i][0], ega[i][1], ega[i][2]];

  // --- 0x50 dirt (FUN_323a_083f.c:31 / FUN_262c_013e.c:32: idx 0x50 <- live
  // dirt triple DAT_5f38_dd4c..dd50, sourced from the 6-entry dirt table).
  // Default to dirt[0]; per-round variation is a runtime pick over this table.
  pal[C.COL_DIRT] = _rgb8(_DIRT_RGB6[0][0], _DIRT_RGB6[0][1], _DIRT_RGB6[0][2]);

  // --- 0x58..0x68 shaded-dirt band.  No boot DAC write targets 0x58..0x68;
  // the shaded-terrain renderer lights the base dirt color across this band
  // (dark face -> lit face).  Reproduce as the dirt color ramped 0.45x -> 1.0x
  // so is_dirt() reads identically and shaded terrain looks lit, not flat.
  const dr = pal[C.COL_DIRT][0];
  const dg = pal[C.COL_DIRT][1];
  const db = pal[C.COL_DIRT][2];
  const span = C.DIRT_SHADE_HI - C.DIRT_SHADE_LO;
  for (let i = C.DIRT_SHADE_LO; i <= C.DIRT_SHADE_HI; i++) {
    const t = (i - C.DIRT_SHADE_LO) / span; // 0..1 dark->lit
    const f = 0.45 + 0.55 * t;
    // Python int(dr*f) truncates toward zero -> Math.trunc.
    pal[i] = [Math.trunc(dr * f), Math.trunc(dg * f), Math.trunc(db * f)];
  }

  // --- 0x6e..0x77 team/tank colors: byte-exact static table (FUN_3a16_18d0).
  for (let k = 0; k < _TEAM_RGB6.length; k++) {
    const rgb6 = _TEAM_RGB6[k];
    pal[TANK_COLOR_BASE + k] = _rgb8(rgb6[0], rgb6[1], rgb6[2]);
  }

  // --- 0x57, 0x78, 0x96..0xa2: HUD / control / shading set.  Byte-exact from
  // the boot DAC writes in FUN_33a1_001d.c:106-120 (6-bit args, recovered
  // literal; the DAT_5f38_efXX operands are palette INDICES set at :96-105).
  const boot: [number, RGB][] = [
    [0x57, [0x28, 0x28, 0x3f]], // panel blue (FUN_323a_017d confirms)
    [0x78, [0x09, 0x09, 0x1f]], // dark blue UI base
    [0x96, [0x32, 0x32, 0x32]], // grey
    [0x97, [0x2d, 0x2d, 0x2d]], // \ DAT_ef2a..   grey ramp (HUD shading):
    [0x98, [0x00, 0x00, 0x00]], // | DAT_ef2c     black
    [0x99, [0x1e, 0x1e, 0x1e]], // | DAT_ef24
    [0x9a, [0x28, 0x28, 0x3f]], // | light blue
    [0x9b, [0x3f, 0x3f, 0x3f]], // | DAT_ef26     white
    [0x9c, [0x0f, 0x0f, 0x0f]], // | DAT_ef32
    [0x9d, [0x32, 0x32, 0x32]], // | grey
    [0x9e, [0x05, 0x05, 0x05]], // | DAT_ef30     near-black
    [0x9f, [0x37, 0x37, 0x37]], // / DAT_ef2e
    [0xa0, [0x14, 0x3c, 0x14]], // green (FUN_27a8_0930)
    [0xa1, [0x0a, 0x3f, 0x3f]], // bright cyan (DAT_ef.. cursor)
    [0xa2, [0x2d, 0x2d, 0x2d]], // DAT_ef20 bright grey (FUN_4f19_43c2)
  ];
  for (const [idx, rgb6] of boot) {
    pal[idx] = _rgb8(rgb6[0], rgb6[1], rgb6[2]);
  }

  // --- 0x78..0x95 in-game sky gradient band, BYTE-EXACT (FUN_42c2_0ba5.c:12-15).
  // The boot write above leaves 0x78 = (9,9,0x1f) as the menu/UI backdrop; once a
  // round's sky builder runs it fills the whole 0x78..0x95 band with the recovered
  // ramp (0x1d-k, 0x1d-k, 0x3f).  build_palette() is the at-rest IN-GAME table the
  // renderer composites terrain/sky through, so lay down the in-game sky ramp here
  // (overwriting the transient 0x78 UI value).  Per-round STORMY/SUNSET re-ramps
  // mutate this same band on the LiveLUT at runtime.
  const skyBand = _sky_band_rgb6();
  for (let k = 0; k < skyBand.length; k++) {
    const rgb6 = skyBand[k];
    pal[SKY_BAND_LO + k] = _rgb8(rgb6[0], rgb6[1], rgb6[2]);
  }

  // --- 0xc8..0xf0 explosion band.  The engine recolors these per shot to the
  // firing tank's team color faded by remaining strength
  // (FUN_4191_06ca.c:20-26: comp = teamcolor * strength / max), and draws ring
  // index `0xDD - curR*20/maxR` into them (FUN_4451_000f.c:21-23).  No single
  // static RGB exists; build the fade ramp the engine computes, using a
  // representative hot color (the white/orange fireball) so render.ts's
  // pal[0xDD - r*20/maxR] lookup yields a hot->cool ring at rest.
  //   index 0xdd = inner/hottest, lower indices (toward 0xc8) = outer/cooler.
  const HOT: RGB = [252, 220, 120]; // fireball core tint (warmed boot core)
  for (let i = C.EXPLOSION_LO; i <= C.EXPLOSION_HI; i++) {
    // position 1.0 at 0xdd (ring base) falling toward the outer edge.
    let t = (i - C.EXPLOSION_LO) / (C.EXPLOSION_RING_BASE - C.EXPLOSION_LO);
    t = Math.max(0.0, Math.min(1.0, t));
    const r = Math.trunc(HOT[0] * t);
    const g = Math.trunc(HOT[1] * Math.pow(t, 1.4));
    const b = Math.trunc(HOT[2] * Math.pow(t, 2.2));
    pal[i] = [r, g, b];
  }

  // Byte-exact explosion/flash accent slots (disassembled literal RGB):
  pal[0xc8] = _rgb8(0x3c, 0x3c, 0x3c); // hot core white (FUN_3ef5_029a 3ef5:02d8)
  pal[0xcb] = _rgb8(0x28, 0x28, 0x28); // ring grey (FUN_3ef5_029a:31)
  pal[0xfe] = _rgb8(0x28, 0x0f, 0x0f); // smoke dark-red (FUN_3f76_03bd)
  pal[0xff] = _rgb8(0x3f, 0x3f, 0x3f); // white flash (FUN_2a4a_02f2/4855_0373)

  // --- laser beam: byte-exact 3-slot set (FUN_3319_0516 3319:05e8-0x613).
  pal[C.COL_LASER] = _rgb8(0x14, 0x3c, 0x3c); // 0xe6 cyan core
  pal[0xe7] = _rgb8(0x14, 0x3c, 0x14); // 0xe7 green glow
  pal[0xe8] = _rgb8(0x14, 0x14, 0x3c); // 0xe8 blue glow

  // --- tracer/smoke (port band; no distinct boot DAC write, kept warm-white).
  pal[C.COL_TRACER] = [252, 240, 200];

  return pal;
}

/** Palette index for a tank's body color (engine: 0x6e + player, mod 10).
 *  Python `player_index % len(_TEAM_RGB6)` uses floor modulo (result has the
 *  divisor's sign), so negative indices wrap up to [0,10). TS `%` is truncated
 *  (sign of the dividend), so reproduce Python floor-mod explicitly. */
export function tank_color_index(player_index: number): number {
  const n = _TEAM_RGB6.length;
  return TANK_COLOR_BASE + (((player_index % n) + n) % n);
}

// ===========================================================================
// MASTER ANIMATION PRIMITIVE -- the mutable DAC palette LUT
// ===========================================================================
// The binary animates by mutating its 256-entry DAC staging buffer DAT_5f38_6862
// and re-uploading it, retrace-synced, every IRQ0 tick.  Two operations cover
// every cycling band:
//   * rotate-one-step : FUN_4d9b_003b.c:22-33 memmoves the band down one RGB
//                       triplet and wraps the first entry to the end.  This is
//                       rotate_band(lo,hi,1).
//   * re-ramp a band  : the sky/flash builders fill a band with a fresh color
//                       ramp via per-entry sets `ef08` (FUN_4d9b_00a8) before the
//                       upload.  This is reramp_band(lo,hi,rgb_lo,rgb_hi).
// The renderer composites THROUGH this live LUT, so when game.ts rotates/re-ramps
// a band the on-screen colors of every pixel indexed into that band flow with it.
//
// FACT: bands/rotate/ramp formulas are read from the cited decompiles. The INT 08h
// ISR only INC's a counter, sends EOI, chains BIOS every 200 ticks; it does NOT
// touch the DAC. The visible band-scroll ceiling is the DAC upload's
// vertical-retrace gate (VGA mode-13h 70.086 Hz). game._tick_palette advances the
// cycling bands on a wall-clock accumulator at C.PALETTE_CYCLE_HZ = 70.

// --- cycling band bounds (FACT; closed intervals [lo, hi], inclusive) ----------
// Sky/background gradient march (FUN_42c2_0ba5.c:12-15 builds it, eefc(0x78,0x1e)
// uploads+rotates; count 0x1e = 30 entries 0x78..0x95).
export const SKY_BAND_LO = 0x78,
  SKY_BAND_HI = 0x95;
// Explosion / nuke fireball red band (FUN_4d1e_00ae.c:11-17 ramps idx 200..239;
// FUN_4d1e_015a.c:36 uploads it eefc(200,0x28), count 0x28 = 40 -> 0xC8..0xEF).
export const EXPLO_BAND_LO = 0xc8,
  EXPLO_BAND_HI = 0xef;
// Lightning ground-strike screen flash (FUN_480f_0219.c:26-49 ramps band 0x78,0x1e
// up then down; count 0x1e = 30 -> 0x78..0x95, the sky band).
export const LIGHTNING_BAND_LO = 0x78,
  LIGHTNING_BAND_HI = 0x95;
// Standalone thunder multi-flicker (FUN_480f_0148.c:13-27 band 0x82,0x14; count
// 0x14 = 20 -> 0x82..0x95).
export const THUNDER_BAND_LO = 0x82,
  THUNDER_BAND_HI = 0x95;
// Digger / tunneler trail glow cycle.  PROVENANCE CORRECTED: the 0xAF..0xB8 band
// and 10-step cycle were read from FUN_352c_00c9 (:107,111,118,128), but that
// routine has 0 callers and is the WINNER/FANFARE render path, NOT the digger.
// The real digger path is FUN_2a4a_1349.c:200-219 + span-clear FUN_262c_0078,
// whose glow band is BLOCKED (the 0x99c stepper is un-decompiled).  So 0xAF..0xB8
// is RECONSTRUCTED (borrowed from the fanfare routine's band), NOT confirmed for
// the digger.
export const DIGGER_BAND_LO = 0xaf,
  DIGGER_BAND_HI = 0xb8;
// Score / rankings-screen cycle (FUN_3cc4_1666.c:9 scoreboard `(*ef04)(0xb4,0x28)`;
// FUN_3014_0860.c:9-13 round-screen step; count 0x28 = 40 -> 0xB4..0xDB).
export const RANKINGS_BAND_LO = 0xb4,
  RANKINGS_BAND_HI = 0xdb;
// Dialog open/close palette flash (FUN_2d4f_0258 cluster; master table row L:
// `(*ef04)(0xaa,0x1e)` per wipe frame; count 0x1e = 30 -> 0xAA..0xC7).
export const DIALOG_BAND_LO = 0xaa,
  DIALOG_BAND_HI = 0xc7;
// Firewall fire shimmer (FUN_1dbc_0874.c:70 `(*eefc)(0xaa,0x14)` upload; count
// 0x14 = 20 -> 0xAA..0xBD).  Within it: flame idx 8-11 (:14-45, every 8th tick,
// from the flame table @0x1f62), ember stripe idx 0xE-0x12 (:46-69), pulse idx 2
// (:13).
export const FIREWALL_BAND_LO = 0xaa,
  FIREWALL_BAND_HI = 0xbd;
export const FIREWALL_FLAME_LO = 0x08,
  FIREWALL_FLAME_HI = 0x0b; // flame-table cycle (:14-45)
export const FIREWALL_EMBER_LO = 0x0e,
  FIREWALL_EMBER_HI = 0x12; // ember stripe (:46-69)
export const FIREWALL_PULSE_IDX = 0x02; // red/orange glow pulse (:13)

/** Cast a JS double to IEEE-754 single precision. numpy float32 ops are matched
 *  by forcing each intermediate to float32 with this. */
function f32(x: number): number {
  return Math.fround(x);
}

export class LiveLUT {
  /** A mutable 256-entry RGB lookup table, initialized from build_palette(), that
   *  the renderer indexes through and game.ts mutates per frame.
   *
   *  This is the port's stand-in for the binary's DAC staging buffer
   *  (DAT_5f38_6862) plus the retrace-synced rotate/upload routines.  Mutating an
   *  entry here and re-rendering is the equivalent of writing the DAC register and
   *  letting the next CRT refresh show it.
   *
   *  `table` is a (256, 3) integer-RGB array.  `rev` is bumped on every mutation so
   *  a consumer can cheaply detect "the LUT changed since I last cached it" without
   *  diffing the array (render.ts uses it to invalidate its cached sky plane). */

  table: PaletteTable;
  rev: number;

  constructor(table?: PaletteTable) {
    if (table === undefined) {
      table = build_palette();
    }
    // Deep-copy into a contiguous (256,3) integer table, mirroring
    // np.ascontiguousarray(table, dtype=uint8): each channel stored as an int.
    if (table.length !== 256) {
      throw new Error(`LiveLUT expects a (256,3) table, got length ${table.length}`);
    }
    this.table = [];
    for (let i = 0; i < 256; i++) {
      const row = table[i];
      if (row.length !== 3) {
        throw new Error(`LiveLUT expects a (256,3) table, got row ${i} length ${row.length}`);
      }
      // uint8 store: mask to a byte (the Python array dtype is uint8). Inputs to
      // LiveLUT here are already 0..255, so this is identity for valid data.
      this.table.push([row[0] & 0xff, row[1] & 0xff, row[2] & 0xff]);
    }
    this.rev = 0;
  }

  /** Index like the underlying array so existing `pal[i]` call sites work
   *  unchanged when handed a LiveLUT (render.ts, ui.ts). Returns the live [r,g,b]
   *  row (mirrors numpy returning a view: callers read it, they do not detach). */
  get(idx: number): RGB {
    return this.table[idx];
  }

  /** A detached (256,3) integer copy of the current entries. */
  copy_table(): PaletteTable {
    const out: PaletteTable = [];
    for (let i = 0; i < 256; i++) {
      const r = this.table[i];
      out.push([r[0], r[1], r[2]]);
    }
    return out;
  }

  /** Cyclically rotate entries [lo..hi] (inclusive) by `step` positions.
   *
   *  Mirrors FUN_4d9b_003b.c:22-33: the staging buffer is memmoved down one triplet
   *  and the displaced entry wraps to the end -- one entry of palette rotation per
   *  call.  `step` > 1 applies that many one-entry rotations at once; negative
   *  `step` rotates the other way.  Indices outside [lo..hi] are untouched.
   *
   *  Python uses np.roll(band, s, axis=0): entry at position k moves to (k+s) mod n
   *  with wrap. The guard `if s == 0: return` happens BEFORE `self.rev += 1`, so a
   *  net-zero rotation (step % n == 0) does NOT bump rev. */
  rotate_band(lo: number, hi: number, step: number = 1): void {
    lo = Math.trunc(lo);
    hi = Math.trunc(hi);
    if (hi <= lo) {
      return;
    }
    const n = hi - lo + 1;
    // Python `int(step) % n` is floor-mod (non-negative for n > 0).
    const st = Math.trunc(step);
    const s = ((st % n) + n) % n;
    if (s === 0) {
      return;
    }
    // np.roll(+s): result[(k+s) mod n] = band[k], i.e. result[j] = band[(j - s) mod n].
    const band: RGB[] = [];
    for (let k = 0; k < n; k++) {
      const r = this.table[lo + k];
      band.push([r[0], r[1], r[2]]);
    }
    for (let j = 0; j < n; j++) {
      const src = ((j - s) % n + n) % n;
      this.table[lo + j] = band[src];
    }
    this.rev += 1;
  }

  /** Rebuild band [lo..hi] (inclusive) as a linear RGB ramp from `rgb_lo` at index
   *  `lo` to `rgb_hi` at index `hi`.
   *
   *  Mirrors the sky/flash builders that fill a band with a fresh per-entry ramp
   *  (`ef08`/FUN_4d9b_00a8 per-entry sets) before uploading it: e.g. the blue->white
   *  sky ramp (FUN_42c2_0ba5.c:12-15) and the lightning red ramp
   *  (FUN_480f_0219.c:26-32, idx scaled toward (0x3f,0x3f,0x3f)).
   *
   *  FLOAT32 FIDELITY: the Python uses np.float32 throughout
   *  (a,b = float32(rgb); t = linspace(0,1,n,float32); ramp = a*(1-t)+b*t), then
   *  np.clip(0,255).astype(uint8) (truncates toward zero). numpy 2.5.0's float32
   *  linspace equals the float64 linspace cast to float32, so t is computed in JS
   *  doubles (= float64) with the endpoint pinned, then cast per-element with f32;
   *  the ramp arithmetic is then done with f32 at every operation. */
  reramp_band(lo: number, hi: number, rgb_lo: RGB, rgb_hi: RGB): void {
    lo = Math.trunc(lo);
    hi = Math.trunc(hi);
    if (hi < lo) {
      return;
    }
    const n = hi - lo + 1;
    const a: RGB = [f32(rgb_lo[0]), f32(rgb_lo[1]), f32(rgb_lo[2])];
    const b: RGB = [f32(rgb_hi[0]), f32(rgb_hi[1]), f32(rgb_hi[2])];
    // t = np.linspace(0.0, 1.0, n, dtype=float32): float64 i/(n-1) with y[-1]=1.0,
    // each element cast to float32.
    const t: number[] = [];
    if (n === 1) {
      t.push(f32(0.0));
    } else {
      const div = n - 1;
      const step = 1.0 / div; // float64
      for (let i = 0; i < n; i++) t.push(f32(i * step)); // float64 i*step, cast f32
      t[n - 1] = f32(1.0); // numpy pins the endpoint exactly
    }
    for (let k = 0; k < n; k++) {
      const tk = t[k];
      const oneMinus = f32(1.0 - tk); // numpy float32-keeps with a python scalar
      const row: RGB = [0, 0, 0];
      for (let ch = 0; ch < 3; ch++) {
        const term1 = f32(a[ch] * oneMinus);
        const term2 = f32(b[ch] * tk);
        const v = f32(term1 + term2);
        // np.clip(v, 0, 255) then .astype(uint8) (trunc toward zero).
        row[ch] = Math.trunc(Math.min(255.0, Math.max(0.0, v)));
      }
      this.table[lo + k] = row;
    }
    this.rev += 1;
  }

  /** Overwrite band [lo..hi] (inclusive) with explicit RGB rows (an
   *  (hi-lo+1, 3) array).  Used to restore a band to its build_palette() base after
   *  an effect ends (e.g. the explosion band reverts to the at-rest hot ramp once a
   *  fireball is gone). Mirrors Python `rows[:hi-lo+1]` (truncates overlong input). */
  set_band(lo: number, hi: number, rgb_rows: RGB[]): void {
    lo = Math.trunc(lo);
    hi = Math.trunc(hi);
    const count = hi - lo + 1;
    for (let k = 0; k < count; k++) {
      const r = rgb_rows[k]; // rows[:hi-lo+1] -> only first count rows are read
      // uint8 store.
      this.table[lo + k] = [r[0] & 0xff, r[1] & 0xff, r[2] & 0xff];
    }
    this.rev += 1;
  }

  /** Overwrite a single entry (the `ef08`/FUN_4d9b_00a8 per-entry set). */
  set_index(idx: number, rgb: RGB): void {
    // uint8 store.
    this.table[Math.trunc(idx)] = [rgb[0] & 0xff, rgb[1] & 0xff, rgb[2] & 0xff];
    this.rev += 1;
  }
}

// ===========================================================================
// DIGGER TRAIL GLOW RAMP -- the 0xAF band the digger cycles
// ===========================================================================
// FUN_352c_00c9.c:21-33 builds the 0xAF band (the `ef08` per-entry sets) as:
//   :21-24  idx+0..4   blend dirt(DAT_5f38_dd4c..50) -> white over 5 entries
//                       (((i+1)*0x3f + (4-i)*dirt) / 5, ...): a hot crust ramp.
//   :25-27  idx+5..0xE white fading down: (0x3f - i*5) on R,G with B held 0x3f.
//   :28-33  idx+0xF..0x14 six fixed glow colors (0x3f,0x3f,10 etc.).
// The port cycles only the 10-entry head 0xAF..0xB8 (count 10), so we build those
// 10 entries: the 5 crust-blend + 5 of the white fade.  The dirt operand is the
// live dirt color (build_palette's 0x50), 6-bit.
export function digger_glow_ramp6(dirt_rgb6?: RGB): RGB[] {
  // The 10 6-bit RGB entries the digger cycles (FUN_352c_00c9.c:21-27, first 10 of
  // the 0xAF band). `dirt_rgb6` defaults to the round-default dirt[0].
  if (dirt_rgb6 === undefined) {
    dirt_rgb6 = _DIRT_RGB6[0];
  }
  const dr = dirt_rgb6[0];
  const dg = dirt_rgb6[1];
  const db = dirt_rgb6[2];
  const out: RGB[] = [];
  for (let i = 0; i < 5; i++) {
    // :21-24 dirt->white crust blend. Python `//` is floor division; operands are
    // all non-negative integers here, so Math.floor matches.
    out.push([
      Math.floor(((i + 1) * 0x3f + (4 - i) * dr) / 5),
      Math.floor(((i + 1) * 0x14 + (4 - i) * dg) / 5),
      Math.floor(((i + 1) * 0x14 + (4 - i) * db) / 5),
    ]);
  }
  for (let i = 0; i < 5; i++) {
    // :25-27 white fading (first 5)
    const v = i * -5 + 0x3f;
    out.push([v, v, 0x3f]);
  }
  return out;
}

/** 8-bit form of digger_glow_ramp6 (the 10 entries 0xAF..0xB8). */
export function digger_glow_rgb(dirt_rgb6?: RGB): RGB[] {
  return digger_glow_ramp6(dirt_rgb6).map((c) => _rgb8(c[0], c[1], c[2]));
}

// ===========================================================================
// FIREWALL FLAME TABLE -- the data @0x1f62 the shimmer cycles into idx 8-11
// ===========================================================================
// FUN_1dbc_0874.c:24-47 reads 4 flame colors from the static data table at
// data-seg-off 0x1f62 (file 0x57ce2; stride 6 bytes = 3 words R,G,B 6-bit) and
// cycles them through DAC idx 8..0xB every 8th tick.  The table-index walk uses
// `uVar2` in 1..4 (:20-23), i.e. it reads entries `*(uVar2*6+0x1f62)` = the table's
// entries 1,2,3,4; entry 0 (off 0x1f62 = (63,0,0)) is never read.  These four
// triples are BYTE-EXACT (recovered direct from the binary bytes, stride/offset
// confirmed). They are NOT a clean red->white ramp: (orange, magenta, dim-red,
// pink), a deliberately garish shimmer set.
const _FIREWALL_FLAME6: RGB[] = [
  [0x3f, 0x20, 0x0a], // entry 1 @0x1f68 -> DAC idx 8 (uVar2=1): orange
  [0x3f, 0x00, 0x3f], // entry 2 @0x1f6e -> DAC idx 9 (uVar2=2): magenta
  [0x3f, 0x0c, 0x0c], // entry 3 @0x1f74 -> DAC idx 10 (uVar2=3): dim red
  [0x3f, 0x00, 0x1e], // entry 4 @0x1f7a -> DAC idx 0xB (uVar2=4): pink/red
];

/** Reproduce one FUN_1dbc_0874 tick on `lut` for fire-shimmer `counter`.
 *
 *  Mirrors the decompile entry-for-entry; mutates the firewall bands on `lut`:
 *    * pulse idx 2 (:13): R=(u*0x3f)/0x32, G=(u*10)/0x32, B=0, u = the triangle
 *      fold of `counter` over [0,100] (:8-12).
 *    * flame idx 8-11 (:14-45): every 8th tick, set from the 4-entry flame table
 *      cycling 1..4.
 *    * ember stripe idx 0xE-0x12 (:46-69): one index ((counter>>1)%5 + 0xE) set
 *      black, the next four (wrapping in 0xE..0x12) set rising grey
 *      0xF/0x1e/0x2d/0x3c.
 *  `counter` is the binary's DAT_5f38_00ec (caller increments + folds at 100). All
 *  RGB written 8-bit via _rgb8 (the DAC 6->8 expansion).
 *
 *  INTEGER DIVISION: Python `//` is floor division. All operands on these paths are
 *  non-negative integers (ec in [0,100], u in [0,49]), so Math.floor matches. */
export function firewall_apply(lut: LiveLUT, counter: number): void {
  const ec = ((Math.trunc(counter) % 101) + 101) % 101; // int(counter) % 101 (floor-mod)
  const u = ec <= 0x31 ? ec : 100 - ec; // :8-12 triangle fold
  lut.set_index(FIREWALL_PULSE_IDX, _rgb8(Math.floor((u * 0x3f) / 0x32), Math.floor((u * 10) / 0x32), 0)); // :13
  if ((ec & 7) === 0) {
    // :14 every 8th tick
    // the decompile walks a table-index `v` = ((ec>>3)&3)+1, applying
    // `if (4 < v) v = 1` after each ++; v stays in 1..4 and the four DAC entries
    // 8,9,10,0xB read table words at offset v*6 (= entry v).  The reconstructed
    // table is 0-based of 4 flame colors, so entry v maps to
    // _FIREWALL_FLAME6[(v-1)%4].
    let v = ((ec >> 3) & 3) + 1; // :15-17, in 1..4
    for (let k = 0; k < 4; k++) {
      // idx 8,9,10,0xB (:18-45)
      const c = _FIREWALL_FLAME6[(((v - 1) % 4) + 4) % 4];
      lut.set_index(FIREWALL_FLAME_LO + k, _rgb8(c[0], c[1], c[2]));
      v += 1;
      if (v > 4) {
        // :21-23 (>4 -> 1)
        v = 1;
      }
    }
  }
  const blk = (ec >> 1) % 5; // :46 ember head
  lut.set_index(FIREWALL_EMBER_LO + blk, _rgb8(0, 0, 0)); // :47 black
  const greys = [0x0f, 0x1e, 0x2d, 0x3c]; // :54-69 rising grey
  let j = blk; // :48-69 next four, wrapping
  for (let k = 0; k < 4; k++) {
    j += 1;
    if (j > 4) {
      // :50-52 (>0x12 -> 0xE)
      j = 0;
    }
    lut.set_index(FIREWALL_EMBER_LO + j, _rgb8(greys[k], greys[k], greys[k]));
  }
}
