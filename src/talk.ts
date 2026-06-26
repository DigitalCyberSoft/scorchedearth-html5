/**
 * Talking Tanks: attack/die taunts + end-of-game war quotes (talk.cpp, seg 2144;
 * war-quote display FUN_269a_0001 / picker FUN_3bf3_000b).
 *
 * Faithful TypeScript port of scorch-py/scorch/talk.py (the fidelity oracle,
 * itself byte-verified against 1.5/SCORCH.EXE + the shipped 1.5/TALK1.CFG /
 * 1.5/TALK2.CFG read in full). Provenance comments (FUN_<seg>_<off>, catalog
 * cites, strings: locators) are preserved verbatim from the Python so the
 * lineage survives.
 *
 * Ground truth (catalog 06_messages_world.md s.1, catalog 18 s.10):
 *   File format (06:21-30): plain ASCII, ONE taunt per line, CRLF-terminated.
 *   No section/key/header/comment syntax INSIDE a talk file (the `;`-comment
 *   convention is scorch.cfg-only, 06:73). Two rules the DOC states
 *   (SCORCH.DOC:L2102-2104) and a reimplementation MUST honor:
 *     * duplicate lines bias the draw: a line appearing N times is N times as
 *       likely (so DO NOT de-duplicate),
 *     * a blank line is a valid entry meaning "say nothing" (so DO NOT strip
 *       interior blanks; a drawn blank shows no bubble).
 *   The shipped files: TALK1.CFG = 54 attack lines, TALK2.CFG = 60 die lines,
 *   each with a trailing CRLF (verified `od -c`), and no intentional blank line.
 *
 *   Categories (06:38-45): exactly two in v1.5, attack (ATTACK_COMMENTS ->
 *   talk1.cfg) and die (DIE_COMMENTS -> talk2.cfg). The files are interchangeable;
 *   only the cfg slot pointing at a file decides attack-vs-die.
 *
 *   Gate TALKING_TANKS (06:76, SCORCH.DOC:L2079-2085): OFF = no taunts;
 *   COMPUTERS = AI tanks only; ALL = every tank. Human = Tank.ai_class == 0
 *   (constants.AI_HUMAN; objects.Tank.ai_class).
 *
 *   Probability (06:77, SCORCH.DOC:L2095-2097/L2110): before a tank FIRES, roll
 *   0..99; if < TALK_PROBABILITY draw one uniform-random ATTACK line and flash it.
 *   On death, draw one uniform-random DIE line (same TALKING_TANKS gate).
 *
 *   War quotes (catalog 18 s.10, FUN_3bf3_000b picks rand%15 from a 15-entry
 *   {text,author} table at 5f38:0x5864; FUN_269a_0001 splits the text on '\n'
 *   into up to 3 centered lines and prints text + author). Between-screen flavor
 *   shown by the title/game-over routine FUN_33a1_054a, NOT a taunt category --
 *   they MUST NOT be fed through the talk pool (catalog 18:777-779).
 */
import * as C from "./constants";
import { Rng, rng as global_rng } from "./rng";

// ---------------------------------------------------------------------------
// War-quote table (FACT: verbatim from /tmp/scorch15/strings_all.txt, the 15
// {text, author} pairs at strings:5b659-5bc4e; table base 5f38:0x5864, 0xf=15
// entries, catalog 18 s.10). Multi-line quote bodies are joined with a single
// space (FUN_269a_0001 splits on '\n' only to wrap for display).
// ---------------------------------------------------------------------------
export const WAR_QUOTES: ReadonlyArray<readonly [string, string]> = [
  [
    "There's many a boy here today who looks on war as all glory, " +
      "but, boys, it is all hell.",
    "Gen. William T. Sherman",
  ],
  [
    "The essence of war is violence.  Moderation in war is imbecility.",
    "Fisher",
  ],
  ["War is the science of destruction.", "John Abbott"],
  ["Providence is always on the side of the big battalions.", "Sevigne"],
  [
    "War is a matter of vital importance to the State; the province of " +
      "life or death; the road to survival or ruin.  It is mandatory that " +
      "it be throughly studied.",
    "Sun Tzu",
  ],
  [
    "War should be the only study of a prince.  He should consider " +
      "peace only as a breathing-time, which gives him leisure to " +
      "contrive, and furnishes as ability to execute, military plans.",
    "Macchiavelli",
  ],
  [
    "Not with dreams but with blood and iron, " +
      "Shall a nation be moulded at last.",
    "Swinburne",
  ],
  [
    "No one can guarantee success in war, but only deserve it.",
    "Winston Churchill",
  ],
  [
    "The grim fact is that we prepare for war like precocious giants " +
      "and for peace like retarded pygmies.",
    "Lester Pearson",
  ],
  [
    "We cannot live by power, and a culture that seeks to live " +
      "by it becomes brutal and sterile.  But we can die without it.",
    "Max Lerner",
  ],
  [
    "No man is wise enough, nor good enough to be trusted with " +
      "unlimited power.",
    "Charles Colton",
  ],
  ["Nothing good ever comes of violence.", "Martin Luther"],
  [
    "Give me the money that has been spent in war, and ... I will " +
      "clothe every man, woman and child in attire of which kings and " +
      "queens would be proud.",
    "Henry Richard",
  ],
  ["That mad game the world so loves to play.", "Jonathon Swift"],
  [
    "Nearly all men can stand adversity, but if you want to test a man's " +
      "character, give him power.",
    "Abraham Lincoln",
  ],
];

// ---------------------------------------------------------------------------
// Minimal duck-typed shapes the talk routines read off their arguments. The
// Python is dynamically typed; these interfaces capture exactly the fields the
// control flow touches (no more), keeping the port faithful and type-checked.
// ---------------------------------------------------------------------------

/** A Config-like object: only the talk keys are read here. */
export interface TalkSettingsSource {
  TALKING_TANKS: string;
  TALK_PROBABILITY: number;
  TALK_DELAY: number;
  ATTACK_COMMENTS: string;
  DIE_COMMENTS: string;
}

/** A tank: the gate reads only ai_class (objects.Tank.ai_class). */
export interface TankLike {
  ai_class: number;
}

// ---------------------------------------------------------------------------
// Talk-file loading (FUN_2144_0110 generic line-array loader / FUN_2144_02c7
// loads both files). Two-pass loader semantics: keep blanks, keep duplicates.
// ---------------------------------------------------------------------------
export class TalkConfig {
  /** ATTACK_COMMENTS pool (talk1.cfg). */
  attack: string[];
  /** DIE_COMMENTS pool (talk2.cfg). */
  die: string[];
  /** OFF / COMPUTERS / ALL (cfg.TALKING_TANKS, uppercased). */
  talking: string;
  /** 0..100 (cfg.TALK_PROBABILITY). */
  probability: number;
  /** on-screen lifetime in frames (cfg.TALK_DELAY). */
  delay: number;

  /**
   * attack / die are line LISTS (not sets): blanks and duplicates are preserved
   * because duplication is the weighting mechanism and a blank is the "say
   * nothing" entry (catalog 06:30/72).
   */
  constructor(attack: string[], die: string[], cfg: TalkSettingsSource) {
    this.attack = attack;
    this.die = die;
    this.talking = String(cfg.TALKING_TANKS).toUpperCase(); // OFF / COMPUTERS / ALL
    this.probability = pyInt(cfg.TALK_PROBABILITY); // 0..100
    this.delay = pyInt(cfg.TALK_DELAY); // on-screen lifetime (frames)
  }
}

/**
 * `int(...)` truncates toward zero in Python. The cfg values are already ints
 * here, but match the coercion exactly (handles a float/str-bearing cfg).
 */
function pyInt(v: number | string): number {
  const n = typeof v === "string" ? parseInt(v, 10) : v;
  return Math.trunc(n);
}

/**
 * Split a talk-file's raw text into the taunt pool (FUN_2144_0110).
 *
 * Liberal terminator handling (catalog 06:70): normalize CRLF and bare CR to
 * LF, then split on LF. The shipped files end with a trailing terminator
 * (verified `od -c`), which yields one empty trailing element -- that single
 * element is the file's end, not a "say nothing" entry, so it is dropped.
 * INTERIOR blank lines are kept (06:30): a blank is a valid taunt meaning the
 * tank says nothing that draw. Duplicates are kept (06:72): duplication is the
 * frequency-weighting mechanism.
 */
export function _parse(raw: string): string[] {
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop(); // drop the final-terminator artifact only
  }
  return lines;
}

/**
 * Read a talk file as bytes and decode as latin-1 (FUN_2144_0110 read path).
 *
 * DOS text files are single-byte; latin-1 is the byte-faithful 1:1 decode (no
 * UnicodeDecodeError on stray high bytes) -- the talk content is plain ASCII
 * but latin-1 keeps any 8-bit char a user added to their own talk file.
 * Returns "" if the file is absent (the engine simply has no taunts then).
 *
 * Node-only: the browser build supplies pools via embedded/loaded vectors and
 * does not call this. `readFile` is the injected reader (fs.readFileSync in
 * Node); kept as a parameter so the module stays environment-agnostic and
 * testable.
 */
export function _read(
  path: string,
  readFile: (p: string) => Uint8Array | null,
): string {
  const bytes = readFile(path);
  if (bytes === null) {
    return "";
  }
  // latin-1: each byte maps 1:1 to U+0000..U+00FF.
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

/**
 * Load the attack + die taunt pools (FUN_2144_02c7) and snapshot the talk
 * settings from `cfg`. Returns a TalkConfig. A missing file yields an empty
 * pool for that category (no taunts), not an error.
 */
export function load(
  attack_path: string,
  die_path: string,
  cfg: TalkSettingsSource,
  readFile: (p: string) => Uint8Array | null,
): TalkConfig {
  const attack = _parse(_read(attack_path, readFile));
  const die = _parse(_read(die_path, readFile));
  return new TalkConfig(attack, die, cfg);
}

/**
 * Resolve a talk filename against base_dir case-INSENSITIVELY (DOS FAT
 * semantics).
 *
 * The engine ran on DOS (case-insensitive FAT): the default cfg ships
 * ATTACK_COMMENTS=talk1.cfg / DIE_COMMENTS=talk2.cfg (lowercase) while the data
 * files ship as TALK1.CFG / TALK2.CFG (uppercase). On a case-sensitive host a
 * literal join misses the file and the pool loads empty. Match DOS semantics:
 * try the literal path, then fall back to a case-insensitive scan of base_dir.
 * Returns the literal join when nothing matches (load() then yields an empty
 * pool, the same as a genuinely absent file).
 *
 * `joinPath`, `pathExists`, and `listDir` are injected filesystem primitives so
 * the resolver matches Python's os.path.join / os.path.exists / os.listdir
 * without binding the module to Node at import time.
 */
export function _resolve(
  base_dir: string,
  name: string,
  fs: {
    joinPath: (a: string, b: string) => string;
    pathExists: (p: string) => boolean;
    listDir: (p: string) => string[] | null;
  },
): string {
  const literal = fs.joinPath(base_dir, name);
  if (fs.pathExists(literal)) {
    return literal;
  }
  const entries = fs.listDir(base_dir);
  if (entries !== null) {
    const lower = name.toLowerCase();
    for (const entry of entries) {
      if (entry.toLowerCase() === lower) {
        return fs.joinPath(base_dir, entry);
      }
    }
  }
  return literal;
}

/**
 * Convenience: resolve ATTACK_COMMENTS / DIE_COMMENTS filenames against
 * `base_dir` (the directory the talk files ship in, e.g. the 1.5/ data dir),
 * then load. Filenames in the cfg are bare ("talk1.cfg"); the engine opens them
 * relative to the game data directory, case-insensitively (see _resolve).
 */
export function load_from_config(
  cfg: TalkSettingsSource,
  base_dir: string,
  fs: {
    joinPath: (a: string, b: string) => string;
    pathExists: (p: string) => boolean;
    listDir: (p: string) => string[] | null;
    readFile: (p: string) => Uint8Array | null;
  },
): TalkConfig {
  const ap = _resolve(base_dir, cfg.ATTACK_COMMENTS, fs);
  const dp = _resolve(base_dir, cfg.DIE_COMMENTS, fs);
  return load(ap, dp, cfg, fs.readFile);
}

// ---------------------------------------------------------------------------
// Gate + draws
// ---------------------------------------------------------------------------

/**
 * TALKING_TANKS gate (catalog 06:76). OFF -> never; COMPUTERS -> AI tanks only
 * (ai_class != AI_HUMAN); ALL -> every tank.
 */
export function _talks(tank: TankLike, cfg: TalkConfig): boolean {
  const mode = cfg.talking;
  if (mode === "ALL") {
    return true;
  }
  if (mode === "COMPUTERS") {
    return tank.ai_class !== C.AI_HUMAN;
  }
  return false; // OFF (and any unknown token)
}

/**
 * Uniform-random line from a pool (FUN_2144_00c9: rand % count, index the
 * far-ptr array). Returns null for an empty pool; returns the drawn line
 * verbatim otherwise -- including an empty string when a blank line is drawn
 * (the roll "succeeded" but the tank says nothing, catalog 06:79).
 */
export function _draw(pool: string[], rng: Rng): string | null {
  if (pool.length === 0) {
    return null;
  }
  return pool[rng.pick(pool.length)];
}

/**
 * Pre-fire attack taunt (catalog 06:77). Returns a taunt string if this tank
 * talks AND the probability roll passes, else null.
 *
 * Gate then roll: TALKING_TANKS must apply to this tank, then roll 0..99 and
 * talk iff < TALK_PROBABILITY. A drawn blank line returns "" (a successful roll
 * that shows no bubble) -- distinct from null (did not talk).
 */
export function maybe_attack_taunt(
  tank: TankLike,
  cfg: TalkConfig,
  rng: Rng = global_rng,
): string | null {
  if (!_talks(tank, cfg)) {
    return null;
  }
  if (rng.pick(100) >= cfg.probability) {
    // roll 0..99 < TALK_PROBABILITY
    return null;
  }
  return _draw(cfg.attack, rng);
}

/**
 * Death taunt (catalog 06:78). Returns a die-pool line when the tank is
 * destroyed, subject to the SAME gate-then-roll as the attack taunt.
 *
 * The die driver FUN_2144_0315 (talk2.cfg pool) and the attack driver
 * FUN_2144_0361 (talk1.cfg pool) read SEPARATE pools but call the SAME display
 * function FUN_2144_04bd, and the TALK_PROBABILITY roll lives there
 * (FUN_2144_04bd.c:12-13: `5118!=0 && 511a!=0 && 50f0==0 && rand(100) < 511a`).
 * So the death taunt IS probability-gated, exactly like the attack taunt. A
 * prior port note guessed it was not (an unverified DOC-scope reading); reading
 * FUN_2144_0315 -> FUN_2144_04bd resolved that against the guess. Fixed
 * 2026-06-25. (FAST_COMPUTERS speech suppression, the 50f0==0 term, is still
 * unported on BOTH paths -- a separate lower-severity gap.)
 */
export function die_taunt(
  tank: TankLike,
  cfg: TalkConfig,
  rng: Rng = global_rng,
): string | null {
  if (!_talks(tank, cfg)) {
    return null;
  }
  if (rng.pick(100) >= cfg.probability) {
    // FUN_2144_04bd.c:13 shared roll
    return null;
  }
  return _draw(cfg.die, rng);
}

/**
 * End-of-game war quote (FUN_3bf3_000b picker + FUN_269a_0001 display). Returns
 * [text, author] drawn uniformly from the 15-entry table. FACT: the table text
 * is verbatim from the binary (strings:5b659-5bc4e); not reconstructed. Display
 * splits `text` for centering (see WAR_QUOTES note).
 */
export function war_quote(rng: Rng = global_rng): readonly [string, string] {
  return WAR_QUOTES[rng.pick(WAR_QUOTES.length)];
}

// ---------------------------------------------------------------------------
// Display model: a single active speech bubble parked on the GameState for the
// renderer to draw over the firing/dying tank, expiring after TALK_DELAY frames.
//
// Mirrors the existing effect-animation convention in game.py (explosions/beams
// carry an integer `frame` advanced once per _animate_effects call). One bubble
// at a time is sufficient for SEQUENTIAL (one shooter) and is the simplest
// faithful model; SIMULTANEOUS could show several at once -- see the hook notes.
// ---------------------------------------------------------------------------

/** The parked speech bubble (state.speech). */
export interface SpeechBubble {
  tank: unknown;
  text: string;
  until_frame: number;
}

/**
 * Display-model host. Mirrors the duck-typed Python GameState the talk display
 * functions read/write: a mutable `speech` slot, an optional `_speech_frame`
 * accumulator, and an optional `cfg` carrying TALK_DELAY. Optionality mirrors
 * Python's hasattr/getattr probing.
 */
export interface SpeechState {
  speech?: SpeechBubble | null;
  _speech_frame?: number;
  cfg?: { TALK_DELAY?: number } | null;
}

/** A cfg-or-TalkConfig the bubble may carry a delay from. */
type DelaySource =
  | { delay: number }
  | { TALK_DELAY?: number }
  | null
  | undefined;

/**
 * Park a speech bubble {tank, text, until_frame} on state.speech.
 *
 * `until_frame` is an absolute frame index = state._speech_frame + delay, where
 * delay is TALK_DELAY frames (cfg.delay if a TalkConfig is passed, else the
 * Config's TALK_DELAY, else a sane default). A null/empty `text` clears any
 * bubble (a drawn blank taunt shows nothing, catalog 06:79).
 */
export function set_speech(
  state: SpeechState,
  tank: unknown,
  text: string | null,
  cfg: DelaySource = null,
): void {
  if (!text) {
    state.speech = null;
    return;
  }
  if (!hasOwn(state, "_speech_frame")) {
    state._speech_frame = 0;
  }
  let delay: number;
  if (cfg != null && hasAttr(cfg, "delay")) {
    delay = (cfg as { delay: number }).delay;
  } else if (cfg != null) {
    delay = pyInt(getAttr(cfg, "TALK_DELAY", 50));
  } else {
    const stateCfg = getAttr(state, "cfg", null) as {
      TALK_DELAY?: number;
    } | null;
    delay = pyInt(getAttr(stateCfg, "TALK_DELAY", 50));
  }
  delay = Math.max(1, Math.trunc(delay));
  state.speech = {
    tank,
    text,
    until_frame: (state._speech_frame as number) + delay,
  };
}

/**
 * Advance the speech-bubble clock by `dt` seconds and expire the bubble when
 * its TALK_DELAY frames have elapsed. Frame advance = dt / DT (physics runs at
 * 1/DT = 60fps), accumulated so sub-frame dt does not stall the timer. Drops a
 * bubble whose tank has since died (the wreck should not keep talking).
 */
export function tick(state: SpeechState, dt: number): void {
  if (!hasOwn(state, "_speech_frame")) {
    state._speech_frame = 0;
  }
  state._speech_frame = (state._speech_frame as number) + dt / C.DT;
  const sp = getAttr(state, "speech", null) as SpeechBubble | null;
  if (sp === null) {
    return;
  }
  if ((state._speech_frame as number) >= sp.until_frame) {
    state.speech = null;
  }
}

// ---------------------------------------------------------------------------
// hasattr/getattr emulation. Python's set_speech/tick probe the GameState with
// hasattr/getattr (the renderer attaches these fields lazily). These helpers
// reproduce that probing on a plain TS object: a key present (even if its value
// is null/0) counts as "has"; getattr returns a default when the key is absent.
// ---------------------------------------------------------------------------
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** hasattr(obj, key): the attribute exists (mirrors Python hasattr, which is
 * true for any present, non-raising attribute). */
function hasAttr(obj: unknown, key: string): boolean {
  return obj != null && key in (obj as object);
}

/** getattr(obj, key, default): the value if present, else default. Matches
 * Python where an explicitly-None value is returned as None (not the default). */
function getAttr<T>(obj: unknown, key: string, dflt: T): T {
  if (obj != null && key in (obj as object)) {
    const v = (obj as Record<string, unknown>)[key];
    return v as T;
  }
  return dflt;
}
