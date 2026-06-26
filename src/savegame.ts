/**
 * Save / Restore game (System Menu -> Save Game / Restore Game) -- a faithful
 * TypeScript port of scorch-py/scorch/savegame.py (the fidelity oracle, itself
 * verified against 1.5/SCORCH.EXE's FILE FRAMING, not its byte layout).
 *
 * PROVENANCE (preserved from savegame.py / catalog 18 s3):
 *   save    <- FUN_400b_04ab : magic signature + version word at the file head
 *   load    <- FUN_400b_0686 : FUN_1000_5923 memcmp of the magic, version-guard
 *              `(iVar2 == 0) && (local_c == 0x18)`; two guard strings on a bad
 *              header (`"%s" is not a saved game.` / `... a different version.`).
 *
 * As in the Python port, this uses its OWN serialization (the task permits it).
 * DIVERGENCE, documented (identical to savegame.py's docstring): the on-disk
 * magic is the port's own `SCORPY` + u16 version, NOT the DOS `HB$a8...scorch`
 * bytes (catalog 18 s3.1, raw `48 42 24 61 38 4f 73 63 6f 72 63 68`). A blob
 * written here is a Python/TS-port save and is intentionally NOT byte-compatible
 * with SCORCH.EXE; the magic exists to reject foreign / corrupt blobs exactly as
 * the original's memcmp does, not to claim DOS-format conformance.
 *
 * Format (little-endian header, then a UTF-8 JSON body):
 *
 *     offset  size  field
 *     0       6     MAGIC          "SCORPY"
 *     6       2     version (u16)  SAVE_VERSION   (little-endian)
 *     8       ...   JSON body      utf-8, the dict from serialize(state)
 *
 * The terrain grid is base64'd inside the JSON body (raw uint8 bytes plus its
 * (w, h) shape), so the body is a single self-describing text blob.
 *
 * BROWSER INJECTION (the only structural difference from savegame.py): the
 * Python API is path-based (`save(state, path)` / `load(path)` do file I/O). The
 * browser build has no filesystem, so this port produces / consumes a byte blob
 * (Uint8Array) that main persists into IndexedDB / localStorage:
 *   - serialize(state) -> a plain JSON-able dict (identical to savegame.py).
 *   - save(state)      -> Uint8Array (header + UTF-8 JSON body), the blob to store.
 *   - load(bytes)      -> the serialized dict, after validating magic + version.
 *   - apply(data, state) -> restores into a live GameState-like host, in place.
 * The apply() host is injected by the caller (RestoreScreen passes the live
 * GameState in the Python: screens.py:2192 `savegame.apply(data, self.state)`).
 *
 * BYTE FIDELITY (the heart of this port): save() must produce the SAME bytes
 * Python's `json.dumps(serialize(state), separators=(",",":")).encode("utf-8")`
 * produces, header included. CPython's json encoder is reproduced here exactly:
 *   - separators (",",":"), no whitespace;
 *   - dict keys in INSERTION order (Python 3.7+ dict / our serialize() order);
 *   - ensure_ascii=True: non-ASCII and control chars escaped as \uXXXX (lowercase
 *     hex), astral chars as UTF-16 surrogate pairs; the short escapes \b \t \n \f
 *     \r \" \\ for those specific code points; '/' is NOT escaped (verified
 *     against CPython json.encoder.py_encode_basestring_ascii);
 *   - int vs float distinction: JSON renders `5` and `5.0` differently, but JS has
 *     ONE number type. The serialized dict therefore tags every float-valued
 *     position with PyFloat (see _serialize); a bare number renders as a Python
 *     int, a PyFloat renders with Python's float repr (pyFloatRepr below), which
 *     reproduces `repr(float)` / json's float form byte-for-byte (cross-checked on
 *     66 doubles incl. subnormals, 1e21, 1e-7, 1/3, and 40 random bit-patterns:
 *     0 mismatches). The float positions are EXACTLY the ones savegame.py emits as
 *     Python floats: state.timer; cfg.{INTEREST_RATE,GRAVITY,MTN_PERCENT,
 *     MOUSE_RATE}; economy.{demand_ema,ratio_ema}. Every other numeric leaf is an
 *     int in every reachable GameState (verified against objects.py / game.py).
 *
 * SECURITY: like savegame.py, JSON (not pickle/eval) is used deliberately -- a
 * restore reads an untrusted user blob; JSON + explicit apply() cannot execute
 * code and the body is auditable.
 */
import { CONFIG_FIELDS } from "./config";
import { NUM_ITEMS } from "./weapons";

// config.ts does not export its FieldType alias; redeclare the identical literal
// union locally (the CONFIG_FIELDS element `.type` is exactly this union, so it
// assigns without a cast). Kept in lockstep with config.ts:64.
type FieldType = "int" | "float" | "str";

// 6-byte port magic (NOT the DOS HB$a8...scorch bytes; see module docstring).
export const MAGIC = "SCORPY";
export const MAGIC_BYTES: ReadonlyArray<number> = [0x53, 0x43, 0x4f, 0x52, 0x50, 0x59]; // "SCORPY"
// Bump when the serialized dict shape changes incompatibly. load() refuses any
// other value (the version-guard, catalog 18 s3.2: restore requires equality).
export const SAVE_VERSION = 1;
const HEADER_LEN = 8; // 6-byte magic + u16 version (little-endian)

/** Raised by load() when a blob is not a valid / compatible port save.
 *
 * The message mirrors savegame.py's SaveError (and the original's two guard
 * strings, catalog 18 s3.1) so the UI can show the same class of error the DOS
 * build showed. */
export class SaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveError";
  }
}

// ===========================================================================
// CPython json.dumps(obj, separators=(",",":")) reproduction
// ===========================================================================

/**
 * Float wrapper. A serialized leaf wrapped in PyFloat is rendered with Python's
 * float repr (so 0.0 -> "0.0", not "0"); a bare number is rendered as a Python
 * int. This is how the encoder reproduces json's int-vs-float distinction in a
 * language with a single number type.
 */
export class PyFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}
const f = (n: number): PyFloat => new PyFloat(n);

// A JSON-able value tree the encoder accepts. PyFloat marks a float leaf.
export type JsonValue =
  | null
  | boolean
  | number // rendered as a Python int (integer-valued in every serialize() position)
  | PyFloat // rendered with Python float repr
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

/**
 * Python int rendering for the encoder. serialize() only ever places
 * integer-valued numbers in bare-number positions; render with no fractional
 * part. Math.trunc collapses a possible -0 carried by a float-typed integer; no
 * serialized int is negative-zero, so this never masks a divergence.
 */
function encodeInt(n: number): string {
  if (!Number.isFinite(n)) {
    // Defensive: a non-finite value in an int position is a port bug, not a
    // faithful state. Surface it rather than emit silent garbage (DTM 6.8).
    throw new SaveError(`non-finite value ${n} in an integer JSON position`);
  }
  const t = Math.trunc(n);
  return Object.is(t, -0) ? "0" : String(t);
}

/**
 * CPython float repr (repr(float) == str(float) in Py3), with json's inf/nan
 * spelling. Reproduces PyOS_double_to_string(v, 'r', 0): the SHORTEST decimal
 * string that round-trips, positional or scientific by the decimal exponent
 * (scientific iff exp < -4 OR exp >= 16). Ported verbatim from config.ts's
 * proven pyFloatRepr (cross-checked byte-for-byte vs CPython this session); the
 * sole change is inf/-inf/nan -> "Infinity"/"-Infinity"/"NaN" (json spelling)
 * instead of "inf"/"-inf"/"nan" (str() spelling).
 */
export function pyFloatRepr(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "Infinity";
  if (n === -Infinity) return "-Infinity";
  if (n === 0) return Object.is(n, -0) ? "-0.0" : "0.0";

  const neg = n < 0 || Object.is(n, -0);
  const a = Math.abs(n);

  // toExponential() with no arg yields the minimal digits that round-trip in V8.
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

// Short escapes CPython json uses for these specific code points
// (json.encoder.ESCAPE_DCT). Everything else < 0x20, and every char >= 0x7f, is
// emitted as \uXXXX. Verified against json.dumps(chr(i)) for i in 0x00..0x1f.
const SHORT_ESCAPE: { [code: number]: string } = {
  0x08: "\\b",
  0x09: "\\t",
  0x0a: "\\n",
  0x0c: "\\f",
  0x0d: "\\r",
  0x22: '\\"',
  0x5c: "\\\\",
};

function hex4(code: number): string {
  return code.toString(16).padStart(4, "0"); // lowercase, matches CPython
}

/**
 * Reproduce CPython json's py_encode_basestring_ascii (ensure_ascii=True): wrap
 * in double quotes; short-escape the chars above; \uXXXX every other control
 * char (< 0x20) and every code point >= 0x7f. Astral chars (code point >=
 * 0x10000) become a UTF-16 surrogate pair of \uXXXX escapes -- iterating the JS
 * string by code unit yields exactly the surrogate halves, so charCodeAt per
 * unit already produces the two escapes CPython emits.
 */
export function encodeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i); // UTF-16 code unit (surrogate halves included)
    const short = SHORT_ESCAPE[code];
    if (short !== undefined) {
      out += short;
    } else if (code < 0x20 || code >= 0x7f) {
      out += "\\u" + hex4(code);
    } else {
      out += s[i];
    }
  }
  return out + '"';
}

/** Encode a JsonValue tree as CPython json.dumps(obj, separators=(",",":")). */
export function encodeJson(v: JsonValue): string {
  if (v === null) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (v instanceof PyFloat) return pyFloatRepr(v.value);
  const t = typeof v;
  if (t === "number") return encodeInt(v as number);
  if (t === "string") return encodeString(v as string);
  if (Array.isArray(v)) {
    let out = "[";
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ",";
      out += encodeJson(v[i]);
    }
    return out + "]";
  }
  // object (dict): insertion order, "key":value joined by ",".
  let out = "{";
  let first = true;
  for (const k of Object.keys(v as { [k: string]: JsonValue })) {
    if (!first) out += ",";
    first = false;
    out += encodeString(k) + ":" + encodeJson((v as { [k: string]: JsonValue })[k]);
  }
  return out + "}";
}

// ===========================================================================
// base64 (standard alphabet + '=' padding), matching Python base64.b64encode
// ===========================================================================
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INV: { [ch: string]: number } = {};
for (let i = 0; i < B64_ALPHABET.length; i++) B64_INV[B64_ALPHABET[i]] = i;

export function b64encode(bytes: Uint8Array): string {
  let out = "";
  const n = bytes.length;
  let i = 0;
  for (; i + 3 <= n; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64_ALPHABET[a >> 2];
    out += B64_ALPHABET[((a & 0x03) << 4) | (b >> 4)];
    out += B64_ALPHABET[((b & 0x0f) << 2) | (c >> 6)];
    out += B64_ALPHABET[c & 0x3f];
  }
  const rem = n - i;
  if (rem === 1) {
    const a = bytes[i];
    out += B64_ALPHABET[a >> 2];
    out += B64_ALPHABET[(a & 0x03) << 4];
    out += "==";
  } else if (rem === 2) {
    const a = bytes[i];
    const b = bytes[i + 1];
    out += B64_ALPHABET[a >> 2];
    out += B64_ALPHABET[((a & 0x03) << 4) | (b >> 4)];
    out += B64_ALPHABET[(b & 0x0f) << 2];
    out += "=";
  }
  return out;
}

export function b64decode(s: string): Uint8Array {
  // Python base64.b64decode (default validate=False) ignores non-alphabet chars
  // before padding; our blobs only ever contain the standard alphabet + '=', so
  // strip whitespace and decode strictly. A malformed length is a corrupt save.
  const clean = s.replace(/[\r\n\t ]/g, "");
  const padIdx = clean.indexOf("=");
  const body = padIdx >= 0 ? clean.slice(0, padIdx) : clean;
  const pad = padIdx >= 0 ? clean.length - padIdx : 0;
  const outLen = Math.floor((body.length * 6) / 8);
  const out = new Uint8Array(outLen);
  let bits = 0;
  let nbits = 0;
  let oi = 0;
  for (let i = 0; i < body.length; i++) {
    const val = B64_INV[body[i]];
    if (val === undefined) {
      throw new SaveError("corrupt saved game: invalid base64 in terrain payload");
    }
    bits = (bits << 6) | val;
    nbits += 6;
    if (nbits >= 8) {
      nbits -= 8;
      out[oi++] = (bits >> nbits) & 0xff;
    }
  }
  void pad;
  return out;
}

// ===========================================================================
// Structural host contracts (the surface savegame.py reads / mutates)
// ===========================================================================
// These mirror the duck-typed GameState / Tank / Economy / Terrain the Python
// touches, exactly as economy.ts / damage.ts define minimal structural
// interfaces instead of re-porting the full classes. game.ts is not part of this
// module's dependency set, so apply() restores into an injected host that
// satisfies these shapes (the live GameState in the integrated build).

export interface TerrainGrid {
  /** numpy uint8 grid as (w, h) -- column-major: index (x*h + y). */
  w: number;
  h: number;
  /** raw bytes, length w*h, row index y fastest (matches np.tobytes of (w,h)). */
  data: Uint8Array;
}

export interface SaveTank {
  player_index: number;
  name: string;
  ai_class: number;
  reveal_type: number;
  team_id: number;
  color: number;
  tank_icon: number;
  mobile: boolean;
  x: number;
  y: number;
  half_width: number;
  angle: number;
  power: number;
  health: number;
  alive: boolean;
  shield_hp: number;
  shield_item: number;
  shield_push: boolean;
  shield_deflect: boolean;
  shield_laserproof: boolean;
  shield_failproof: boolean;
  parachute_deployed: boolean;
  parachute_threshold: number;
  chute_up: number;
  contact_trigger: boolean;
  selected_guidance: unknown;
  // guidance_target is a Tank reference; serialize stores its player_index.
  guidance_target?: SaveTank | null;
  guidance_target_pt: [number, number] | null;
  cash: number;
  cash_ceiling: number;
  inventory: number[];
  selected_weapon: number;
  fuel_remainder: number;
  score: number;
  win_counter: number;
  hits_this_round: { [k: number]: number };
  hits_career: { [k: number]: number };
  fall_accum: number;
  falling: boolean;
  ai_tries: number;
  sim_keys?: number[];
}

export interface SaveEconomy {
  n: number;
  price: number[];
  demand_tally: number[];
  nobuy: number[];
  demand_ema: number[];
  ratio_ema: number[];
  available: boolean[];
  cfg?: SaveConfig;
}

/** The Config surface serialize()/apply() touch: every declared field by name. */
export type SaveConfig = {
  wind: number;
  live_elastic: number;
} & { [k: string]: number | string };

export interface SaveTerrain {
  grid: TerrainGrid;
}

export interface SaveGameState {
  round_index: number;
  phase: string;
  timer: number;
  message: string;
  fire_index: number;
  firing_order: number[];
  current_shooter: SaveTank | null;
  last_landing: [number, number] | null;
  winner: SaveTank | null;
  ranking: SaveTank[];
  w: number;
  h: number;
  cfg: SaveConfig;
  tanks: SaveTank[];
  economy: SaveEconomy;
  terrain: SaveTerrain;
  // apply() clears these transient collections (kept generic; the host owns them).
  projectiles?: unknown[];
  explosions?: unknown[];
  beams?: unknown[];
  awaiting_human?: boolean;
}

// The plain serialized dict shape (what load() returns / serialize() builds).
export interface SaveData {
  round_index: number;
  phase: string;
  timer: number;
  message: string;
  fire_index: number;
  firing_order: number[];
  current_shooter_index: number | null;
  last_landing: [number, number] | null;
  winner_index: number | null;
  ranking_indices: number[];
  w: number;
  h: number;
  cfg: { [k: string]: number | string };
  _wind: number;
  _live_elastic: number;
  tanks: SaveTankData[];
  economy: SaveEconomyData;
  terrain: { w: number; h: number; b64: string };
}

export interface SaveTankData {
  player_index: number;
  name: string;
  ai_class: number;
  reveal_type: number;
  team_id: number;
  color: number;
  tank_icon: number;
  mobile: boolean;
  x: number;
  y: number;
  half_width: number;
  angle: number;
  power: number;
  health: number;
  alive: boolean;
  shield_hp: number;
  shield_item: number;
  shield_push: boolean;
  shield_deflect: boolean;
  shield_laserproof: boolean;
  shield_failproof: boolean;
  parachute_deployed: boolean;
  parachute_threshold: number;
  chute_up: number;
  contact_trigger: boolean;
  selected_guidance: unknown;
  guidance_target_index: number | null;
  guidance_target_pt: [number, number] | null;
  cash: number;
  cash_ceiling: number;
  inventory: number[];
  selected_weapon: number;
  fuel_remainder: number;
  score: number;
  win_counter: number;
  hits_this_round: { [k: string]: number };
  hits_career: { [k: string]: number };
  fall_accum: number;
  falling: boolean;
  ai_tries: number;
  sim_keys: number[];
}

export interface SaveEconomyData {
  price: number[];
  demand_tally: number[];
  nobuy: number[];
  demand_ema: number[];
  ratio_ema: number[];
  available: boolean[];
}

// Which Config fields serialize() emits as Python floats (CONFIG_FIELDS type
// "float"). A "str" field is a string; an "int" field a bare number.
const CONFIG_FIELD_TYPE: { [name: string]: FieldType } = {};
for (const fld of CONFIG_FIELDS) CONFIG_FIELD_TYPE[fld.name] = fld.type;

// ---- config (Config dataclass) -- _cfg_to_dict / _cfg_from_dict -------------
function cfgToValueTree(cfg: SaveConfig): { [k: string]: JsonValue } {
  // {f.name: getattr(cfg, f.name) for f in fields(Config)} -- declaration order.
  const out: { [k: string]: JsonValue } = {};
  for (const fld of CONFIG_FIELDS) {
    const v = (cfg as { [k: string]: number | string })[fld.name];
    if (fld.type === "float") {
      out[fld.name] = f(v as number);
    } else if (fld.type === "int") {
      out[fld.name] = v as number;
    } else {
      out[fld.name] = v as string;
    }
  }
  return out;
}

function cfgToDict(cfg: SaveConfig): { [k: string]: number | string } {
  const out: { [k: string]: number | string } = {};
  for (const fld of CONFIG_FIELDS) {
    out[fld.name] = (cfg as { [k: string]: number | string })[fld.name];
  }
  return out;
}

/** _cfg_from_dict (savegame.py:76): rebuild a Config from a saved cfg dict. The
 * host supplies an empty SaveConfig (or a default-constructed one); we copy the
 * valid declared fields, then restore the two live globals (_wind / _live_elastic
 * fall back to the cfg's own wind / live_elastic if absent). */
export function cfgFromDict(
  cfg: SaveConfig,
  d: { [k: string]: number | string },
): SaveConfig {
  for (const k of Object.keys(d)) {
    if (k in CONFIG_FIELD_TYPE) {
      (cfg as { [k: string]: number | string })[k] = d[k];
    }
  }
  // live per-round runtime globals beside the cfg globals (config __post_init__
  // seeds these; restore them explicitly so wind / live wall mode survive).
  const wind = d["_wind"];
  cfg.wind = typeof wind === "number" ? Math.trunc(wind) : Math.trunc(cfg.wind);
  const le = d["_live_elastic"];
  cfg.live_elastic = typeof le === "number" ? Math.trunc(le) : Math.trunc(cfg.live_elastic);
  return cfg;
}

// ---- per-tank (objects.Tank) -- _tank_to_dict / _apply_tank -----------------
function idxOf(tank: SaveTank | null | undefined): number | null {
  return tank != null ? tank.player_index : null;
}

/** Build the float/int/str-typed value tree for one tank (encoder input). All
 * tank leaves are ints/bools/strings in every reachable state -- none is a
 * Python float (verified against objects.py / game.py), so no PyFloat appears
 * here; the dict-key maps (hits_*) stringify their int keys exactly as
 * `{str(k): v ...}` does. */
function tankToValueTree(t: SaveTank): { [k: string]: JsonValue } {
  const gt = t.guidance_target;
  return {
    player_index: t.player_index,
    name: t.name,
    ai_class: t.ai_class,
    reveal_type: t.reveal_type,
    team_id: t.team_id,
    color: t.color,
    tank_icon: t.tank_icon,
    mobile: !!t.mobile,
    x: Math.trunc(t.x),
    y: Math.trunc(t.y),
    half_width: t.half_width,
    angle: Math.trunc(t.angle),
    power: Math.trunc(t.power),
    health: t.health,
    alive: !!t.alive,
    // defenses
    shield_hp: t.shield_hp,
    shield_item: t.shield_item,
    shield_push: !!t.shield_push,
    shield_deflect: !!t.shield_deflect,
    shield_laserproof: !!t.shield_laserproof,
    shield_failproof: !!t.shield_failproof,
    parachute_deployed: !!t.parachute_deployed,
    parachute_threshold: t.parachute_threshold,
    chute_up: t.chute_up,
    contact_trigger: !!t.contact_trigger,
    selected_guidance: (t.selected_guidance ?? null) as JsonValue,
    guidance_target_index: gt != null ? gt.player_index : null,
    guidance_target_pt:
      t.guidance_target_pt != null
        ? ([t.guidance_target_pt[0], t.guidance_target_pt[1]] as JsonValue)
        : null,
    // economy
    cash: t.cash,
    cash_ceiling: t.cash_ceiling,
    inventory: t.inventory.slice() as JsonValue,
    selected_weapon: t.selected_weapon,
    fuel_remainder: t.fuel_remainder,
    // scoring / stats (dict keys are attacker player-indices; JSON makes them
    // strings, re-keyed to int in applyTank()).
    score: t.score,
    win_counter: t.win_counter,
    hits_this_round: intKeyMap(t.hits_this_round),
    hits_career: intKeyMap(t.hits_career),
    // fall / AI scratch
    fall_accum: t.fall_accum,
    falling: !!t.falling,
    ai_tries: t.ai_tries,
    // sim_keys is set by the driver only in SIMULTANEOUS; default empty.
    sim_keys: (t.sim_keys ? t.sim_keys.slice() : []) as JsonValue,
  };
}

/** {str(k): v for k, v in m.items()} -- Python int-keyed dict to a str-keyed
 * JSON object. CPython preserves the dict's insertion order; a normal {int:int}
 * here is built in ascending-attacker order by the damage path, but to match
 * json.dumps byte-for-byte the order MUST equal the Python dict's iteration
 * order. The TS host mirrors the same insertion order (hits are recorded in
 * attacker-index encounter order, identical to the Python). */
function intKeyMap(m: { [k: number]: number }): { [k: string]: JsonValue } {
  const out: { [k: string]: JsonValue } = {};
  for (const k of Object.keys(m)) out[k] = m[Number(k)];
  return out;
}

/** Plain serialized-dict form of one tank (for serialize() -> SaveData). */
function tankToData(t: SaveTank): SaveTankData {
  const gt = t.guidance_target;
  const strMap = (m: { [k: number]: number }): { [k: string]: number } => {
    const o: { [k: string]: number } = {};
    for (const k of Object.keys(m)) o[k] = m[Number(k)];
    return o;
  };
  return {
    player_index: t.player_index,
    name: t.name,
    ai_class: t.ai_class,
    reveal_type: t.reveal_type,
    team_id: t.team_id,
    color: t.color,
    tank_icon: t.tank_icon,
    mobile: !!t.mobile,
    x: Math.trunc(t.x),
    y: Math.trunc(t.y),
    half_width: t.half_width,
    angle: Math.trunc(t.angle),
    power: Math.trunc(t.power),
    health: t.health,
    alive: !!t.alive,
    shield_hp: t.shield_hp,
    shield_item: t.shield_item,
    shield_push: !!t.shield_push,
    shield_deflect: !!t.shield_deflect,
    shield_laserproof: !!t.shield_laserproof,
    shield_failproof: !!t.shield_failproof,
    parachute_deployed: !!t.parachute_deployed,
    parachute_threshold: t.parachute_threshold,
    chute_up: t.chute_up,
    contact_trigger: !!t.contact_trigger,
    selected_guidance: t.selected_guidance ?? null,
    guidance_target_index: gt != null ? gt.player_index : null,
    guidance_target_pt:
      t.guidance_target_pt != null
        ? [t.guidance_target_pt[0], t.guidance_target_pt[1]]
        : null,
    cash: t.cash,
    cash_ceiling: t.cash_ceiling,
    inventory: t.inventory.slice(),
    selected_weapon: t.selected_weapon,
    fuel_remainder: t.fuel_remainder,
    score: t.score,
    win_counter: t.win_counter,
    hits_this_round: strMap(t.hits_this_round),
    hits_career: strMap(t.hits_career),
    fall_accum: t.fall_accum,
    falling: !!t.falling,
    ai_tries: t.ai_tries,
    sim_keys: t.sim_keys ? t.sim_keys.slice() : [],
  };
}

/** _apply_tank (savegame.py:147): restore one tank from its saved dict, in
 * place. guidance_target is resolved from the saved player index via
 * tanksByIndex; hits_* dict keys are re-keyed back to int. */
export function applyTank(
  t: SaveTank,
  d: SaveTankData,
  tanksByIndex: { [idx: number]: SaveTank },
): void {
  t.name = d.name;
  t.ai_class = d.ai_class;
  t.reveal_type = d.reveal_type ?? (d.ai_class ? d.ai_class - 1 : -1);
  t.team_id = d.team_id;
  t.color = d.color;
  t.tank_icon = d.tank_icon;
  t.mobile = d.mobile;
  t.x = d.x;
  t.y = d.y;
  t.half_width = d.half_width;
  t.angle = d.angle;
  t.power = d.power;
  t.health = d.health;
  t.alive = d.alive;
  t.shield_hp = d.shield_hp;
  t.shield_item = d.shield_item;
  t.shield_push = d.shield_push;
  t.shield_deflect = d.shield_deflect;
  t.shield_laserproof = d.shield_laserproof;
  t.shield_failproof = d.shield_failproof;
  t.parachute_deployed = d.parachute_deployed;
  t.parachute_threshold = d.parachute_threshold;
  t.chute_up = d.chute_up;
  t.contact_trigger = d.contact_trigger;
  t.selected_guidance = d.selected_guidance;
  const gti = d.guidance_target_index;
  t.guidance_target = gti != null ? tanksByIndex[gti] ?? null : null;
  const pt = d.guidance_target_pt;
  t.guidance_target_pt = pt != null ? [pt[0], pt[1]] : null;
  t.cash = d.cash;
  t.cash_ceiling = d.cash_ceiling;
  t.inventory = d.inventory.slice();
  t.selected_weapon = d.selected_weapon;
  t.fuel_remainder = d.fuel_remainder;
  t.score = d.score;
  t.win_counter = d.win_counter;
  t.hits_this_round = intKeysToNum(d.hits_this_round);
  t.hits_career = intKeysToNum(d.hits_career);
  t.fall_accum = d.fall_accum;
  t.falling = d.falling;
  t.ai_tries = d.ai_tries;
  if (d.sim_keys && d.sim_keys.length) {
    t.sim_keys = d.sim_keys.slice();
  }
}

function intKeysToNum(m: { [k: string]: number }): { [k: number]: number } {
  const out: { [k: number]: number } = {};
  for (const k of Object.keys(m)) out[Number(k)] = m[k];
  return out;
}

// ---- economy (economy.Economy) -- _economy_to_dict / _apply_economy ---------
function economyToValueTree(econ: SaveEconomy): { [k: string]: JsonValue } {
  return {
    price: econ.price.slice() as JsonValue,
    demand_tally: econ.demand_tally.slice() as JsonValue,
    nobuy: econ.nobuy.slice() as JsonValue,
    demand_ema: econ.demand_ema.map((x) => f(x)) as JsonValue,
    ratio_ema: econ.ratio_ema.map((x) => f(x)) as JsonValue,
    available: econ.available.map((b) => !!b) as JsonValue,
  };
}

function economyToData(econ: SaveEconomy): SaveEconomyData {
  return {
    price: econ.price.slice(),
    demand_tally: econ.demand_tally.slice(),
    nobuy: econ.nobuy.slice(),
    demand_ema: econ.demand_ema.slice(),
    ratio_ema: econ.ratio_ema.slice(),
    available: econ.available.map((b) => !!b),
  };
}

/** _apply_economy (savegame.py:205): length-guard each list against the item
 * count (n), then restore in place. A save whose arrays do not match the build's
 * item count is from an incompatible item table and MUST NOT be silently
 * truncated (raises SaveError, mirroring the version-mismatch class). */
export function applyEconomy(econ: SaveEconomy, d: SaveEconomyData): void {
  const n = econ.n;
  const keys = ["price", "demand_tally", "nobuy", "demand_ema", "ratio_ema", "available"] as const;
  for (const key of keys) {
    const vals = d[key];
    if (vals == null || vals.length !== n) {
      throw new SaveError(
        `"${key}" length ${vals == null ? 0 : vals.length} != item count ${n}: ` +
          "save was created by a different version.",
      );
    }
  }
  econ.price = d.price.slice();
  econ.demand_tally = d.demand_tally.slice();
  econ.nobuy = d.nobuy.slice();
  econ.demand_ema = d.demand_ema.slice();
  econ.ratio_ema = d.ratio_ema.slice();
  econ.available = d.available.map((b) => !!b);
}

// ---- terrain grid (numpy uint8 W x H) -- _grid_to_dict / _grid_from_dict -----
function gridToValueTree(grid: TerrainGrid): { [k: string]: JsonValue } {
  return {
    w: Math.trunc(grid.w),
    h: Math.trunc(grid.h),
    b64: b64encode(grid.data),
  };
}

function gridToData(grid: TerrainGrid): { w: number; h: number; b64: string } {
  return {
    w: Math.trunc(grid.w),
    h: Math.trunc(grid.h),
    b64: b64encode(grid.data),
  };
}

/** _grid_from_dict (savegame.py:235): decode a base64 grid, validating that the
 * payload length equals w*h (a mismatch is a corrupt save). Returns a fresh
 * TerrainGrid (column-major, index (x*h + y)). */
export function gridFromDict(d: { w: number; h: number; b64: string }): TerrainGrid {
  const w = Math.trunc(d.w);
  const h = Math.trunc(d.h);
  const raw = b64decode(d.b64);
  const expect = w * h;
  if (raw.length !== expect) {
    throw new SaveError(
      `terrain payload ${raw.length} bytes != ${w}x${h}=${expect}: corrupt save.`,
    );
  }
  return { w, h, data: raw };
}

// ===========================================================================
// Public API
// ===========================================================================

/** Build the encoder value tree (with PyFloat tags) for save() -- the EXACT
 * shape and float-typing savegame.py's serialize() + json.dumps emit. Kept
 * separate from serialize() so save() encodes types correctly while serialize()
 * returns a plain JS dict for tests / callers that just want the data. */
function serializeValueTree(state: SaveGameState): { [k: string]: JsonValue } {
  return {
    round_index: state.round_index, // DAT_5f38_e342
    phase: state.phase,
    timer: f(state.timer), // Python float (init 0.0, set to AI_TURN_DELAY etc.)
    message: state.message,
    fire_index: state.fire_index, // DAT_5f38_e4f4
    firing_order: state.firing_order.slice() as JsonValue, // DAT_5f38_e4f6
    current_shooter_index: idxOf(state.current_shooter),
    last_landing:
      state.last_landing != null
        ? ([state.last_landing[0], state.last_landing[1]] as JsonValue)
        : null,
    winner_index: idxOf(state.winner),
    ranking_indices: state.ranking.map((t) => t.player_index) as JsonValue,
    w: state.w,
    h: state.h,
    cfg: cfgToValueTree(state.cfg),
    _wind: Math.trunc(state.cfg.wind),
    _live_elastic: Math.trunc(state.cfg.live_elastic),
    tanks: state.tanks.map((t) => tankToValueTree(t)) as JsonValue,
    economy: economyToValueTree(state.economy),
    terrain: gridToValueTree(state.terrain.grid),
  };
}

/** serialize(state) -- savegame.py:248. GameState -> a plain JSON-able dict (no
 * I/O). Exposed for tests and callers that want the data without the byte blob.
 * The byte form (save()) uses serializeValueTree() so int vs float renders
 * exactly; this returns plain numbers (the float/int distinction is then carried
 * by the field, as in the Python dict whose floats are Python floats). */
export function serialize(state: SaveGameState): SaveData {
  return {
    round_index: state.round_index,
    phase: state.phase,
    timer: state.timer,
    message: state.message,
    fire_index: state.fire_index,
    firing_order: state.firing_order.slice(),
    current_shooter_index: idxOf(state.current_shooter),
    last_landing:
      state.last_landing != null
        ? [state.last_landing[0], state.last_landing[1]]
        : null,
    winner_index: idxOf(state.winner),
    ranking_indices: state.ranking.map((t) => t.player_index),
    w: state.w,
    h: state.h,
    cfg: cfgToDict(state.cfg),
    _wind: Math.trunc(state.cfg.wind),
    _live_elastic: Math.trunc(state.cfg.live_elastic),
    tanks: state.tanks.map((t) => tankToData(t)),
    economy: economyToData(state.economy),
    terrain: gridToData(state.terrain.grid),
  };
}

/** save(state) -- savegame.py:275. Produce the byte blob: 6-byte magic + u16 LE
 * version word + UTF-8 JSON body. The Python writes it to a path; the browser
 * build hands the Uint8Array to main to persist (IndexedDB / localStorage). The
 * body bytes are byte-identical to
 * `json.dumps(serialize(state), separators=(",",":")).encode("utf-8")`. */
export function save(state: SaveGameState): Uint8Array {
  const bodyStr = encodeJson(serializeValueTree(state));
  const body = utf8Encode(bodyStr);
  const out = new Uint8Array(HEADER_LEN + body.length);
  // 6-byte magic
  for (let i = 0; i < MAGIC_BYTES.length; i++) out[i] = MAGIC_BYTES[i];
  // u16 little-endian version word
  out[6] = SAVE_VERSION & 0xff;
  out[7] = (SAVE_VERSION >> 8) & 0xff;
  out.set(body, HEADER_LEN);
  return out;
}

/** load(bytes) -- savegame.py:289. Validate magic + version, return the
 * serialized dict. Raises SaveError with a message mirroring the original's
 * guard strings (catalog 18 s3.1) when the blob is not a valid / compatible port
 * save. The blob name (Python passes the path; here `name` defaults to the
 * Python's `path` analog for the message) is interpolated into the guard text so
 * the UI shows the same class of error. */
export function load(bytes: Uint8Array, name = ""): SaveData {
  if (bytes.length < HEADER_LEN) {
    throw new SaveError(`"${name}" is not a saved game.`);
  }
  // magic memcmp (FUN_1000_5923)
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (bytes[i] !== MAGIC_BYTES[i]) {
      // signature mismatch -> "not a saved game" (FUN_400b_0686 line 74).
      throw new SaveError(`"${name}" is not a saved game.`);
    }
  }
  const version = bytes[6] | (bytes[7] << 8); // u16 little-endian
  if (version !== SAVE_VERSION) {
    // version-word mismatch -> "different version" (FUN_400b_0686 line 68; the
    // guard `local_c == 0x18`).
    throw new SaveError(`File "${name}" was created by a different version.`);
  }
  const body = bytes.subarray(HEADER_LEN);
  let bodyStr: string;
  try {
    bodyStr = utf8Decode(body);
  } catch (exc) {
    // Header passed but the body is not valid UTF-8: a truncated / corrupt save.
    // This is not a success, so it must fail loudly (DTM 6.1). Chain the cause on
    // the instance (the tsconfig lib target predates Error's `cause` option).
    const err = new SaveError(`"${name}" is a corrupt saved game.`);
    (err as { cause?: unknown }).cause = exc;
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(bodyStr);
  } catch (exc) {
    // Header passed but the body is unreadable JSON: corrupt save (mirrors the
    // Python's json.JSONDecodeError branch). Chain the cause on the instance.
    const err = new SaveError(`"${name}" is a corrupt saved game.`);
    (err as { cause?: unknown }).cause = exc;
    throw err;
  }
  return data as SaveData;
}

/** apply(data, state) -- savegame.py:321. Restore `data` (from load()) into a
 * GameState-like host, in place. The Python builds a fresh GameState when
 * state===null or the roster/dimensions differ; this port restores into the
 * injected live `state` the integrator owns (RestoreScreen passes the live
 * GameState: screens.py:2192). The roster MUST already match the save's tank
 * count (the integrator rebuilds it before calling, exactly as the Python's
 * rebuild branch reconstructs the player array from the saved names/classes);
 * a mismatch is reported rather than silently mis-restored. Returns the host. */
export function apply(data: SaveData, state: SaveGameState): SaveGameState {
  const w = Math.trunc(data.w);
  const h = Math.trunc(data.h);
  const tankDicts = data.tanks;

  if (state.tanks.length !== tankDicts.length) {
    // The Python rebuilds a fresh GameState here (state===None or roster differs)
    // by reconstructing each player from the saved name/ai_class/team/icon. The
    // browser integrator owns GameState construction (game.ts is not this
    // module's dependency), so it MUST rebuild the roster to the saved shape
    // before calling apply(). Surface the precondition rather than mis-restore.
    throw new SaveError(
      `roster size ${state.tanks.length} != saved ${tankDicts.length}: ` +
        "rebuild the GameState to the saved roster before applying.",
    );
  }

  cfgFromDict(state.cfg, data.cfg);
  if (state.economy.cfg !== undefined) {
    state.economy.cfg = state.cfg;
  }
  state.w = w;
  state.h = h;

  const tanksByIndex: { [idx: number]: SaveTank } = {};
  for (const t of state.tanks) tanksByIndex[t.player_index] = t;
  for (let i = 0; i < state.tanks.length; i++) {
    applyTank(state.tanks[i], tankDicts[i], tanksByIndex);
  }

  applyEconomy(state.economy, data.economy);
  state.terrain.grid = gridFromDict(data.terrain);

  state.round_index = data.round_index;
  state.phase = data.phase;
  state.timer = data.timer ?? 0.0;
  state.message = data.message ?? "";
  state.fire_index = data.fire_index ?? 0;
  state.firing_order = (data.firing_order ?? state.tanks.map((_, i) => i)).slice();
  const ll = data.last_landing;
  state.last_landing = ll != null ? [ll[0], ll[1]] : null;
  const csi = data.current_shooter_index;
  state.current_shooter = csi != null ? tanksByIndex[csi] ?? null : null;
  const wi = data.winner_index;
  state.winner = wi != null ? tanksByIndex[wi] ?? null : null;
  state.ranking = (data.ranking_indices ?? [])
    .filter((idx) => idx in tanksByIndex)
    .map((idx) => tanksByIndex[idx]);

  // transient in-flight state is not persisted (the original saves between
  // turns, not mid-volley): clear projectiles / effects so the restored round
  // resumes cleanly at its phase.
  if (state.projectiles) state.projectiles.length = 0;
  if (state.explosions) state.explosions.length = 0;
  if (state.beams) state.beams.length = 0;
  state.awaiting_human = false;
  return state;
}

// ===========================================================================
// UTF-8 (TextEncoder/TextDecoder are present in both Node >= 11 and browsers;
// the differential test asserts the body bytes equal Python's utf-8 encoding).
// ===========================================================================
const _utf8Enc = new TextEncoder();
// fatal:true so malformed UTF-8 throws (the corrupt-save path) instead of
// silently substituting U+FFFD, which would hide a truncated body.
const _utf8Dec = new TextDecoder("utf-8", { fatal: true });

function utf8Encode(s: string): Uint8Array {
  return _utf8Enc.encode(s);
}
function utf8Decode(b: Uint8Array): string {
  return _utf8Dec.decode(b);
}
