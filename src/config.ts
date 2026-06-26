/**
 * scorch.cfg schema -- a faithful TypeScript port of scorch-py/scorch/config.py
 * (the fidelity oracle, itself verified against 1.5/SCORCH.EXE).
 *
 * The Config dataclass holds the 50 persisted scorch.cfg keys (49 original writer
 * keys + ICON_BAR, a port-added 50th toggle), the enum string->index orderings,
 * derived accessors, and the KEY=value round-trip (load/save).
 *
 * PROVENANCE (preserved from config.py):
 *   - Enum default-byte bindings: catalog 13 s.0; SCORING/TEAM/PLAY_MODE/PLAY_ORDER
 *     default-byte verified.
 *   - ELASTIC sub-mode order: catalog 13 s.0 note on DAT_5f38_5156 (0..7). The
 *     Concrete<->Wrap swap fix (2026-06-25) is byte-resolved against parser
 *     FUN_22a5_0005: idx1=4f38:278e "Wrap-around", idx5=4f38:27af "Concrete".
 *   - FLATLAND / RANDOM_LAND / USELESS_ITEMS / TUNNELLING defaults follow the
 *     binary's no-scorch.cfg parser (FUN_22a5_0005.c) where it disagrees with the
 *     manual; the binary is authority (port/DEFAULTS_AUDIT.md).
 *   - __post_init__ live globals: DAT_5f38_515a wind, DAT_5f38_5154 live wall mode.
 *   - viscosity_mult: FUN_22a5_0005.c:245 (visc_mult = 1 - VISCOSITY/10000).
 *
 * NUMERIC NOTE: this module has no transcendental math. Every output is an integer,
 * an exactly-representable float (defaults are all exact in IEEE754), a boolean, or
 * a string, so the differential gate (test/config.test.ts) asserts everything with
 * exact equality. viscosity_mult = 1 - V/10000 is exact for the integer V range.
 *
 * CRITICAL FIDELITY POINT -- string->number coercion. The cfg parser coerces values
 * by field type using Python's built-in int()/float(), which reject inputs that JS
 * Number()/parseInt()/parseFloat() would silently accept (e.g. int("12.5") raises,
 * int("0x10") raises, "1e3" is not an int, parseInt would take 12/16/1). On a parse
 * failure _coerce returns 0 / 0.0. To reproduce config.py value-for-value, this port
 * implements Python's int()/float() string grammar directly (pyIntParse/pyFloatParse)
 * instead of leaning on JS coercion.
 */

import { VISCOSITY_DIV } from "./constants";

// Enum token -> internal index (catalog 13 s.0).
export const SCORING: { [k: string]: number } = { BASIC: 0, STANDARD: 1, GREEDY: 2 };
export const TEAM_MODE: { [k: string]: number } = { NONE: 0, STANDARD: 1, CORPORATE: 2, VICIOUS: 3 };
export const PLAY_MODE: { [k: string]: number } = { SEQUENTIAL: 0, SYNCHRONOUS: 1, SIMULTANEOUS: 2 };
export const PLAY_ORDER: { [k: string]: number } = {
  RANDOM: 0,
  "LOSERS-FIRST": 1,
  "WINNERS-FIRST": 2,
  "ROUND-ROBIN": 3,
};
// ELASTIC live sub-mode order (catalog 13 s.0 note on DAT_5f38_5156, 0..7).
// Concrete<->Wrap fix (2026-06-25): idx1="Wrap-around", idx5="Concrete".
export const ELASTIC: { [k: string]: number } = {
  NONE: 0,
  WRAP: 1,
  PADDED: 2,
  RUBBER: 3,
  SPRING: 4,
  CONCRETE: 5,
  RANDOM: 6,
  ERRATIC: 7,
};
export const EXPLOSION_SCALE: { [k: string]: number } = { NORMAL: 0, MEDIUM: 1, LARGE: 2 };

// Field type tag for each config key, mirroring the dataclass annotations. Used by
// _coerce on load and by save() (bool branch). Order matters: it is the save() write
// order and the fields() iteration order in config.py.
type FieldType = "int" | "float" | "str";
interface FieldSpec {
  name: string;
  type: FieldType;
}

// The 50 fields in declaration order (== dataclasses.fields(Config) order).
export const CONFIG_FIELDS: FieldSpec[] = [
  // gameplay
  { name: "MAXPLAYERS", type: "int" },
  { name: "MAXROUNDS", type: "int" },
  { name: "ARMS", type: "int" },
  { name: "PLAY_MODE", type: "str" },
  { name: "PLAY_ORDER", type: "str" },
  { name: "TEAM_MODE", type: "str" },
  { name: "HOSTILE_ENVIRONMENT", type: "str" },
  { name: "TUNNELLING", type: "str" },
  { name: "USELESS_ITEMS", type: "str" },
  { name: "EXPLOSION_SCALE", type: "str" },
  // economy
  { name: "INITIAL_CASH", type: "int" },
  { name: "INTEREST_RATE", type: "float" },
  { name: "COMPUTERS_BUY", type: "str" },
  { name: "FREE_MARKET", type: "str" },
  { name: "SCORING", type: "str" },
  // physics
  { name: "GRAVITY", type: "float" },
  { name: "AIR_VISCOSITY", type: "int" },
  { name: "MAX_WIND", type: "int" },
  { name: "CHANGING_WIND", type: "str" },
  { name: "ELASTIC", type: "str" },
  { name: "FALLING_TANKS", type: "str" },
  { name: "EDGES_EXTEND", type: "int" },
  { name: "DAMAGE_TANKS_ON_IMPACT", type: "str" },
  // terrain
  { name: "LAND1", type: "int" },
  { name: "LAND2", type: "int" },
  { name: "FLATLAND", type: "str" },
  { name: "RANDOM_LAND", type: "str" },
  { name: "MTN_PERCENT", type: "float" },
  { name: "SUSPEND_DIRT", type: "int" },
  { name: "EXTRA_DIRT", type: "str" },
  { name: "SKY", type: "str" },
  // display
  { name: "GRAPHICS_MODE", type: "str" },
  { name: "LOWMEM", type: "str" },
  { name: "FIRE_DELAY", type: "int" },
  { name: "FALLING_DELAY", type: "int" },
  { name: "STATUS_BAR", type: "str" },
  { name: "ICON_BAR", type: "str" },
  { name: "BOMB_ICON", type: "str" },
  { name: "TRACE", type: "str" },
  { name: "FAST_COMPUTERS", type: "str" },
  // input
  { name: "BIOS_KEYBOARD", type: "str" },
  { name: "POINTER", type: "str" },
  { name: "MOUSE_RATE", type: "float" },
  // sound
  { name: "SOUND", type: "str" },
  { name: "FLY_SOUND", type: "str" },
  // talk
  { name: "TALKING_TANKS", type: "str" },
  { name: "TALK_PROBABILITY", type: "int" },
  { name: "TALK_DELAY", type: "int" },
  { name: "ATTACK_COMMENTS", type: "str" },
  { name: "DIE_COMMENTS", type: "str" },
];

const FIELD_TYPE: { [name: string]: FieldType } = {};
for (const f of CONFIG_FIELDS) FIELD_TYPE[f.name] = f.type;

// A Config value is an int (stored as JS number), a float (JS number), or a string.
export type ConfigValue = number | string;

/**
 * Python `str.upper()` is locale-independent full-Unicode case mapping; for the
 * ASCII tokens used here it equals JS toUpperCase(). The config keys/enum tokens are
 * all ASCII, so this is exact for the relevant inputs.
 */
function pyUpper(s: string): string {
  return s.toUpperCase();
}

// ---------------------------------------------------------------------------
// Python int() / float() string parsing -- exact grammar reproduction.
//
// These mirror CPython's str->int (PyLong_FromString, base 10) and str->float
// (PyFloat_FromString) accepted syntax. They return a JS number on success, or
// null on a syntax that CPython would reject with ValueError. _coerce maps that
// null to 0 / 0.0, exactly as config.py's try/except does.
// ---------------------------------------------------------------------------

// Whitespace CPython strips around numeric literals. CPython uses Py_UNICODE_ISSPACE,
// which includes ASCII ws plus a handful of Unicode space chars (e.g. U+00A0 NBSP,
// observed in config.py: int("10\xa0") == 10). This set covers the characters that
// can appear in a hand-edited scorch.cfg line after .strip(); the cfg reader already
// applies str.strip() (ASCII+Unicode ws) to the value before _coerce, so leading/
// trailing ws here is normally pre-removed. Included for parity with direct _coerce.
const PY_WS = new Set([
  "\t",
  "\n",
  "\x0b",
  "\x0c",
  "\r",
  "\x1c",
  "\x1d",
  "\x1e",
  "\x1f",
  " ",
  "\x85",
  "\xa0",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  "　",
]);

function stripPyWs(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && PY_WS.has(s[start])) start++;
  while (end > start && PY_WS.has(s[end - 1])) end--;
  return s.slice(start, end);
}

/**
 * Reproduce Python's int(str) for base 10. Grammar (after stripping ws):
 *   [sign] digitpart        digitpart := digit (['_'] digit)*
 * Underscores: single, only BETWEEN digits (no leading/trailing/double). Returns the
 * integer as a JS number, or null on any rejected form. CPython int() accepts only
 * decimal digits 0-9 here (no '.', no 'e', no '0x'); those forms raise -> null.
 *
 * NOTE: scorch.cfg integers are all small (max ~1e6), well within Number's exact
 * integer range, so no BigInt is needed for the game's actual values. Very large
 * literals would lose precision in JS the same way they would not in Python, but no
 * config key carries such a value (DEFAULTS_AUDIT.md ranges).
 */
function pyIntParse(raw: string): number | null {
  const s = stripPyWs(raw);
  if (s.length === 0) return null;
  let i = 0;
  let sign = 1;
  if (s[i] === "+" || s[i] === "-") {
    if (s[i] === "-") sign = -1;
    i++;
  }
  const body = s.slice(i);
  if (body.length === 0) return null;
  // Validate digit/underscore structure: must start and end with a digit, and every
  // underscore must be flanked by digits (no doubles).
  if (!/^[0-9]/.test(body) || !/[0-9]$/.test(body)) return null;
  let prevUnderscore = false;
  let digits = "";
  for (const ch of body) {
    if (ch === "_") {
      if (prevUnderscore) return null; // double underscore
      prevUnderscore = true;
      continue;
    }
    if (ch < "0" || ch > "9") return null;
    prevUnderscore = false;
    digits += ch;
  }
  // digits is non-empty here (start/end were digits). Parse base 10.
  const n = Number(digits);
  // Python ints have no signed zero: int("-0") == 0 (positive). Returning sign*0 in JS
  // would yield -0, which Object.is-distinguishes from +0 and diverges from Python.
  if (n === 0) return 0;
  return sign * n;
}

/**
 * Reproduce Python's float(str). Grammar (after stripping ws):
 *   [sign] (inf|infinity|nan|number)        case-insensitive for inf/infinity/nan
 *   number := (digitpart? '.' digitpart | digitpart '.'? ) (('e'|'E') [sign] digitpart)?
 * with the same '_'-between-digits rule as int. Returns the value (including Infinity
 * / -Infinity / NaN, which Python's float() yields for inf/nan), or null on reject.
 */
function pyFloatParse(raw: string): number | null {
  const s = stripPyWs(raw);
  if (s.length === 0) return null;
  let i = 0;
  let sign = 1;
  if (s[i] === "+" || s[i] === "-") {
    if (s[i] === "-") sign = -1;
    i++;
  }
  const body = s.slice(i);
  if (body.length === 0) return null;
  const lower = body.toLowerCase();
  if (lower === "inf" || lower === "infinity") return sign * Infinity;
  if (lower === "nan") return sign * NaN; // sign on NaN is irrelevant numerically
  // Remove underscores per Python's rule (between digits only), validating placement.
  // Build a cleaned ASCII numeric string for JS Number() once structure is verified.
  // Reject any char outside [0-9 . e + - _].
  if (!/^[0-9._eE+\-]+$/.test(body)) return null;
  // Validate underscores: each '_' must be immediately preceded AND followed by a
  // digit (CPython _Py_string_to_number_with_underscores semantics).
  for (let k = 0; k < body.length; k++) {
    if (body[k] === "_") {
      const prev = body[k - 1];
      const next = body[k + 1];
      if (prev === undefined || next === undefined) return null;
      if (prev < "0" || prev > "9" || next < "0" || next > "9") return null;
    }
  }
  const cleaned = body.replace(/_/g, "");
  // Now validate the float grammar on the underscore-free body. JS Number() accepts a
  // superset (e.g. "Infinity", "0x..", trailing/leading ws, empty->0); we already
  // excluded those, but we must still reject Python-invalid forms like ".", "e3",
  // "1.0.0". Use a strict float regex matching CPython's accepted decimal syntax.
  const FLOAT_RE = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+\-]?[0-9]+)?$/;
  if (!FLOAT_RE.test(cleaned)) return null;
  const n = Number(cleaned);
  if (Number.isNaN(n)) return null; // defensive; FLOAT_RE should preclude this
  return sign * n;
}

/**
 * _coerce(typ, val) -- config.py:168. int/float via Python parse with 0/0.0 fallback;
 * any other type returns the raw string.
 */
export function _coerce(typ: FieldType, val: string): ConfigValue {
  if (typ === "int") {
    const r = pyIntParse(val);
    return r === null ? 0 : r;
  }
  if (typ === "float") {
    const r = pyFloatParse(val);
    return r === null ? 0.0 : r;
  }
  return val;
}

// Python str.partition("=") -- split on the FIRST "=" into (head, sep, tail).
function partitionFirst(s: string, sep: string): [string, string, string] {
  const idx = s.indexOf(sep);
  if (idx < 0) return [s, "", ""];
  return [s.slice(0, idx), sep, s.slice(idx + sep.length)];
}

// Python str.strip() with no args: strip leading/trailing Unicode whitespace.
function pyStrip(s: string): string {
  return stripPyWs(s);
}

export class Config {
  // gameplay
  MAXPLAYERS: number = 2;
  MAXROUNDS: number = 10;
  ARMS: number = 4; // 0-4 weapon tier gate
  PLAY_MODE: string = "SEQUENTIAL";
  PLAY_ORDER: string = "RANDOM";
  TEAM_MODE: string = "NONE";
  HOSTILE_ENVIRONMENT: string = "ON";
  TUNNELLING: string = "OFF"; // binary no-cfg default (FUN_22a5_0005.c:582; manual says ON)
  USELESS_ITEMS: string = "ON"; // binary no-cfg default (FUN_22a5_0005.c:600; manual says OFF)
  EXPLOSION_SCALE: string = "NORMAL";
  // economy
  INITIAL_CASH: number = 0; // $0-$1,000,000
  INTEREST_RATE: number = 0.05;
  COMPUTERS_BUY: string = "ON";
  FREE_MARKET: string = "OFF";
  SCORING: string = "STANDARD";
  // physics
  GRAVITY: number = 0.2;
  AIR_VISCOSITY: number = 0; // 0-20 (note: live mult uses /10000)
  MAX_WIND: number = 200;
  CHANGING_WIND: string = "OFF";
  ELASTIC: string = "NONE"; // Effect of Walls
  FALLING_TANKS: string = "ON";
  EDGES_EXTEND: number = 75; // off-screen tracking px
  DAMAGE_TANKS_ON_IMPACT: string = "ON"; // ON=damage on landing, OFF=while falling
  // terrain
  LAND1: number = 20; // Bumpiness
  LAND2: number = 20; // Slope
  FLATLAND: string = "ON"; // Flatten Peaks; binary no-cfg default (FUN_22a5_0005.c:375; manual OFF)
  RANDOM_LAND: string = "ON"; // binary no-cfg default (FUN_22a5_0005.c:550; manual OFF)
  MTN_PERCENT: number = 20.0;
  SUSPEND_DIRT: number = 0; // % chance/shot dirt falls
  EXTRA_DIRT: string = "OFF";
  SKY: string = "RANDOM";
  // display
  GRAPHICS_MODE: string = "1024x768"; // landscape; user-specified target resolution
  LOWMEM: string = "OFF";
  FIRE_DELAY: number = 100; // projectile draw pacing
  FALLING_DELAY: number = 10;
  STATUS_BAR: string = "OFF";
  ICON_BAR: string = "ON"; // Play-Options ~Icon Bar; port-added 50th key (render.py:400)
  BOMB_ICON: string = "BIG";
  TRACE: string = "OFF"; // trace projectile paths
  FAST_COMPUTERS: string = "OFF";
  // input
  BIOS_KEYBOARD: string = "OFF";
  POINTER: string = "Mouse";
  MOUSE_RATE: number = 0.5;
  // sound
  SOUND: string = "ON";
  FLY_SOUND: string = "OFF";
  // talk
  TALKING_TANKS: string = "OFF";
  TALK_PROBABILITY: number = 100;
  TALK_DELAY: number = 50;
  ATTACK_COMMENTS: string = "talk1.cfg";
  DIE_COMMENTS: string = "talk2.cfg";

  // __post_init__: live per-round runtime globals beside the config globals in data
  // segment 5f38 (DAT_5f38_515a wind, DAT_5f38_5154 live wall sub-mode). Not config
  // fields, so they are not written to scorch.cfg.
  wind: number = 0; // DAT_5f38_515a current wind (signed)
  live_elastic: number; // DAT_5f38_5154 current wall sub-mode

  constructor() {
    // Mirror __post_init__: live_elastic = self.elastic (uses default ELASTIC="NONE").
    this.live_elastic = this.elastic;
  }

  /** Read a field by name (mirrors getattr); used by is_on and save. */
  private get(name: string): ConfigValue {
    return (this as unknown as { [k: string]: ConfigValue })[name];
  }

  /** Set a field by name (mirrors setattr); used by load. */
  private set(name: string, value: ConfigValue): void {
    (this as unknown as { [k: string]: ConfigValue })[name] = value;
  }

  // ----- derived accessors (enum string -> internal index) -----
  get scoring(): number {
    const k = pyUpper(this.SCORING);
    return k in SCORING ? SCORING[k] : 1;
  }
  get team_mode(): number {
    const k = pyUpper(this.TEAM_MODE);
    return k in TEAM_MODE ? TEAM_MODE[k] : 0;
  }
  get play_mode(): number {
    const k = pyUpper(this.PLAY_MODE);
    return k in PLAY_MODE ? PLAY_MODE[k] : 0;
  }
  get play_order(): number {
    const k = pyUpper(this.PLAY_ORDER);
    return k in PLAY_ORDER ? PLAY_ORDER[k] : 0;
  }
  get elastic(): number {
    const k = pyUpper(this.ELASTIC);
    return k in ELASTIC ? ELASTIC[k] : 0;
  }
  get explosion_scale(): number {
    const k = pyUpper(this.EXPLOSION_SCALE);
    return k in EXPLOSION_SCALE ? EXPLOSION_SCALE[k] : 0;
  }

  is_on(key: string): boolean {
    // str(getattr(self, key)).upper() == "ON". Python str() of a number/bool differs
    // from JS String(); pyStr replicates it so e.g. an int field never reads "ON".
    return pyUpper(pyStr(this.get(key))) === "ON";
  }

  get resolution(): [number, number] {
    // A loaded original scorch.cfg may carry a legacy DOS GRAPHICS_MODE token (not
    // "WxH"); fall back to 1024x768 rather than crash on an unparseable value.
    // Mirrors: w,h = GRAPHICS_MODE.lower().split("x"); int(w),int(h) -- with the
    // outer except catching ValueError (bad unpack / bad int) and AttributeError
    // (non-string GRAPHICS_MODE has no .lower).
    const gm = this.GRAPHICS_MODE;
    if (typeof gm !== "string") return [1024, 768]; // AttributeError path (.lower)
    const parts = gm.toLowerCase().split("x");
    if (parts.length !== 2) return [1024, 768]; // unpack ValueError (!=2 values)
    const w = pyIntParse(parts[0]);
    const h = pyIntParse(parts[1]);
    if (w === null || h === null) return [1024, 768]; // int() ValueError
    return [w, h];
  }

  get viscosity_mult(): number {
    // visc_mult = 1 - VISCOSITY/10000 (FUN_22a5_0005.c:245).
    return 1.0 - this.AIR_VISCOSITY / VISCOSITY_DIV;
  }

  // ----- scorch.cfg round-trip (KEY=value, case-insensitive read) -----
  /**
   * load(lines) -- config.py:139. The Python version takes a path and reads the file;
   * in the browser there is no filesystem, so this port takes the already-read file
   * contents (or null/undefined to signal "no cfg", the OSError branch). The parse
   * logic below is identical to config.py line-for-line.
   */
  static load(contents: string | null | undefined): Config {
    const cfg = new Config();
    if (contents === null || contents === undefined) {
      return cfg; // no cfg -> built-in defaults (fix.bat behavior / OSError branch)
    }
    // Python readlines() splits keeping the structure; .strip() per line below makes
    // the exact line terminator immaterial. Split on \n (handles \r via strip).
    const lines = contents.split("\n");
    for (let line of lines) {
      line = pyStrip(line);
      if (line.length === 0 || line.startsWith(";") || !line.includes("=")) continue;
      const [keyRaw, , valRaw] = partitionFirst(line, "=");
      const key = pyUpper(pyStrip(keyRaw));
      const val = pyStrip(valRaw);
      if (key in FIELD_TYPE) {
        cfg.set(key, _coerce(FIELD_TYPE[key], val));
      }
    }
    return cfg;
  }

  /**
   * save() -- config.py:158. Returns the file body as a string (the Python version
   * writes it to `path`; the browser build hands the string to the host to persist).
   * Byte-for-byte identical line content to config.py's writer.
   */
  save(): string {
    let out = "; Configuration File for Scorched Earth Version 1.5-py\n";
    for (const f of CONFIG_FIELDS) {
      // config.py writes f"{f.name}={v}" with v=getattr(self,f.name). The float-vs-int
      // distinction (e.g. MTN_PERCENT default 20.0 -> "20.0", LAND1 20 -> "20") is lost
      // in JS's single number type, so the declared field type pins the rendering. The
      // bool->"on"/"off" branch from config.py is preserved inside fieldToCfgToken.
      const token = fieldToCfgToken(f.type, this.get(f.name));
      out += `${f.name}=${token}\n`;
    }
    return out;
  }
}

/**
 * Python str() of a config value, as used in f-strings by save() and in is_on().
 * Replicates Python's repr-free str() for the value kinds a Config field holds:
 *   - str -> itself
 *   - int -> decimal with no fractional part ("100", "-5")
 *   - float -> Python float repr ("0.05", "0.2", "20.0", "1e+20", "inf", "nan")
 * The int/float distinction is carried by FIELD_TYPE, not by the JS runtime (JS has
 * one number type), so callers that need it pass through save()/is_on which know the
 * field. For values produced by _coerce, float fields always render with a Python
 * float repr and int fields as bare integers; pyStr infers from Number.isInteger only
 * for the generic case. save() overrides per-field below.
 */
export function pyStr(v: ConfigValue): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") {
    return pyNumStr(v, undefined);
  }
  return String(v);
}

/**
 * Render a JS number the way Python str() would for the originating field type.
 * `asFloat` true -> Python float repr; false -> Python int repr; undefined -> infer
 * (integer-valued -> int repr, else float repr). save() and the oracle pin the field
 * type so the float-vs-int rendering matches config.py exactly (e.g. MTN_PERCENT=20.0
 * default renders "20.0", INITIAL_CASH=0 renders "0").
 */
function pyNumStr(n: number, asFloat: boolean | undefined): string {
  if (asFloat === false) return pyIntStr(n);
  if (asFloat === true) return pyFloatRepr(n);
  // infer
  if (Number.isInteger(n)) return pyIntStr(n);
  return pyFloatRepr(n);
}

function pyIntStr(n: number): string {
  // Python int rendering: no decimal point, no exponent for the small magnitudes here.
  // Math.trunc guards against a float-typed integer value carrying a -0.
  const t = Math.trunc(n);
  return Object.is(t, -0) ? "0" : String(t);
}

/**
 * Python float repr (repr(float) == str(float) in Py3). Must match CPython's
 * PyOS_double_to_string(v, 'r', 0) "repr format": the SHORTEST decimal string that
 * round-trips to the same double, formatted positional or scientific by the decimal
 * exponent. CPython uses scientific iff exp < -4 OR exp >= 16, where exp is the power
 * of ten of the leading significant digit (CPython Python/pystrtod.c format_float_short,
 * 'r' case: precision 17 then trimmed; the -4/16 cutoffs are the 'r' decimal_point
 * thresholds). JS Number.toString uses its OWN cutoffs (positional for 1e-6<=|x|<1e21),
 * so JS's string is reformatted here under Python's rule.
 *
 *   - inf/-inf/nan -> "inf"/"-inf"/"nan"
 *   - signed zero  -> "0.0"/"-0.0"
 *   - else: take JS's shortest round-tripping significant digits, re-place the decimal
 *     point / choose exp form per CPython's threshold, pad the exponent to >=2 digits.
 * Exported for the differential gate (test/config_more.test.ts) so the scientific /
 * positional / signed-zero branches can be asserted directly against CPython repr.
 */
export function pyFloatRepr(n: number): string {
  if (Number.isNaN(n)) return "nan";
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  if (n === 0) return Object.is(n, -0) ? "-0.0" : "0.0";

  const neg = n < 0 || Object.is(n, -0);
  const a = Math.abs(n);

  // Extract shortest round-tripping significant digits and the base-10 exponent of the
  // leading digit from JS's own shortest repr (a.toString() / toExponential are both
  // shortest-round-trip in V8). Use toExponential() with no arg: gives "d.ddde+NN" /
  // "d.ddde-NN" with the minimal digits that round-trip.
  const exp = a.toExponential(); // e.g. "5e-2", "2e-1", "2e+1", "1.23456789e+5"
  // m always matches: the guards above returned for NaN/+-Infinity/0, so only a
  // finite nonzero double reaches here, and Number#toExponential() on such a value
  // always yields "d[.ddd]e(+/-)NN" which this regex captures. A null m would be a
  // port bug; the non-null assertion throws loudly on deref rather than masking it
  // behind a JS-spelled a.toString() that does NOT match CPython repr (DTM 6.8).
  const m = exp.match(/^(\d)(?:\.(\d+))?e([+\-]\d+)$/)!;
  const lead = m[1];
  const frac = m[2] || "";
  const digits = lead + frac; // all significant digits, no point
  const e = parseInt(m[3], 10); // power of ten of the leading digit

  let body: string;
  if (e < -4 || e >= 16) {
    // Scientific form: d[.ddd]e(+/-)NN, exponent zero-padded to >= 2 digits.
    let mant = lead;
    if (frac.length > 0) mant += "." + frac;
    const es = e < 0 ? "-" : "+";
    let ed = Math.abs(e).toString();
    if (ed.length < 2) ed = "0" + ed;
    body = `${mant}e${es}${ed}`;
  } else if (e >= 0) {
    // Positional, value >= 1. Place the point e+1 digits from the left.
    const intLen = e + 1;
    if (digits.length <= intLen) {
      // integer-valued: pad with zeros and append ".0".
      body = digits + "0".repeat(intLen - digits.length) + ".0";
    } else {
      body = digits.slice(0, intLen) + "." + digits.slice(intLen);
    }
  } else {
    // Positional, 0 < value < 1 with e in [-4, -1]: "0.00...digits".
    body = "0." + "0".repeat(-e - 1) + digits;
  }
  return (neg ? "-" : "") + body;
}

/**
 * save()-accurate per-field stringifier exposed for the oracle and for callers that
 * already know a field's declared type. Returns the exact token config.py would write
 * for `value` given the field `type`.
 */
export function fieldToCfgToken(type: FieldType, value: ConfigValue): string {
  if (typeof value === "boolean") return (value as boolean) ? "on" : "off";
  if (typeof value === "number") return pyNumStr(value, type === "float");
  return value;
}
