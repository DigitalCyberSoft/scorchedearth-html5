/**
 * Mouse-driven out-of-game UI screens -- a faithful TypeScript port of
 * scorch-py/scorch/screens.py (the fidelity oracle), drawn against src/pygame.ts.
 *
 * Faithful to port/SCREENS.md: verbatim labels (the `~` accelerator marker is
 * kept; the hot letter renders underlined), the widget mix per the 4f19 builders,
 * and the modal contract from SCREENS.md s0.2.  Every screen is mouse-first
 * (clickable widgets, hit-testing) with `~`-accelerators as a secondary path,
 * Enter = default button, Esc = cancel (unless the panel is no-cancel), and
 * click-outside = cancel (unless no-cancel).
 *
 * Each screen subclasses screen.Screen and returns action strings from handle():
 *   MainMenuScreen     : 'start_game', 'save_changes', 'push:<submenu>'
 *   OptionsScreen      : 'pop'
 *   TankInitScreen     : 'tank_done'  (then read .result =
 *                        (name, ai_class, team, tank_icon))
 *   ConfigureTeamsScreen : 'pop'  (mutates each Tank.team_id in place)
 *   ShopScreen         : 'pop', 'push:sell'  (then read .sell_slot)
 *   SellScreen         : 'pop'
 *
 * The submenu names pushed by MainMenuScreen match the SUBMENUS keys below.
 * SCREENS.md citations are inline (s<section>, strings_clean.txt:Lnn).
 *
 * NUMERIC SUBSTRATE vs DRAWN PIXELS (read before testing):
 *   The differential gate (test/screens.test.ts) runs in Node, DOM-free, so it
 *   exercises the LOGIC layer only and reaches the real method bodies through the
 *   Object.create(prototype) headless seam (the same seam ingame's
 *   _BatteryDischargeScreen uses): module data tables (ENUM_LABELS / SUBMENUS /
 *   AI_TYPE_LABELS / TANK_ICONS / REGISTRATION_LINES / SHOP_ICON_RGB6),
 *   tank_icon_mobile, _build_shop_lut, _list_saves / _save_path filename handling,
 *   the shop buy/sell/affordability + scroll/selection FLOW, SellScreen pricing,
 *   TankInit selector/sim-key state + cycle-phase math, and rankings/option
 *   cycling.  NONE of those touch pygame.font / pygame.Surface / pygame.draw.
 *   The .draw() methods (literal pixels) AND every Screen CONSTRUCTOR (which build
 *   font-measured Label/Button widgets) need a DOM and defer to the Phase-3 visual
 *   gate (pixelsDeferredToPhase3 = true).
 *
 * SPRITES CAVEAT (integrator hook): screens.py draws tank-appearance cells and
 *   shop/inventory weapon icons through scorch.sprites (get_sprite /
 *   draw_tank_icon_cell / weapon_icon_palette).  The sprites module is not yet
 *   ported to TS and this agent may only touch screens.ts, so those calls route
 *   through a settable provider (setSpritesProvider) the integrator supplies from
 *   the ported sprites module.  Until a provider is set the icon-draw helpers are
 *   no-ops (they cannot fabricate the sprite); the surrounding panel chrome still
 *   draws.  This is pixel-path only and defers to the Phase-3 visual gate.
 *
 * SAVE/RESTORE FS CAVEAT (integrator hook): screens.py's SaveScreen/RestoreScreen
 *   do real os.listdir / open(path,"wb") / savegame.save(state, path) I/O.  The
 *   browser has no filesystem, so the actual byte read/write and the directory
 *   listing route through settable providers (setSaveStoreProvider): the port
 *   keeps the verbatim filename-normalisation, overwrite-confirm, and error-status
 *   logic (all unit-tested) and hands the host the resolved basename + bytes.  The
 *   TS savegame.save/load signatures differ from Python (save(state)->Uint8Array,
 *   load(bytes)->SaveData), so the host provider bridges to the byte store.
 */
import * as pygame from "./pygame";
import * as C from "./constants";
import * as weapons from "./weapons";
import * as palette from "./palette";
import * as render from "./render";
import * as savegame from "./savegame";
import * as W from "./widgets";
import {
  Panel,
  Button,
  Label,
  Spinner,
  Selector,
  Toggle,
  TextField,
  RadioGroup,
  Slider,
  Frame,
  IconStrip,
  draw_cursor,
} from "./widgets";
import { Screen } from "./screen";
import type { ScreenAction, ScreenEvent } from "./screen";
import { Economy, pyRound } from "./economy";
import type { EconomyTank } from "./economy";

// ---------------------------------------------------------------------------
// Integrator hooks for the not-yet-ported sprites module (pixel path only).
// screens.py imports scorch.sprites for the tank-appearance cells and the shop/
// inventory weapon icons.  Those are draw-time helpers (Phase-3 visual gate); the
// provider is supplied by the integrator from the ported sprites module.  Until
// then the helpers are no-ops -- they cannot fabricate the sprite asset here.
// ---------------------------------------------------------------------------
export interface SpritesProvider {
  /** sprites.get_sprite(table, slot, color=, pal=, scale=) -> Surface|null. */
  get_sprite(
    table: string,
    slot: number,
    opts: { color?: number; pal?: unknown; scale?: number },
  ): pygame.Surface | null;
  /** sprites.draw_tank_icon_cell(surf, box, color, design_index=, grayed=, scale=). */
  draw_tank_icon_cell(
    surf: pygame.Surface,
    box: pygame.Rect,
    color: [number, number, number],
    opts: { design_index: number; grayed?: boolean; scale?: number },
  ): void;
  /** sprites.weapon_icon_palette() -> a (256,3) RGB table. */
  weapon_icon_palette(): unknown;
  /** sprites.WEAPON_ICON_BASE: the DAC band base the weapon icons index. */
  WEAPON_ICON_BASE: number;
}

let _sprites: SpritesProvider | null = null;

/** Integrator hook: supply the ported sprites module (icon/cell painters). */
export function setSpritesProvider(p: SpritesProvider | null): void {
  _sprites = p;
}

// ---------------------------------------------------------------------------
// Integrator hook for the save/restore byte store (no browser filesystem).
// The port keeps all filename/overwrite/error logic; the host supplies the
// directory listing + the actual read/write (bridging the TS savegame byte API).
// ---------------------------------------------------------------------------
export interface SaveStoreProvider {
  /** Existing .sav basenames WITHOUT extension (os.listdir + splitext analog). */
  list(): string[];
  /** True iff a save with this basename (no ext) exists (os.path.exists analog). */
  exists(basename: string): boolean;
  /** Persist `bytes` under `basename` (open(path,"wb") + savegame.save analog).
   *  Throws on I/O failure (the OSError branch); the caller reports the status. */
  write(basename: string, bytes: Uint8Array): void;
  /** Read the raw save bytes for `basename`, or null if missing
   *  (FileNotFoundError analog -> the verbatim missing-file message). */
  read(basename: string): Uint8Array | null;
}

let _saveStore: SaveStoreProvider | null = null;

/** Integrator hook: supply the host save/restore byte store. */
export function setSaveStoreProvider(p: SaveStoreProvider | null): void {
  _saveStore = p;
}

// ---------------------------------------------------------------------------
// Pixel-path helpers reproduced locally because their widgets.ts originals are
// module-private / not in the pygame shim, and this agent may only touch
// screens.ts.  Both are draw-time only (Phase-3 visual gate); the bodies are
// byte-faithful to widgets.ts (_draw_accel_text) and pygame (Rect.union).
// ---------------------------------------------------------------------------

/** widgets._draw_accel_text: render `text`, drawing the char after '~'
 *  underlined/cyan (the accelerator).  Faithful copy of widgets.ts:82-115 (which
 *  does not export it).  Returns the advanced x. */
function _draw_accel_text(
  surf: pygame.Surface,
  text: string,
  x: number,
  y: number,
  color: pygame.ColorArg = W.C_TEXT,
  fnt: pygame.Font | null = null,
): number {
  const f = fnt || W.font();
  let cx = x;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "~" && i + 1 < text.length) {
      const nxt = text[i + 1];
      const r = f.render(nxt, true, W.C_ACCEL);
      surf.blit(r, [cx, y]);
      pygame.draw.line(surf, W.C_ACCEL, [cx, y + r.get_height() - 2], [cx + r.get_width(), y + r.get_height() - 2]);
      cx += r.get_width();
      i += 2;
    } else {
      const r = f.render(ch, true, color);
      surf.blit(r, [cx, y]);
      cx += r.get_width();
      i += 1;
    }
  }
  return cx;
}

/** pygame Rect.union: the smallest rect enclosing both `a` and `b`. */
function _rect_union(a: pygame.Rect, b: pygame.Rect): pygame.Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return new pygame.Rect(x, y, right - x, bottom - y);
}

// ---------------------------------------------------------------------------
// 6-bit DAC -> 8-bit RGB.  palette._rgb8/_e8 are module-private in palette.ts, so
// the per-channel expansion is inlined here, byte-faithful to palette._e8: the
// engine's `<< 2` expansion, min(255, (v6 & 0x3F) << 2) (palette.py:110-112).
// The & 0x3F matches Python's two's-complement bitwise-and on negatives (and TS
// bitwise-& yields the same for 32-bit ints), so negative v6 agrees.
// ---------------------------------------------------------------------------
function _e8(v6: number): number {
  return Math.min(255, (Math.trunc(v6) & 0x3f) << 2);
}
function _rgb8(r6: number, g6: number, b6: number): [number, number, number] {
  return [_e8(r6), _e8(g6), _e8(b6)];
}

// ---------------------------------------------------------------------------
// _owned_offensive: ingame._owned_offensive is module-private in ingame.ts, so
// the (trivial, pure) function is reproduced here -- identical body, not a
// divergence (ingame.py:354-356).  Same set the HUD weapon-cycle uses.
// ---------------------------------------------------------------------------
interface OwnTank {
  cash: number;
  inventory: number[];
  player_index?: number;
  name: string;
  has_ammo(slot: number): boolean;
  selected_weapon?: number;
  selected_guidance?: number | null;
}

function _owned_offensive(t: OwnTank): number[] {
  const out: number[] = [];
  for (let i = 0; i < weapons.NUM_ITEMS; i++) {
    if (weapons.ITEMS[i].offensive && t.has_ammo(i)) {
      out.push(i);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Loose structural shapes the screens read off the host state.  These mirror the
// duck-typed attributes screens.py touches; kept permissive (the integrator hands
// the real GameState / Tank / Config in).
// ---------------------------------------------------------------------------
interface ShopState {
  economy: Economy;
  cfg: { MAXROUNDS: number; is_on(key: string): boolean };
  round_index: number;
}

interface CfgLike {
  // dynamic enum/numeric/string keys, read/written through getattr/setattr.
  [k: string]: unknown;
  MAXPLAYERS: number;
  MAXROUNDS: number;
  is_on(key: string): boolean;
}

// ---------------------------------------------------------------------------
// Enum field bindings: (cfg_token_order, verbatim_display_labels).
// Token order is config.py's enum dict order (the order the engine consumes);
// the display strings are the verbatim labels from SCREENS.md, index-for-index.
// Where SCREENS.md flags a display<->cfg pairing [I], the binding follows the
// cfg token order so the Selector index equals the engine's enum index.
// ---------------------------------------------------------------------------
export const ENUM_LABELS: { [key: string]: [string[], string[]] } = {
  // SCORING (s2c, [CODE] 0/1/2 = Basic/Standard/Greedy)
  SCORING: [["BASIC", "STANDARD", "GREEDY"], ["Basic", "Standard", "Greedy"]],
  // TEAM_MODE (s2f, [CODE] default 0=None)
  TEAM_MODE: [
    ["NONE", "STANDARD", "CORPORATE", "VICIOUS"],
    ["None", "Standard", "Corporate", "Vicious"],
  ],
  // PLAY_MODE (s2f, [CODE] default 0=Sequential)
  PLAY_MODE: [
    ["SEQUENTIAL", "SYNCHRONOUS", "SIMULTANEOUS"],
    ["Sequential", "Synchronous", "Simultaneous"],
  ],
  // PLAY_ORDER (s2f, [CODE] default 0=Random)
  PLAY_ORDER: [
    ["RANDOM", "LOSERS-FIRST", "WINNERS-FIRST", "ROUND-ROBIN"],
    ["Random", "Losers-First", "Winners-First", "Round-Robin"],
  ],
  // ELASTIC / Effect of Walls (s2e, cfg index order 0..7)
  ELASTIC: [
    ["NONE", "WRAP", "PADDED", "RUBBER", "SPRING", "CONCRETE", "RANDOM", "ERRATIC"],
    ["None", "Wrap-around", "Padded", "Rubber", "Spring", "Concrete", "Random", "Erratic"],
  ],
  // EXPLOSION_SCALE / Scale (s2f, cfg NORMAL/MEDIUM/LARGE)
  EXPLOSION_SCALE: [["NORMAL", "MEDIUM", "LARGE"], ["Normal", "Medium", "Large"]],
  // SKY (s2d) - cfg token order from config.py; verbatim display per token.
  SKY: [
    ["PLAIN", "STORMY", "STARS", "SHADED", "SUNSET", "CAVERN", "BLACK", "RANDOM"],
    ["Plain", "Storm", "Stars", "Shaded", "Sunset", "Cavern", "Black", "Random"],
  ],
  // GRAPHICS_MODE (s2a) - verbatim resolution strings, default 360x480.
  GRAPHICS_MODE: [
    ["320x200", "320x240", "320x400", "320x480", "360x480", "640x400", "640x480", "800x600", "1024x768"],
    ["320x200", "320x240", "320x400", "320x480", "360x480", "640x400", "640x480", "800x600", "1024x768"],
  ],
  // FLY_SOUND / Flight Sounds (s2a) - POS/VEL/OFF (display [I]).
  FLY_SOUND: [["POS", "VEL", "OFF"], ["By Height", "By Velocity", "Off"]],
  // TALKING_TANKS (s2f) - OFF/COMPUTERS/ALL (Computers [V 1359]; Off/All [I]).
  TALKING_TANKS: [["OFF", "COMPUTERS", "ALL"], ["Off", "Computers", "All"]],
  // BOMB_ICON (s2g) - {Invisible, Small, Big} (subset [I]).
  BOMB_ICON: [["INVISIBLE", "SMALL", "BIG"], ["Invisible", "Small", "Big"]],
};

/** Build a Selector bound to a string-enum cfg key via ENUM_LABELS. */
function _enum_selector(
  panel: Panel,
  x: number,
  y: number,
  cfg: CfgLike,
  key: string,
  label: string,
  w = 300,
): Selector {
  const [tokens, display] = ENUM_LABELS[key];

  const get_idx = (): number => {
    // Case-insensitive match: GRAPHICS_MODE tokens are mixed-case ("1024x768")
    // while cur is uppercased, so without upper-casing the tokens too the
    // selector never matches its own value and sticks at index 0 (every other
    // enum's tokens are already uppercase).  Menu-audit defect.
    const cur = String(cfg[key]).toUpperCase();
    const tokens_u = tokens.map((t) => t.toUpperCase());
    const j = tokens_u.indexOf(cur);
    return j >= 0 ? j : 0;
  };

  const set_idx = (i: number): void => {
    cfg[key] = tokens[((i % tokens.length) + tokens.length) % tokens.length];
  };

  return panel.add(new Selector(x, y, label, display, get_idx, set_idx, w));
}

/** Build a Toggle (On/Off) bound to a cfg ON/OFF string key. */
function _toggle(
  panel: Panel,
  x: number,
  y: number,
  cfg: CfgLike,
  key: string,
  label: string,
  w = 300,
): Toggle {
  const get = (): boolean => cfg.is_on(key);
  const set_ = (v: boolean): void => {
    cfg[key] = v ? "ON" : "OFF";
  };
  return panel.add(new Toggle(x, y, label, get, set_, w));
}

/** Build a numeric Spinner bound to a cfg int/float key. */
function _num_spinner(
  panel: Panel,
  x: number,
  y: number,
  cfg: CfgLike,
  key: string,
  label: string,
  lo: number,
  hi: number,
  step = 1,
  fmt: (v: number) => string = String,
  w = 300,
): Spinner {
  const get = (): number => cfg[key] as number;
  const set_ = (v: number): void => {
    cfg[key] = v;
  };
  return panel.add(new Spinner(x, y, label, get, set_, lo, hi, step, fmt, w));
}

// ---------------------------------------------------------------------------
// Submenu field tables.  Each row is a tuple whose first element is the widget
// kind, the rest its binding.  Kinds:
//   ["toggle",  cfg_key, label]
//   ["enum",    cfg_key, label]            -> ENUM_LABELS
//   ["int",     cfg_key, label, lo, hi[, step]]
//   ["float",   cfg_key, label, lo, hi, step, fmt]
//   ["action",  action_string, label]      -> a Button (e.g. Calibrate)
// Labels and ranges are verbatim from SCREENS.md (sections cited per group).
// ---------------------------------------------------------------------------
function _f2(v: number): string {
  return v.toFixed(2);
}

/** A SUBMENUS row: kind tag plus its heterogeneous binding fields. */
export type SubmenuRow = [string, ...(string | number | null | ((v: number) => string))[]];

export const SUBMENUS: { [spec: string]: [string, SubmenuRow[]] } = {
  // 2a Sound
  sound: ["Sound", [
    ["toggle", "SOUND", "~Sound:"],
    ["enum", "FLY_SOUND", "~Flight Sounds:"],
    // Graphics Mode is NOT in Sound -- the real v1.50 Hardware screenshot puts
    // it FIRST in the Hardware menu (moved there; catalog 04's Sound grouping
    // was flagged [inferred] and is wrong).
  ]],
  // 2b Hardware.  Order from the REAL v1.50 Hardware screenshot (memory
  // scorch-real-screenshots): Graphics Mode is in HARDWARE (first), NOT Sound;
  // then Bios Keyboard, Small Memory, Pointer, Mouse Rate, Firing Delay, Falling
  // Delay.  CORRECTION: FUN_4891_01e8 (prior-labeled the "Hardware numeric panel")
  // is actually the SYSTEM MENU -- its label far-ptrs resolve byte-for-byte to
  // Clear Screen / Mass Kill / Reassign Players / Reassign Teams / Sound / Save /
  // Restore / New / Quit Game.  So the old toggle+numeric-panel split was a
  // misattribution; the real Hardware menu is this single list.
  hardware: ["Hardware", [
    ["enum", "GRAPHICS_MODE", "~Graphics Mode:"],
    ["toggle", "BIOS_KEYBOARD", "~Bios Keyboard"],
    ["toggle", "LOWMEM", "~Small Memory"],
    ["enum_hw_pointer", "POINTER", "~Pointer:"],
    ["float", "MOUSE_RATE", "~Mouse Rate:", 0.5, 5.0, 0.5, _f2],
    ["int", "FIRE_DELAY", "~Firing Delay:", 0, 500],
    ["int", "FALLING_DELAY", "Falling ~Delay:", 0, 1000],
    // Documented (cfg/action-backed) options NOT in the Pointer=Mouse screenshot
    // view -- kept settable, appended (joystick fields are conditional in the
    // original).  REMOVED: the 4 cfg-LESS display reconstructions (Mouse Enabled,
    // Hardware Delay, Joystick Rate/Threshold; GAP 1, no scorch.cfg key, not in
    // the screenshot) as speculative.
    ["action", "calibrate", "~Calibrate Joystick"],
    ["toggle", "FAST_COMPUTERS", "~Fast Computers"],
  ]],
  // 2c Economics
  economics: ["Economics", [
    ["float", "INTEREST_RATE", "~Interest Rate:", 0.0, 0.30, 0.01, _f2],
    ["int", "INITIAL_CASH", "~Cash at Start:", 0, 1000000, 1000],
    ["toggle", "COMPUTERS_BUY", "Computers ~Buy"],
    ["toggle", "FREE_MARKET", "~Free Market"],
    ["enum", "SCORING", "~Scoring Mode:"],
  ]],
  // 2d Landscape (weather folded in)
  landscape: ["Landscape", [
    ["int", "LAND1", "~Bumpiness:", 0, 100],
    ["int", "LAND2", "S~lope:", 0, 100],
    ["toggle", "FLATLAND", "~Flatten Peaks"],
    ["toggle", "RANDOM_LAND", "~Random Land"],
    ["enum", "SKY", "~Sky:"],
    ["int", "MAX_WIND", "~Max. Wind:", 0, 500],
    ["toggle", "CHANGING_WIND", "~Changing Wind"],
    ["float", "MTN_PERCENT", "Percent Scanned Mountains:", 0.0, 100.0, 1.0, _f2],
  ]],
  // 2e Physics (+ wall enum)
  physics: ["Physics", [
    ["int", "AIR_VISCOSITY", "~Air Viscosity:", 0, 20],
    ["float", "GRAVITY", "~Gravity:", 0.05, 10.0, 0.05, _f2],
    ["int", "EDGES_EXTEND", "~Borders Extend:", 0, 10000],
    ["enum", "ELASTIC", "~Effect of Walls:"],
    ["int", "SUSPEND_DIRT", "~Suspend Dirt:", 0, 100],
  ]],
  // 2f Play Options
  play_options: ["Play Options", [
    ["enum", "PLAY_MODE", "~Mode:"],
    ["enum", "PLAY_ORDER", "Play ~Order:"],
    ["enum", "TEAM_MODE", "~Teams:"],
    ["toggle", "STATUS_BAR", "Status ~Bar"],
    // ~Icon Bar (strings_clean.txt:1351) sits directly after Status ~Bar in the
    // verbatim label block (:1350-1351); cfg ICON_BAR gates the top control bar.
    ["toggle", "ICON_BAR", "~Icon Bar"],
    ["enum", "TALKING_TANKS", "Ta~lking Tanks:"],
    ["int", "TALK_PROBABILITY", "Talk ~Probability:", 0, 100],
    // ~Attack File / ~Die File: taunt-comment filenames (cfg ATTACK_COMMENTS /
    // DIE_COMMENTS; catalog 04 s.4f L250-251, schema 03 L174-175, defaults
    // talk1.cfg/talk2.cfg).  Were MISSING from the port's Play Options.
    ["text", "ATTACK_COMMENTS", "~Attack File:"],
    ["text", "DIE_COMMENTS", "~Die File:"],
    ["toggle", "HOSTILE_ENVIRONMENT", "~Hostile Environment"],
    ["toggle", "FALLING_TANKS", "Tanks ~Fall"],
    ["toggle", "DAMAGE_TANKS_ON_IMPACT", "~Impact Damage"],
    ["toggle", "TUNNELLING", "~Tunneling"],
    ["toggle", "TRACE", "Trace ~Paths"],
    ["enum", "EXPLOSION_SCALE", "~Scale:"],
    ["toggle", "EXTRA_DIRT", "~Extra Dirt"],
    ["toggle", "USELESS_ITEMS", "~Useless Items"],
  ]],
  // 2g Weapons: Arms Level + Bomb Icon + per-weapon enable toggles (built
  // specially in OptionsScreen so the 48-item list scrolls).
  weapons: ["Weapons", [
    ["int", "ARMS", "~Arms Level:", 0, 4],
    ["enum", "BOMB_ICON", "~Bomb Icon:"],
    ["weapon_list", null, null],
  ]],
};

// Verbatim AI computer-type radio labels.  Byte-verified from the data image
// (FUN_3014_1bc9 copies these 8 far-ptrs into the tag-8 radio array DAT_5f38_4fe6;
// pointers DAT_5f38_209c[0..7] resolve to 4f38:2713.. in SCORCH_FP.EXE,
// strings_clean.txt:1230-1237).  Group order; index i -> AI class i+1 (human = 0).
export const AI_TYPE_LABELS: string[] = [
  "~Moron", "S~hooter", "~Poolshark", "~Tosser",
  "~Chooser", "~Spoiler", "C~yborg", "~Unknown",
];

// Tank-appearance strip.  RE (FUN_3014_14cb.c:78 builds a tag-6 slider whose tick
// count is DAT_5f38_67ae; that global reads 7 in the data image) shows the real
// per-player setup offers SEVEN appearance positions, all selectable for both
// human and computer players (the v1.50 screenshot confirms 7 black cells with the
// player-color tank).  The icon strip therefore exposes indices 0..6.
//
// TANK_ICONS / TANK_ICON_CPU_ONLY are kept for game.py, which imports
// tank_icon_mobile (game.py:138 -> Tank.mobile) and TANK_ICON_CPU_ONLY
// (game.py:588, the registered-only triple-turret triple-fan).  The triple-turret
// slot (7) is a registered-only feature NOT offered in the shareware setup strip,
// so it is defined here but is not one of the 7 selectable appearance cells.
//
// (Provenance: see screens.py:248-296 for the full RE note on the per-design
// vector-stroke models and the mobility-guess column.)  Only "humans cannot use
// idx6" is byte-proven (FUN_3014_00d2.c:82-83); idx6 is CPU+registered-only.
//
// TANK_ICONS keeps (has_wheels, computer_only) for game.py.
export const TANK_ICONS: [boolean, boolean][] = [
  // (has_wheels, computer_only).  has_wheels = MOBILITY guess (see note above),
  // NOT the recovered visual tread set; sprites.tank_design_wheels is the visual.
  [true, false],   // 0 domed gun / howitzer
  [true, false],   // 1 flat-topped tank
  [false, false],  // 2 wheeled artillery (mobility guess: fixed)
  [true, false],   // 3 wheeled tank (DEFAULT appearance seed; mobile)
  [true, false],   // 4 wheeled tank, wide turret
  [false, false],  // 5 compact tank (mobility guess: fixed)
  [true, true],    // 6 single stepped-turret tank (Computer-only; NOT 3 barrels)
];
export const NUM_TANK_ICONS = TANK_ICONS.length;
// The triple-turret design index (game.py:632 keys the 3-shot CPU fan on this).
// RE: index 6 == DAT_5f38_67ae-1 (FUN_3014_14cb.c:70-72; fan FUN_2a4a_02f2.c:91).
export const TANK_ICON_CPU_ONLY = NUM_TANK_ICONS - 1;
// Appearance cells the Tank-Init strip actually shows (RE: DAT_5f38_67ae == 7).
export const NUM_APPEARANCE_ICONS = 7;

/** True if the design has wheels/treads (can buy/use fuel and move).
 *  Fixed emplacements (no wheels) are immobile (SCORCH.DOC:L336-340).  Defers to
 *  the recovered per-design wheel flag (sprites.tank_design_wheels). */
export function tank_icon_mobile(icon_index: number): boolean {
  if (0 <= icon_index && icon_index < NUM_TANK_ICONS) {
    return TANK_ICONS[icon_index][0];
  }
  return true;
}

// NOTE: the shop HAS two category tabs (Weapons / Miscellaneous), NOT one flat
// list -- FUN_1dbc_18f2 toggles DAT_5f38_cab4 and FUN_1dbc_0704 then builds the
// list from one of two disjoint index ranges (Weapons = the leading run of items
// carrying a projectile handler, [0,e4f0); Miscellaneous = the handler-less equip
// items, [e4f0,1bb6)).  ShopScreen restores them via self.category + _cat_tabs,
// filtering ITEMS by `behavior != "equip"` (the port's handler/handler-less split).

// ===========================================================================
// 1. MAIN MENU
// ===========================================================================
export class MainMenuScreen extends Screen {
  /** SCREENS.md s1 + the v1.5 title panel (menu builder FUN_4755_0283).
   *
   * LEFT: the verbatim button stack (Start / Players / Rounds / the seven
   * submenu items / Save Changes).  RIGHT: the title art panel
   * (render.makeTitleBackdrop: gradient sky + digitized granite mountain) with the
   * title text composited over it and "Version 1.50" / copyright along the bottom.
   * (See screens.py:319-336 for the full builder + scaling note.)
   */
  // Title text colors (RECONSTRUCTED to match the supplied v1.5 screenshot; the
  // original's 3D title is FUN_5589_0c6d, runtime-generated DAC bevel shades, not
  // statically recoverable as RGB -- so these come from the screenshot).
  static readonly C_TITLE_FACE: [number, number, number] = [255, 255, 255];
  static readonly C_TITLE_SHADOW: [number, number, number] = [24, 16, 64];
  static readonly C_SUBTITLE: [number, number, number] = [255, 120, 190];
  static readonly C_SHAREWARE: [number, number, number] = [110, 230, 235];
  static readonly C_VERSION: [number, number, number] = [235, 235, 245];

  override opaque = true;

  cfg: CfgLike;
  w: number;
  h: number;
  panel: Panel;
  art_rect: pygame.Rect;
  _backdrop: pygame.Surface;

  constructor(cfg: CfgLike, w: number, h: number) {
    super();
    this.cfg = cfg;
    this.w = w;
    this.h = h;
    // LEFT button column (verbatim label set).  The panel title bar reads
    // "Main Menu" (04_menus_ui.md:43); the big title now lives on the right panel.
    const panel_w = 340;
    this.panel = new Panel(40, 40, panel_w, h - 110, "Main Menu", true);
    // RIGHT title-art panel rect (gradient + mountain go here).
    const art_x = 40 + panel_w + 24;
    this.art_rect = new pygame.Rect(art_x, 40, w - art_x - 24, h - 110);
    // Build the backdrop once (gradient + decoded mountain); cache it.
    this._backdrop = render.makeTitleBackdrop(this.art_rect.w, this.art_rect.h);
    this._build();
  }

  _build(): void {
    const p = this.panel;
    const x = p.rect.x + 18;
    let y = p.rect.y + 32;
    const dy = 26;
    // 1. ~Start (tag 0) -> begin game
    p.add(new Button(x, y, "~Start", "start_game", null, true));
    y += dy;
    // 2. ~Players: inline spinner (range 2-10, cfg MAXPLAYERS)
    _num_spinner(p, x, y, this.cfg, "MAXPLAYERS", "~Players:", 2, 10, 1, String, 250);
    y += dy;
    // 3. ~Rounds: inline spinner (range 1-1000, cfg MAXROUNDS)
    _num_spinner(p, x, y, this.cfg, "MAXROUNDS", "~Rounds:", 1, 1000, 1, String, 250);
    y += dy;
    // 4-10. submenu items (push:<name>); labels verbatim with the `...`
    const submenuItems: [string, string][] = [
      ["S~ound...", "sound"], ["~Hardware...", "hardware"],
      ["~Economics...", "economics"], ["~Landscape...", "landscape"],
      ["Ph~ysics...", "physics"], ["Play Op~tions...", "play_options"],
      ["~Weapons...", "weapons"],
    ];
    for (const [label, name] of submenuItems) {
      p.add(new Label(x, y, label, W.C_TEXT, 15, false, "push:" + name));
      y += dy;
    }
    // 11. ~About: open the shareware registration / about panel (STRING_AUDIT
    // _SYSTEM #1).  Accel 'a' (not 'r'): '~Rounds:' already owns 'r' here.
    p.add(new Button(x, y, "~About", "register"));
    y += dy;
    // 12. Save ~Changes
    p.add(new Button(x, y, "Save ~Changes", "save_changes"));
    y += dy;
  }

  override handle(e: ScreenEvent): ScreenAction {
    return this.panel.handle(e);
  }

  _fit_font(text: string, size: number, max_w: number, bold = true): pygame.Font {
    // Largest bold font <= `size` whose `text` fits in `max_w` px.
    while (size > 12) {
      const fnt = W.font(size, bold);
      if (fnt.size(text)[0] <= max_w) {
        return fnt;
      }
      size -= 2;
    }
    return W.font(size, bold);
  }

  _draw_title_3d(surf: pygame.Surface, text: string, cx: number, top_y: number, size: number, max_w: number): number {
    // Big blocky title with a 5-pass diagonal drop shadow, fit to max_w.
    // Mirrors FUN_5589_0c6d (see screens.py:406-413).
    const fnt = this._fit_font(text, size, max_w - 4);
    const face = fnt.render(text, true, MainMenuScreen.C_TITLE_FACE);
    const tx = cx - Math.trunc(face.get_width() / 2);
    for (const d of [4, 3, 2, 1]) {
      const sh = fnt.render(text, true, MainMenuScreen.C_TITLE_SHADOW);
      surf.blit(sh, [tx + d, top_y + d]);
    }
    surf.blit(face, [tx, top_y]);
    return face.get_height();
  }

  override draw(surf: pygame.Surface): void {
    surf.fill(W.C_BG);
    // Right title-art panel: gradient sky + digitized granite mountain.
    const ar = this.art_rect;
    surf.blit(this._backdrop, [ar.x, ar.y]);
    pygame.draw.rect(surf, W.C_PANEL_HI, ar, 1);

    // Title text stacked over the upper part of the art panel.  Fonts are fit to
    // the panel width so the layout holds at any resolution.
    const cx = ar.centerx;
    let y = ar.y + 24;
    const title_size = Math.max(28, Math.min(64, Math.trunc(ar.w / 9)));
    const th = this._draw_title_3d(surf, "Scorched Earth", cx, y, title_size, ar.w - 16);
    y += th + 8;
    const sub_fnt = this._fit_font("The Mother of All Games", Math.max(15, Math.trunc(title_size / 2)), ar.w - 16);
    const sub = sub_fnt.render("The Mother of All Games", true, MainMenuScreen.C_SUBTITLE);
    surf.blit(sub, [cx - Math.trunc(sub.get_width() / 2), y]);
    y += sub.get_height() + 4;
    const shw_fnt = this._fit_font("** Shareware Version **", Math.max(14, Math.trunc(title_size / 2) - 2), ar.w - 16);
    const shw = shw_fnt.render("** Shareware Version **", true, MainMenuScreen.C_SHAREWARE);
    surf.blit(shw, [cx - Math.trunc(shw.get_width() / 2), y]);

    // Bottom strip: "Version 1.50" + copyright (verbatim, 04_menus_ui.md).
    const bf = W.font(16, true);
    const ver = bf.render("Version 1.50", true, MainMenuScreen.C_VERSION);
    const cpy = bf.render("Copyright (c) 1991-1995 Wendell Hicken", true, MainMenuScreen.C_VERSION);
    const gap = 24;
    if (ver.get_width() + cpy.get_width() + gap <= this.w - 2 * ar.x) {
      const by = this.h - 30;
      surf.blit(ver, [ar.x, by]);
      surf.blit(cpy, [this.w - ar.x - cpy.get_width(), by]);
    } else {
      surf.blit(cpy, [Math.trunc(this.w / 2) - Math.trunc(cpy.get_width() / 2), this.h - 44]);
      surf.blit(ver, [Math.trunc(this.w / 2) - Math.trunc(ver.get_width() / 2), this.h - 24]);
    }

    // LEFT button column on top of the cleared background.
    this.panel.draw(surf, false);
    draw_cursor(surf);
  }
}

// ===========================================================================
// 1b. REGISTRATION / ABOUT  (the shareware registration panel)
// ===========================================================================
// STRING_AUDIT_SYSTEM #1 / s3.2: the 14 content lines below are RE-PINNED
// byte-for-byte from the primary image SCORCH_FP.EXE at DATA region
// file_off = 0x55d80 + seg_off 0x0bfe..0x10ad (strings_clean.txt L1086-1100).
// Verbatim; do not paraphrase.
export const REGISTRATION_LINES: string[] = [
  "Thank you for playing the shareware version of Scorched Earth.  If you enjoy",
  "this game (and don't we all?), you are encouraged to register it.",
  "",
  "Basic registration costs $20, and includes a disk with the registered",
  "version - including 25 new mountains and enabling the triple-turreted tank.",
  "Deluxe registration costs $30, and includes the above, plus a printed,",
  "illustrated copy of the manual.",
  "",
  "For more information, consult the files README and ORDER.FRM",
  "Scorch HQ can be reached at:",
  "",
  "     Wendell Hicken                Internet  : whicken@itis.com",
  "     P.O. Box 1215                 Ftp Site  : tower.itis.com/pub/scorch",
  "     Whittier, CA 90609-1215       Web Site  : http://tower.itis.com/scorch",
];

export class RegistrationScreen extends Screen {
  /** The shareware registration / about panel (STRING_AUDIT_SYSTEM #1, s3.2).
   * A static, scroll-free info panel: the 14 verbatim REGISTRATION_LINES in a
   * monospace font, framed by a Panel titled "Register Scorched Earth", with a
   * single ~OK button that returns 'pop'. */
  override opaque = true;

  w: number;
  h: number;
  _font: pygame.Font;
  _line_h: number;
  _panel_rect: pygame.Rect;
  _text_x: number;
  _text_y: number;
  panel: Panel;

  constructor(_cfg_or_state: unknown, w: number, h: number) {
    super();
    // Accepts either the Config (from the Main Menu) or the GameState (from the
    // in-round System Menu); only w/h are used.
    this.w = w;
    this.h = h;
    // Size the panel to the widest line in a monospace font + margins.
    this._font = W.font(15);
    let text_w = 0;
    for (const s of REGISTRATION_LINES) {
      const sw = this._font.size(s)[0];
      if (sw > text_w) {
        text_w = sw;
      }
    }
    this._line_h = this._font.get_height() + 2;
    const pad = 24;
    const pw = Math.min(w - 40, text_w + 2 * pad);
    const ph = Math.min(h - 40, 28 + REGISTRATION_LINES.length * this._line_h + 56);
    const px = Math.trunc((w - pw) / 2);
    const py = Math.trunc((h - ph) / 2);
    this._panel_rect = new pygame.Rect(px, py, pw, ph);
    this._text_x = px + pad;
    this._text_y = py + 30;
    this.panel = new Panel(px, py, pw, ph, "Register Scorched Earth", false, "pop");
    // ~OK closes the panel (returns 'pop').
    this.panel.add(new Button(px + Math.trunc(pw / 2) - 30, py + ph - 30, "~OK", "pop", null, true));
  }

  override handle(e: ScreenEvent): ScreenAction {
    return this.panel.handle(e);
  }

  override update(_dt: number): ScreenAction {
    return null;
  }

  override draw(surf: pygame.Surface): void {
    surf.fill(W.C_BG);
    this.panel.draw(surf, false);
    let y = this._text_y;
    for (const line of REGISTRATION_LINES) {
      if (line) {
        surf.blit(this._font.render(line, true, W.C_TEXT), [this._text_x, y]);
      }
      y += this._line_h;
    }
    draw_cursor(surf);
  }
}

// ===========================================================================
// 2. OPTION SUBMENUS
// ===========================================================================
export class OptionsScreen extends Screen {
  /** One screen per submenu (Sound/Hardware/Economics/Landscape/Physics/
   * Play Options/Weapons).  Built from the SUBMENUS field table; each widget is
   * bound to its Config key.  Esc/Done -> 'pop'.  (SCREENS.md s2a-s2g.)
   *
   * `spec` is the SUBMENUS key.  ACCELERATOR COLLISIONS are documented in
   * screens.py:556-575 (the verbatim labels collide when the original's multi-
   * dialog submenus are flattened; ~Done is reached by Enter/click regardless). */
  override opaque = false;

  cfg: CfgLike;
  w: number;
  h: number;
  spec: string;
  _hw_attrs: { [k: string]: number | boolean };
  scroll: number;
  weapon_list: null;
  panel: Panel;
  // weapon-list state (only the Weapons submenu)
  _wl_x = 0;
  _wl_y = 0;
  _wl_h = 8;
  weapon_items: number[] = [];
  _wl_toggles: Toggle[] = [];

  constructor(cfg: CfgLike, w: number, h: number, spec: string) {
    super();
    this.cfg = cfg;
    this.w = w;
    this.h = h;
    this.spec = spec;
    // Per-screen backing for the cfg-less Hardware fields (GAP 1): plain instance
    // attributes, NOT scorch.cfg keys, so the spinners render but persist nothing.
    this._hw_attrs = {
      _hw_mouse_enabled: true,
      _hw_hardware_delay: 0,
      _hw_joystick_rate: 0,
      _hw_joystick_threshold: 0,
    };
    const [title, fields] = SUBMENUS[spec];
    // tall enough for the weapon list submenu; scroll offset for that case
    this.scroll = 0;
    this.weapon_list = null;
    this.panel = new Panel(Math.trunc(w / 2) - 200, 24, 400, h - 80, title, false, "pop");
    this._build(fields);
  }

  _build(fields: SubmenuRow[]): void {
    const p = this.panel;
    const x = p.rect.x + 16;
    let y = p.rect.y + 30;
    for (const row of fields) {
      const kind = row[0];
      if (kind === "toggle") {
        _toggle(p, x, y, this.cfg, row[1] as string, row[2] as string);
        y += 24;
      } else if (kind === "enum") {
        _enum_selector(p, x, y, this.cfg, row[1] as string, row[2] as string);
        y += 24;
      } else if (kind === "enum_hw_pointer") {
        // Pointer selector: None / Mouse / Joystick (cfg POINTER string)
        const tokens = ["None", "Mouse", "Joystick"];
        const gp = (): number => {
          const cur = String(this.cfg.POINTER);
          const j = tokens.indexOf(cur);
          return j >= 0 ? j : 1;
        };
        const sp = (i: number): void => {
          this.cfg.POINTER = tokens[((i % tokens.length) + tokens.length) % tokens.length];
        };
        p.add(new Selector(x, y, row[2] as string, tokens, gp, sp, 300));
        y += 24;
      } else if (kind === "int") {
        const lo = row[3] as number;
        const hi = row[4] as number;
        const step = row.length > 5 ? (row[5] as number) : 1;
        _num_spinner(p, x, y, this.cfg, row[1] as string, row[2] as string, lo, hi, step);
        y += 24;
      } else if (kind === "float") {
        const lo = row[3] as number;
        const hi = row[4] as number;
        const step = row[5] as number;
        const fmt = row[6] as (v: number) => string;
        _num_spinner(p, x, y, this.cfg, row[1] as string, row[2] as string, lo, hi, step, fmt);
        y += 24;
      } else if (kind === "text") {
        // filename/string cfg field (Attack File / Die File): editable TextField.
        const key = row[1] as string;
        p.add(new TextField(
          x, y, row[2] as string,
          () => String(this.cfg[key]),
          (v: string) => {
            this.cfg[key] = v;
          },
          12, 300, 110,
        ));
        y += 24;
      } else if (kind === "display_int") {
        // GAP 1: cfg-less Hardware spinner backed by self._hw_attrs[attr].
        const attr = row[1] as string;
        const lo = row[3] as number;
        const hi = row[4] as number;
        p.add(new Spinner(
          x, y, row[2] as string,
          () => this._hw_attrs[attr] as number,
          (v: number) => {
            this._hw_attrs[attr] = v;
          },
          lo, hi, 1, String, 300,
        ));
        y += 24;
      } else if (kind === "display_toggle") {
        // GAP 1: cfg-less Hardware toggle (~Mouse Enabled) backed by _hw_attrs.
        const attr = row[1] as string;
        p.add(new Toggle(
          x, y, row[2] as string,
          () => Boolean(this._hw_attrs[attr]),
          (v: boolean) => {
            this._hw_attrs[attr] = Boolean(v);
          },
          300,
        ));
        y += 24;
      } else if (kind === "action") {
        p.add(new Button(x, y, row[2] as string, row[1] as string));
        y += 26;
      } else if (kind === "weapon_list") {
        this._build_weapon_list(x, y);
        y += 24 * 8 + 6; // reserve the scroll viewport height
      }
    }
    // ~Done at the bottom (default button; Enter/Esc both leave)
    p.add(new Button(p.rect.centerx - 30, p.rect.bottom - 30, "~Done", "pop", null, true));
  }

  _build_weapon_list(x: number, y: number): void {
    // SCREENS.md s2g: one On/Off toggle per weapon/defense, bound to a per-item
    // enabled flag.  A disabled item is filtered from the shop by ShopScreen.
    this._wl_x = x;
    this._wl_y = y;
    this._wl_h = 8; // 8 visible rows
    this.weapon_items = [];
    for (let i = 0; i < weapons.NUM_ITEMS; i++) {
      this.weapon_items.push(i);
    }
    // every Item already carries `enabled` (weapons.ts default true); no-op here.
    this._wl_toggles = []; // rebuilt per draw frame for the scroll window
    this._refresh_weapon_toggles();
  }

  _refresh_weapon_toggles(): void {
    // remove old weapon toggles from the panel, rebuild for current scroll
    this.panel.widgets = this.panel.widgets.filter((w) => !this._wl_toggles.includes(w as Toggle));
    this._wl_toggles = [];
    const top = this.scroll;
    for (let r = 0; r < this._wl_h; r++) {
      const idx = top + r;
      if (idx >= this.weapon_items.length) {
        break;
      }
      const slot = this.weapon_items[idx];
      const it = weapons.ITEMS[slot];
      const yy = this._wl_y + r * 24;
      const get = (): boolean => weapons.ITEMS[slot].enabled;
      const set_ = (v: boolean): void => {
        weapons.ITEMS[slot].enabled = Boolean(v);
      };
      const t = new Toggle(this._wl_x, yy, it.name, get, set_, 260);
      this._wl_toggles.push(this.panel.add(t));
    }
  }

  override handle(e: ScreenEvent): ScreenAction {
    // weapon-list scroll wheel (only the Weapons submenu has a list)
    if (this.spec === "weapons" && e.type === pygame.MOUSEBUTTONDOWN && (e.button === 4 || e.button === 5)) {
      const n = this.weapon_items.length;
      if (e.button === 4) {
        this.scroll = Math.max(0, this.scroll - 1);
      } else {
        this.scroll = Math.min(Math.max(0, n - this._wl_h), this.scroll + 1);
      }
      this._refresh_weapon_toggles();
      return null;
    }
    return this.panel.handle(e);
  }

  override draw(surf: pygame.Surface): void {
    this.panel.draw(surf, true);
    if (this.spec === "weapons") {
      // scroll hint, below the 8-row viewport (+6 clears the 8th row)
      const r = this.panel.rect;
      _draw_accel_text(surf, "(scroll for more weapons)", r.x + 16, this._wl_y + this._wl_h * 24 + 6, W.C_TEXT, W.font(12));
    }
    draw_cursor(surf);
  }
}

export class CalibrateScreen extends Screen {
  /** Hardware -> ~Calibrate Joystick dialog (REMAINING_GAPS.md GAP 1).  Verbatim
   * text (all binary-read; file offsets in REMAINING_GAPS.md).  The port has no
   * real joystick path, so this is a display+cancel stub: ANY key (per the verbatim
   * cancel line) or a click on ~Cancel / outside dismisses it with 'pop'. */
  override opaque = false;

  cfg: CfgLike;
  w: number;
  h: number;
  panel: Panel;

  constructor(cfg: CfgLike, w: number, h: number) {
    super();
    this.cfg = cfg;
    this.w = w;
    this.h = h;
    this.panel = new Panel(Math.trunc(w / 2) - 160, Math.trunc(h / 2) - 70, 320, 140, "Calibrate Joystick", false, "pop");
    const x = this.panel.rect.x + 20;
    let y = this.panel.rect.y + 36;
    this.panel.add(new Label(x, y, "Center joystick and press"));
    y += 22;
    this.panel.add(new Label(x, y, "the fire button."));
    y += 26;
    this.panel.add(new Label(x, y, "(Press any key to cancel.)"));
    y += 28;
    this.panel.add(new Button(this.panel.rect.centerx - 32, this.panel.rect.bottom - 28, "~Cancel", "pop", null, true));
  }

  override handle(e: ScreenEvent): ScreenAction {
    // "(Press any key to cancel.)": any KEYDOWN dismisses, not only Esc.
    if (e.type === pygame.KEYDOWN) {
      return "pop";
    }
    return this.panel.handle(e);
  }

  override update(_dt: number): ScreenAction {
    return null;
  }

  override draw(surf: pygame.Surface): void {
    this.panel.draw(surf, true);
    draw_cursor(surf);
  }
}

// ===========================================================================
// 3. TANK INITIALIZATION PANEL
// ===========================================================================
export class TankInitScreen extends Screen {
  /** Per-player setup ("Player N (of M)").  Built from the v1.50 screenshots
   * cross-checked against the binary's real builder (FUN_3014_14cb, driver
   * FUN_3014_0cee; see screens.py:786-822 for the full RE).
   *
   * Modal/no-cancel: Esc and click-outside do NOT dismiss; exit only via ~Done.
   * On ~Done returns 'tank_done'; the driver reads `.result` as the 4-tuple
   * (name, ai_class, team, tank_icon). */
  override opaque = true;

  // Simultaneous-mode key-bind labels, in the manual's order (L262-268).
  static readonly SIM_KEY_LABELS: string[] = [
    "CW turret", "CCW turret", "Power up", "Power down", "Fire", "Change weapon",
  ];

  // Person/Computer selector cells: 0 = Person (human), 1 = Computer.
  static readonly _SEL_PERSON = 0;
  static readonly _SEL_COMPUTER = 1;

  cfg: CfgLike;
  w: number;
  h: number;
  player_index: number;
  is_computer: boolean;
  name: string;
  ai_index: number;
  icon_index: number;
  sim_keys: string[];
  result: [string, number, number, number] | null;
  _num_players: number;
  _sim: boolean;
  panel: Panel;
  _player_color: [number, number, number];
  _RAMP: number;
  _BAND_W: number;
  _shades: [number, number, number][];
  _cycle_phase: number;
  _cycle_rate: number;
  // widgets bound in _build
  name_label!: Label;
  name_field!: TextField;
  radio!: RadioGroup;
  icons!: IconStrip;
  icon_slider!: Slider;
  type_icons!: IconStrip;
  type_slider!: Slider;
  sim_frames: Frame[] = [];

  constructor(cfg: CfgLike, w: number, h: number, player_index: number) {
    super();
    this.cfg = cfg;
    this.w = w;
    this.h = h;
    this.player_index = player_index;
    // original defaults EVERY player to Human (Person) (FUN_3a16_0320.c:25).
    this.is_computer = false;
    this.name = `Player ${player_index + 1}`;
    // switched to Computer -> default type Tosser=class 4 (radio idx 3).
    this.ai_index = 3;
    // default appearance index 3 (shared panel seed 5f38:4fe0=3); 0..6 selectable.
    this.icon_index = 3;
    this.sim_keys = ["", "", "", "", "", ""]; // 6 keys, only in Simultaneous
    this.result = null;
    // total player count drives the "(of M)" title (cfg.MAXPLAYERS).
    this._num_players = this.cfg.MAXPLAYERS;
    this._sim = (this.cfg.play_mode as number) === C.PLAYMODE_SIMULTANEOUS;
    const ph = 360 + (this._sim ? 96 : 0);
    // Title = "Player N (of M)" (RE FUN_3014_0cee.c:59 template "(of %d)").
    this.panel = new Panel(
      Math.trunc(w / 2) - 190, 24, 380, ph,
      `Player ${player_index + 1} (of ${this._num_players})`,
      true,
    );
    // Background = vertical shade bands of the player color, palette-cycled
    // (SCORCH.DOC:L228-229; FUN_3014_00d2.c:36-44 + FUN_4d9b_003b rotate; the full
    // RE of the fill + cycle is in screens.py:862-897).
    this._player_color = palette.TEAM_RGB[player_index % palette.TEAM_RGB.length] as [number, number, number];
    this._RAMP = 40; // 0xb4..0xdb inclusive = 40 shades
    // SCALE the native 9px stripe to the port width so the 40-shade ramp spans the
    // screen exactly once (~26px at 1024), per screens.py:888-894.
    this._BAND_W = Math.max(2, Math.round(w / this._RAMP));
    this._shades = TankInitScreen._build_shades(this._player_color, this._RAMP);
    this._cycle_phase = 0.0; // rotating shade offset (the palette cycle)
    this._cycle_rate = 55.0; // shades/sec (RECONSTRUCTED ~ retrace rate)
    this._build();
  }

  static _build_shades(color: [number, number, number], n: number): [number, number, number][] {
    // The n-step shade ramp through `color` (FUN_3014_00d2.c:36-44 index ramp
    // mapped onto the player color, one shade per stripe; stripe k shows shade k).
    const [r, g, b] = color;
    const out: [number, number, number][] = [];
    for (let k = 0; k < n; k++) {
      const f = 0.3 + 0.75 * (k / Math.max(1, n - 1));
      out.push([
        Math.min(255, Math.trunc(r * f)),
        Math.min(255, Math.trunc(g * f)),
        Math.min(255, Math.trunc(b * f)),
      ]);
    }
    return out;
  }

  _draw_shade_field(surf: pygame.Surface): void {
    // Paint the vertical shade stripes with the palette cycle applied.  Stripes
    // are FIXED in X; the shade INDEX is rotated by the running cycle phase so the
    // bright band flows through them.  Stripe k shows shade (k + phase) % 40.
    const bw = this._BAND_W;
    const n = this._shades.length;
    const ph = Math.trunc(this._cycle_phase);
    let x = 0;
    let k = 0;
    while (x < this.w) {
      surf.fill(this._shades[((k + ph) % n + n) % n], [x, 0, bw + 1, this.h]);
      x += bw;
      k += 1;
    }
  }

  _build(): void {
    const p = this.panel;
    const x = p.rect.x + 18;
    let y = p.rect.y + 30;
    // --- conditional top region (RE: two sub-panels selected by d09c) ---------
    // 1. Name text field (Person panel; tag-2 edit, charset+space, max 8).
    const get_name = (): string => this.name;
    const set_name = (v: string): void => {
      this.name = v;
    };
    this.name_label = p.add(new Label(x, y, "~Name:"));
    this.name_field = p.add(new TextField(x + 56, y - 2, "", get_name, set_name, 8, 240));
    // 2. 8-cell AI-type radio group in THREE columns (Computer panel; tag-8,
    //    FUN_3014_14cb.c:97-103).  Occupies the same vertical slot as Name.
    this.radio = p.add(new RadioGroup(
      x, y, AI_TYPE_LABELS,
      () => this.ai_index,
      (i: number) => {
        this.ai_index = i;
      },
      3, 116, 20,
    ));
    // radios are 3 rows tall (8 cells / 3 cols); reserve that height
    y += 3 * 20 + 14;
    // --- tank-appearance strip + its slider (RE: 7-tick tag-6 slider) ---------
    // NO text label: the real dialog builds tag-9 BLANK spacers here.
    this.icons = p.add(new IconStrip(
      x, y, Array.from({ length: NUM_APPEARANCE_ICONS }, (_unused, i) => i),
      () => this.icon_index,
      (i: number) => this._set_icon(i),
      40, (surf, box, i, c) => this._draw_tank_icon(surf, box, i, c),
    ));
    y += 40 + 2;
    // appearance slider (drives the same index as the strip; 0..6).
    this.icon_slider = p.add(new Slider(
      x, y, "", Array.from({ length: NUM_APPEARANCE_ICONS }, (_unused, i) => i),
      () => this.icon_index,
      (i: number) => this._set_icon(i), NUM_APPEARANCE_ICONS * 40,
    ));
    y += 30;
    // --- human/computer selector: 2 icon cells + short slider beneath ---------
    this.type_icons = p.add(new IconStrip(
      x, y, [TankInitScreen._SEL_PERSON, TankInitScreen._SEL_COMPUTER],
      () => (this.is_computer ? TankInitScreen._SEL_COMPUTER : TankInitScreen._SEL_PERSON),
      (i: number) => this._set_player_type(i),
      40, (surf, box, i, c) => this._draw_type_cell(surf, box, i, c),
    ));
    y += 40 + 2;
    this.type_slider = p.add(new Slider(
      x, y, "", [TankInitScreen._SEL_PERSON, TankInitScreen._SEL_COMPUTER],
      () => (this.is_computer ? TankInitScreen._SEL_COMPUTER : TankInitScreen._SEL_PERSON),
      (i: number) => this._set_player_type(i), 2 * 40,
      (v: number) => (v === TankInitScreen._SEL_COMPUTER ? "Computer" : "Person"),
    ));
    y += 30;
    // --- Simultaneous 6-key bind block (humans only): six capture Frames ---
    this.sim_frames = [];
    if (this._sim) {
      p.add(new Label(x, y, "Keys (Simultaneous):"));
      y += 18;
      const fw = 108;
      const fh = 26;
      for (let i = 0; i < TankInitScreen.SIM_KEY_LABELS.length; i++) {
        const lbl = TankInitScreen.SIM_KEY_LABELS[i];
        const fx = x + (i % 3) * (fw + 4);
        const fy = y + Math.trunc(i / 3) * (fh + 16);
        const getk = (): string => this.sim_keys[i] || "?";
        const setk = (v: unknown): void => {
          this._set_sim_key(i, v);
        };
        const fr = new Frame(fx, fy, fw, fh, lbl, true, getk, setk);
        this.sim_frames.push(p.add(fr));
      }
      y += 2 * (fh + 16);
    }
    // --- ~Done (default button; bottom-right) ---------------------------------
    p.add(new Button(p.rect.right - 86, p.rect.bottom - 30, "~Done", "tank_done", null, true));
    // Seed the enabled flags for the conditional top region so hit-testing is
    // correct on the first frame regardless of the host loop's draw/handle order.
    this.radio.enabled = this.is_computer;
    this.name_field.enabled = !this.is_computer;
    this.name_label.enabled = !this.is_computer;
  }

  _set_icon(i: number): void {
    // appearance index, clamped to the seven selectable cells.
    this.icon_index = Math.max(0, Math.min(NUM_APPEARANCE_ICONS - 1, Math.trunc(i)));
  }

  _set_player_type(i: number): void {
    // the 2-position selector: 0 = Person, 1 = Computer.
    this.is_computer = Math.trunc(i) === TankInitScreen._SEL_COMPUTER;
  }

  _set_sim_key(i: number, v: unknown): void {
    // each of the six keys MUST be unique (manual L264-266: a repeat beeps and is
    // rejected).  Reject a duplicate rather than overwrite.
    const vv = String(v).toUpperCase();
    if (vv && this.sim_keys.some((k, j) => j !== i && k === vv)) {
      return; // duplicate -> reject (the "beep")
    }
    this.sim_keys[i] = vv;
  }

  // Per-cell appearance: each of the 7 cells draws its OWN design (RE: per-cell
  // painter FUN_3014_0330.c:86-99).  The triple-turret cell (index 6) is
  // CPU+registered-only; it is drawn GRAYED when the current player is a human.
  _draw_tank_icon(surf: pygame.Surface, box: pygame.Rect, i: number, _c: unknown): void {
    const grayed = i === TANK_ICON_CPU_ONLY && !this.is_computer;
    if (_sprites !== null) {
      _sprites.draw_tank_icon_cell(surf, box, this._player_color, { design_index: i, grayed, scale: 2 });
    }
  }

  _draw_type_cell(surf: pygame.Surface, box: pygame.Rect, i: number, _c: unknown): void {
    // Person -> stick-figure glyph; Computer -> a tank glyph (design 0).
    if (i === TankInitScreen._SEL_COMPUTER) {
      if (_sprites !== null) {
        _sprites.draw_tank_icon_cell(surf, box, this._player_color, { design_index: 0, scale: 2 });
      }
    } else {
      TankInitScreen._draw_person_glyph(surf, box);
    }
  }

  static _draw_person_glyph(surf: pygame.Surface, box: pygame.Rect): void {
    // A simple stick figure centered in `box` (the Person selector cell).
    const col: [number, number, number] = [235, 235, 235];
    const cx = box.centerx;
    const cy = box.centery;
    const top = box.y + 8;
    // head
    pygame.draw.circle(surf, col, [cx, top + 3], 4, 1);
    // body
    pygame.draw.line(surf, col, [cx, top + 7], [cx, cy + 6], 2);
    // arms
    pygame.draw.line(surf, col, [cx - 7, cy - 2], [cx + 7, cy - 2], 2);
    // legs
    pygame.draw.line(surf, col, [cx, cy + 6], [cx - 6, box.bottom - 4], 2);
    pygame.draw.line(surf, col, [cx, cy + 6], [cx + 6, box.bottom - 4], 2);
  }

  _team_for(): number {
    // FUN_4a4c_0152.c:12 pre-fills team_id = player_index (each on their own team)
    // when TEAM_MODE != NONE; 0 (no team) otherwise.
    if ((this.cfg.team_mode as number) === C.TEAM_NONE) {
      return 0;
    }
    return this.player_index;
  }

  override handle(e: ScreenEvent): ScreenAction {
    const act = this.panel.handle(e);
    if (act === "tank_done") {
      const ai_class = this.is_computer ? this.ai_index + 1 : C.AI_HUMAN;
      const nm = this.name.trim() || `Player ${this.player_index + 1}`;
      this.result = [nm, ai_class, this._team_for(), this.icon_index];
      return "tank_done";
    }
    return act;
  }

  _cover(surf: pygame.Surface, rect: pygame.Rect, pad = 3): void {
    // Opaquely paint the panel color over the INACTIVE top-region widget so it is
    // fully hidden (the screenshots show Name XOR radios, never both).
    const r = rect.inflate(pad * 2, pad * 2);
    surf.fill(W.C_PANEL, r);
  }

  override update(dt: number): ScreenAction {
    // Advance the background palette cycle (FUN_4d9b_003b retrace rotate).
    this._cycle_phase = (((this._cycle_phase + this._cycle_rate * dt) % this._RAMP) + this._RAMP) % this._RAMP;
    return null;
  }

  override draw(surf: pygame.Surface): void {
    // Exactly one top-region widget is active per is_computer.
    this.name_label.enabled = !this.is_computer;
    this.name_field.enabled = !this.is_computer;
    this.radio.enabled = this.is_computer;
    for (const fr of this.sim_frames) {
      fr.enabled = !this.is_computer;
    }
    // Background: the player-color vertical shade field, palette-cycled.
    this._draw_shade_field(surf);
    this.panel.draw(surf, false);
    // Name field and AI radios share the same vertical slot: cover the INACTIVE
    // one with the panel color, then re-draw the ACTIVE one on top.
    if (this.is_computer) {
      this._cover(surf, _rect_union(this.name_field.rect, this.name_label.rect));
      this.radio.draw(surf);
    } else {
      this._cover(surf, this.radio.rect);
      this.name_label.draw(surf);
      this.name_field.draw(surf);
    }
    draw_cursor(surf);
  }
}

// ===========================================================================
// 3b. CONFIGURE TEAMS
// ===========================================================================
export class ConfigureTeamsScreen extends Screen {
  /** SCREENS.md s10 / FUN_4a4c_0646.  One row per player (name + a `Team %d`
   * team-id spinner).  Spinner range is [0,9] (FUN_4a4c_018c.c:12-13).  Mutates
   * each Tank.team_id in place; returns 'pop' on ~Done / Esc / click-outside. */
  override opaque = false;

  static readonly TEAM_MIN = 0;
  static readonly TEAM_MAX = 9; // FUN_4a4c_018c.c:12-13 valid team range

  state: { tanks: TeamTank[] };
  w: number;
  h: number;
  tanks: TeamTank[];
  panel: Panel;

  constructor(state: { tanks: TeamTank[] }, w: number, h: number) {
    super();
    this.state = state;
    this.w = w;
    this.h = h;
    this.tanks = Array.from(state.tanks);
    const n = this.tanks.length;
    const ph = 56 + n * 26 + 40;
    this.panel = new Panel(
      Math.trunc(w / 2) - 170, Math.max(20, Math.trunc(h / 2) - Math.trunc(ph / 2)),
      340, ph, "Configure Teams", false, "pop",
    );
    this._build();
  }

  _build(): void {
    const p = this.panel;
    const x = p.rect.x + 18;
    let y = p.rect.y + 30;
    // one row per player: name (static) + `Team %d` spinner bound to team_id.
    for (const t of this.tanks) {
      p.add(new Label(x, y + 2, t.name, W.C_TEXT, 15, true));
      const getn = (): number => t.team_id;
      const setn = (v: number): void => {
        t.team_id = Math.trunc(v);
      };
      // "Team %d" label (verbatim format [V 1447])
      p.add(new Spinner(x + 150, y, "Team", getn, setn, ConfigureTeamsScreen.TEAM_MIN, ConfigureTeamsScreen.TEAM_MAX, 1, String, 160));
      y += 26;
    }
    // ~Done (default button); Enter/Esc/click-outside all leave -> 'pop'
    p.add(new Button(p.rect.centerx - 30, p.rect.bottom - 30, "~Done", "pop", null, true));
  }

  override handle(e: ScreenEvent): ScreenAction {
    return this.panel.handle(e);
  }

  override draw(surf: pygame.Surface): void {
    this.panel.draw(surf, true);
    draw_cursor(surf);
  }
}

interface TeamTank {
  name: string;
  team_id: number;
}

// ===========================================================================
// 4. SHOP / BUY SCREEN
// ===========================================================================
// The shop's 21-entry icon palette (6-bit DAC), byte-recovered from the shop
// runner FUN_1dbc_1aa8.c:26-46.  Uploaded to DAC band 0xAA..0xBE on shop open;
// shop icon pixel value v -> DAC index 0xAA+v.  (Defined here, not in palette.ts.)
export const SHOP_ICON_BASE = 0xaa; // DAC index 0xaa = staging[0]
export const SHOP_ICON_COUNT = 0x15; // 21 entries (eefc count)
export const SHOP_ICON_RGB6: [number, number, number][] = [
  [0x00, 0x00, 0x00], // 0x00
  [0x3f, 0x3f, 0x00], // 0x01  yellow
  [0x3f, 0x0a, 0x0a], // 0x02  red  (cycled: pulse, FUN_1dbc_0874:13)
  [0x3f, 0x3f, 0x3f], // 0x03  white
  [0x3f, 0x17, 0x3f], // 0x04  violet
  [0x28, 0x0f, 0x0f], // 0x05  dark red
  [0x26, 0x19, 0x11], // 0x06  brown
  [0x3f, 0x00, 0x00], // 0x07  pure red
  [0x3f, 0x20, 0x0a], // 0x08  orange  (cycled: flame)
  [0x3f, 0x00, 0x3f], // 0x09  magenta (cycled: flame)
  [0x3f, 0x0c, 0x0c], // 0x0a  light red (cycled: flame)
  [0x3f, 0x00, 0x1e], // 0x0b  pink/red (cycled: flame)
  [0x0a, 0x0a, 0x1e], // 0x0c  dark blue
  [0x0f, 0x0f, 0x0f], // 0x0d  dark grey
  [0x00, 0x00, 0x00], // 0x0e  black     (cycled: ember head)
  [0x0f, 0x0f, 0x0f], // 0x0f  grey ramp (cycled: ember)
  [0x1e, 0x1e, 0x1e], // 0x10  grey ramp (cycled: ember)
  [0x2d, 0x2d, 0x2d], // 0x11  grey ramp (cycled: ember)
  [0x3c, 0x3c, 0x3c], // 0x12  grey ramp (cycled: ember)
  [0x2d, 0x2d, 0x2d], // 0x13  grey
  [0x14, 0x14, 0x3c], // 0x14  blue
];
// Re-upload count for the per-frame cycle (FUN_1dbc_0874.c:71): 20 staging entries
// 0..0x13 -> DAC 0xAA..0xBD; idx 0x14 is set once on open and never re-cycled.
export const SHOP_CYCLE_COUNT = 0x14;

export function _build_shop_lut(): palette.LiveLUT {
  // A LiveLUT seeded from the at-rest palette, with the 21-entry shop icon band
  // installed at DAC 0xAA..0xBE AND mirrored into the low staging slots 0..0x14
  // (FUN_1dbc_0874 cycles those low slots, then re-uploads them to 0xAA..).
  const lut = new palette.LiveLUT();
  const rows = SHOP_ICON_RGB6.map((c) => _rgb8(c[0], c[1], c[2]));
  for (let i = 0; i < rows.length; i++) {
    lut.set_index(i, rows[i]); // staging slot i (cycler base)
    lut.set_index(SHOP_ICON_BASE + i, rows[i]); // DAC band the icons read
  }
  return lut;
}

export class ShopScreen extends Screen {
  /** The buy SHOP (rebuilt from the v1.50 screenshot + the binary's shop builder
   * FUN_1dbc_1536 / runner FUN_1dbc_1aa8; full RE in screens.py:1243-1311).
   *
   * Wiring preserved for main/game: `.tank`, `.sell_slot`; actions 'pop' (~Done),
   * 'push:sell' (Sell), 'shop_inventory' (~Inventory).  Buys via Economy.buy
   * (`_affordable` mirrors it).  TWO category tabs (Weapons / Miscellaneous).
   *
   * SHOP ICON PALETTE + PER-FRAME CYCLE (RE, byte-exact): FUN_1dbc_0874 is the
   * shop modal's idle/redraw hook; the per-tick math is palette.firewall_apply,
   * mirrored up to the 0xAA band the icons index.  (See screens.py:1278-1310.) */
  override opaque = true;

  state: ShopState;
  tank: EconomyTank & OwnTank;
  w: number;
  h: number;
  econ: Economy;
  sel_row: number;
  scroll: number;
  rows_visible: number;
  category: number;
  sell_slot: number | null;
  panel: Panel;
  items: number[] = [];
  shop_lut: palette.LiveLUT;
  _cycle_counter: number;
  _cycle_accum: number;
  // chrome geometry (filled by _build_chrome)
  _list_x!: number;
  _ctrl_x!: number;
  _list_right!: number;
  _hdr_y!: number;
  _grid_top!: number;
  _scroll_up!: Button;
  _scroll_dn_y!: number;
  _scroll_dn!: Button;
  _cat_tabs!: IconStrip;

  constructor(state: ShopState, tank: EconomyTank & OwnTank, w: number, h: number) {
    super();
    this.state = state;
    this.tank = tank;
    this.w = w;
    this.h = h;
    this.econ = state.economy;
    this.sel_row = 0; // selected item index (into self.items)
    this.scroll = 0; // top visible row
    this.rows_visible = 18; // default; recomputed from panel geometry below
    this.category = 0; // 0=Weapons, 1=Miscellaneous (RE: DAT_5f38_cab4)
    this.sell_slot = null;
    // Static title "Weapons" (RE: dialog title, not a tab).
    this.panel = new Panel(0, 0, w, h, "Weapons", false, "pop");
    this._build_chrome();
    // Derive rows_visible from the panel geometry (port grid pitch 18px) -- it
    // SCALES with screen height (native cap 0x2c=44, FUN_1dbc_1aa8.c:48-54).
    this.rows_visible = Math.max(1, Math.min(44, Math.trunc((this._scroll_dn_y - this._grid_top) / 18)));
    this._refresh_items();
    // Shop icon palette (DAC band 0xAA) + its per-frame DAC cycle (FUN_1dbc_0874).
    this.shop_lut = _build_shop_lut();
    this._cycle_counter = 0; // FUN_1dbc_0874 DAT_5f38_00ec analog
    this._cycle_accum = 0.0; // wall-clock accumulator (70 Hz pacing)
  }

  // -- item list (ONE flat ARMS-filtered list per category; RE FUN_1dbc_0704) --
  _refresh_items(): void {
    // The visible purchasable list for the ACTIVE category, in on-disk order.
    // Weapons = items carrying a projectile handler (behavior != "equip"),
    // Miscellaneous = the handler-less equip items.  Within the category an item
    // shows iff it is ARMS-gated in / enabled AND the tank can AFFORD its bundle
    // price now (cash >= price); unaffordable items are REMOVED, not greyed.
    // (Full RE in screens.py:1344-1357.)
    const want_weapon = this.category === 0;
    this.items = [];
    for (let slot = 0; slot < weapons.ITEMS.length; slot++) {
      const it = weapons.ITEMS[slot];
      if (
        this.econ.available[slot] &&
        it.enabled &&
        (it.behavior !== "equip") === want_weapon &&
        this.tank.cash >= this.econ.price[slot]
      ) {
        this.items.push(slot);
      }
    }
    this.sel_row = Math.min(this.sel_row, Math.max(0, this.items.length - 1));
    this.scroll = Math.max(0, Math.min(this._max_scroll(), this.scroll));
  }

  // -- chrome (right-side controls + scroll arrows, persistent) ---------------
  _build_chrome(): void {
    const p = this.panel;
    // Geometry: list on the left ~75%, controls column on the right.
    this._list_x = p.rect.x + 12;
    this._ctrl_x = p.rect.right - 150; // right controls column
    this._list_right = this._ctrl_x - 40; // room for the scroll arrows
    this._hdr_y = p.rect.y + 52;
    this._grid_top = this._hdr_y + 20;
    // up/down scroll arrows (the tag-7 scrollbar pair) routed via internal tuple
    // actions; PgUp/PgDn + wheel mirror them in handle().
    const sx = this._list_right + 8;
    this._scroll_up = p.add(new Button(sx, this._grid_top, "^", ["__scroll__", -1] as unknown as string, 24));
    this._scroll_dn_y = p.rect.bottom - 56;
    this._scroll_dn = p.add(new Button(sx, this._scroll_dn_y, "v", ["__scroll__", 1] as unknown as string, 24));
    // right controls column: Update / Inventory / Done (stacked).  RE: the shop
    // builder has EXACTLY these three buttons; no Sell button in the v1.50 shop.
    const cx = this._ctrl_x;
    let cy = p.rect.y + 56;
    p.add(new Button(cx, cy, "~Update", "buy", 130, true));
    cy += 30;
    p.add(new Button(cx, cy, "~Inventory", "inventory", 130));
    cy += 30;
    p.add(new Button(cx, cy, "~Done", "pop", 130));
    cy += 44;
    // category tabs: Weapons / Miscellaneous (RE: FUN_1dbc_18f2 toggles cab4).
    this._cat_tabs = p.add(new IconStrip(
      cx, cy, [0, 1],
      () => this.category, (i: number) => this._category_click(i),
      65, (surf, box, i, c) => this._draw_category_icon(surf, box, i, c),
    ));
  }

  _category_click(i: number): void {
    // Switch the active shop category (0=Weapons, 1=Misc) and re-filter the list.
    i = i === 0 ? 0 : 1;
    if (i !== this.category) {
      this.category = i;
      this.sel_row = 0;
      this.scroll = 0;
      this._refresh_items();
    }
  }

  _draw_category_icon(surf: pygame.Surface, box: pygame.Rect, i: number, _c: unknown): void {
    const txt = i === 0 ? "Weapons" : "Misc";
    const t = W.font(12, true).render(txt, true, W.C_TEXT);
    surf.blit(t, [box.centerx - Math.trunc(t.get_width() / 2), box.centery - Math.trunc(t.get_height() / 2)]);
  }

  // -- scrolling --------------------------------------------------------------
  _max_scroll(): number {
    return Math.max(0, this.items.length - this.rows_visible);
  }

  _scroll_by(delta: number): void {
    this.scroll = Math.max(0, Math.min(this._max_scroll(), this.scroll + delta));
  }

  _move_selection(delta: number): void {
    // Move the selected row by `delta`, clamped, scrolling to keep it visible.
    if (this.items.length === 0) {
      return;
    }
    this.sel_row = Math.max(0, Math.min(this.items.length - 1, this.sel_row + delta));
    if (this.sel_row < this.scroll) {
      this.scroll = this.sel_row;
    } else if (this.sel_row >= this.scroll + this.rows_visible) {
      this.scroll = this.sel_row - this.rows_visible + 1;
    }
    this.scroll = Math.max(0, Math.min(this._max_scroll(), this.scroll));
  }

  _affordable(slot: number): boolean {
    // True iff the tank can buy this row now (price <= cash AND arms-gated in AND
    // below the 99 cap).  Mirrors the Economy.buy gate (economy.ts:116-134).
    return (
      this.econ.available[slot] &&
      this.tank.cash >= this.econ.price[slot] &&
      this.tank.inventory[slot] < C.INVENTORY_CAP
    );
  }

  // -- helpers ----------------------------------------------------------------
  _selected_slot(): number | null {
    if (0 <= this.sel_row && this.sel_row < this.items.length) {
      return this.items[this.sel_row];
    }
    return null;
  }

  _buy_selected(): void {
    // ~Update buys ONE bundle of the selected row.  A failed gate beeps.
    const slot = this._selected_slot();
    if (slot === null) {
      return;
    }
    if (!this._affordable(slot) || !this.econ.buy(this.tank, slot)) {
      // ui beep on buy fail (FUN_5571_0007(200,0x28)).  The sound module is wired
      // by the integrator (ingame's sound seam); the buy-fail beep is a Phase-3
      // audio hook, not a numeric output, so it is a no-op gap here.
      return;
    }
    // Cash dropped: rebuild the visible list so items the tank can no longer
    // afford are REMOVED.  Keep the cursor on the same item when it survives.
    this._refresh_items();
    const j = this.items.indexOf(slot);
    if (j >= 0) {
      this.sel_row = j;
      this.scroll = Math.max(0, Math.min(this._max_scroll(), this.scroll));
    }
  }

  override handle(e: ScreenEvent): ScreenAction {
    // row selection by mouse click inside the grid
    if (e.type === pygame.MOUSEBUTTONDOWN && e.button === 1) {
      const gy = this._grid_top;
      for (let r = 0; r < this.rows_visible; r++) {
        const idx = this.scroll + r;
        if (idx >= this.items.length) {
          break;
        }
        const row_rect = new pygame.Rect(this._list_x, gy + r * 18, this._list_right - this._list_x, 18);
        if (e.pos && row_rect.collidepoint(e.pos)) {
          this.sel_row = idx;
          return null;
        }
      }
    }
    // mouse wheel scrolls one row
    if (e.type === pygame.MOUSEBUTTONDOWN && (e.button === 4 || e.button === 5)) {
      this._scroll_by(e.button === 4 ? -1 : 1);
      return null;
    }
    // keyboard: Up/Down move the selection; PgUp/PgDn page the grid.
    if (e.type === pygame.KEYDOWN) {
      if (e.key === pygame.K_DOWN) {
        this._move_selection(1);
        return null;
      }
      if (e.key === pygame.K_UP) {
        this._move_selection(-1);
        return null;
      }
      if (e.key === pygame.K_PAGEDOWN) {
        this._scroll_by(this.rows_visible);
        this.sel_row = Math.min(this.items.length - 1, Math.max(this.sel_row, this.scroll));
        return null;
      }
      if (e.key === pygame.K_PAGEUP) {
        this._scroll_by(-this.rows_visible);
        this.sel_row = Math.max(0, Math.min(this.sel_row, this.scroll + this.rows_visible - 1));
        return null;
      }
    }
    // scroll arrows resolve to ['__scroll__', d] internal actions
    const act = this.panel.handle(e);
    if (Array.isArray(act) && act.length && act[0] === "__scroll__") {
      // The shop PAGES: FUN_1dbc_0d29 does cac2 +/-= cabe (page size), never +/-1.
      this._scroll_by((act[1] as number) * this.rows_visible);
      return null;
    }
    if (act === "buy") {
      this._buy_selected();
      return null;
    }
    if (act === "inventory") {
      // ~Inventory: open this shopper's loadout panel over the shop.
      return "shop_inventory";
    }
    if (act === "sell_req") {
      const slot = this._selected_slot();
      if (slot !== null && this.tank.inventory[slot] > 0) {
        this.sell_slot = slot;
        return "push:sell";
      }
      return null;
    }
    return act as ScreenAction;
  }

  override update(dt: number): ScreenAction {
    // Drive the shop's per-frame DAC color cycle (FUN_1dbc_0874, the shop modal's
    // idle hook).  Advance the counter on a wall-clock accumulator at
    // C.PALETTE_CYCLE_HZ (70) so the cycle is frame-rate independent; mirror the
    // cycled low staging slots up to the 0xAA band the icons index.
    this._cycle_accum += dt * C.PALETTE_CYCLE_HZ;
    const ticks = Math.trunc(this._cycle_accum);
    if (ticks <= 0) {
      return null;
    }
    this._cycle_accum -= ticks;
    for (let n = 0; n < ticks; n++) {
      this._cycle_counter += 1; // :6  DAT_5f38_00ec++
      if (this._cycle_counter > 100) {
        // :7  wrap at 100
        this._cycle_counter = ((this._cycle_counter % 101) + 101) % 101;
      }
      palette.firewall_apply(this.shop_lut, this._cycle_counter);
    }
    // mirror the re-uploaded staging slots up to the icon band (eefc 0xaa,0x14)
    for (let i = 0; i < SHOP_CYCLE_COUNT; i++) {
      this.shop_lut.set_index(SHOP_ICON_BASE + i, this.shop_lut.get(i));
    }
    return null;
  }

  override draw(surf: pygame.Surface): void {
    surf.fill(W.C_BG);
    this.panel.draw(surf, false);
    const p = this.panel;
    // -- top bar (RE FUN_1dbc_1aa8.c:68-86): name (player color) | Cash | rounds
    const bar_y = p.rect.y + 26;
    const pidx = this.tank.player_index ?? 0;
    const name_col = palette.TEAM_RGB[pidx % palette.TEAM_RGB.length];
    _draw_accel_text(surf, this.tank.name, p.rect.x + 12, bar_y, name_col, W.font(15, true));
    // "Cash: $%ld" centered (no comma in the binary's printf).
    const cash = `Cash: $${this.tank.cash}`;
    const cf = W.font(15, true);
    const cw = cf.size(cash)[0];
    _draw_accel_text(surf, cash, p.rect.centerx - Math.trunc(cw / 2), bar_y, W.C_TEXT, cf);
    // "%d rounds remain" / "1 round remains" right
    const remain = this.state.cfg.MAXROUNDS - this.state.round_index;
    const rtext = remain === 1 ? "1 round remains" : `${remain} rounds remain`;
    const rw = W.font(15).size(rtext)[0];
    _draw_accel_text(surf, rtext, this._list_right - rw, bar_y, W.C_TEXT, W.font(15));
    // -- item rows (RE FUN_1dbc_2266): >arrow | owned | icon | name | $p/b ------
    const gy = this._grid_top;
    const lx = this._list_x;
    const arrow_x = lx;
    const owned_x = lx + 14;
    const icon_x = lx + 44;
    const name_x = lx + 70;
    const price_right = this._list_right - 6;
    const fnt = W.font(14);
    for (let r = 0; r < this.rows_visible; r++) {
      const idx = this.scroll + r;
      if (idx >= this.items.length) {
        break;
      }
      const slot = this.items[idx];
      const it = weapons.ITEMS[slot];
      const yy = gy + r * 18;
      const sel = idx === this.sel_row;
      if (sel) {
        pygame.draw.rect(surf, W.C_PANEL_HI, [lx - 2, yy - 1, this._list_right - lx, 17]);
      }
      // Every visible row is affordable (unaffordable items are filtered OUT).
      const col = W.C_TEXT;
      if (sel) {
        surf.blit(W.font(14, true).render(">", true, W.C_TEXT), [arrow_x, yy]);
      }
      const owned = this.tank.inventory[slot];
      surf.blit(fnt.render(String(owned), true, col), [owned_x, yy]);
      // weapon icon: the REAL per-weapon Table-A sprite, indexed by SLOT, rendered
      // THROUGH the shop's real DAC band 0xAA (sprites provider; Phase-3 pixels).
      if (_sprites !== null) {
        const spr = _sprites.get_sprite("A", slot, { color: SHOP_ICON_BASE, pal: this.shop_lut.table, scale: 1 });
        if (spr !== null) {
          surf.blit(spr, [icon_x, yy]);
        }
      }
      // Name
      surf.blit(fnt.render(it.name, true, col), [name_x, yy]);
      // price token "$<price>/<bundle>" as ONE right-aligned token
      const price = this.econ.price[slot];
      const bundle = it.bundle;
      const ptok = `$${price}/${bundle}`;
      const pw = fnt.size(ptok)[0];
      surf.blit(fnt.render(ptok, true, col), [price_right - pw, yy]);
    }
    draw_cursor(surf);
  }
}

// ===========================================================================
// 5. SELL EQUIPMENT
// ===========================================================================
export class SellScreen extends Screen {
  /** SCREENS.md s5.  Sell Equipment dialog for one item: the Offer (computed from
   * live price, exactly as Economy.sell), a Quantity-to-sell spinner (1..owned),
   * and ~Accept (default) / ~Reject.  Accept commits via Economy.sell then 'pop'. */
  override opaque = false;

  state: { economy: Economy };
  tank: EconomyTank;
  slot: number;
  econ: Economy;
  w: number;
  h: number;
  qty: number;
  committed: number;
  panel: Panel;
  qty_spin!: Spinner;
  offer_label!: Label;

  constructor(state: { economy: Economy }, tank: EconomyTank, slot: number, w: number, h: number) {
    super();
    this.state = state;
    this.tank = tank;
    this.slot = slot;
    this.econ = state.economy;
    this.w = w;
    this.h = h;
    this.qty = 1;
    this.committed = 0;
    this.panel = new Panel(Math.trunc(w / 2) - 150, Math.trunc(h / 2) - 90, 300, 180, "Sell Equipment", false, "pop");
    this._build();
  }

  _offer(qty: number): number {
    // Replicates Economy.sell pricing WITHOUT committing (offer = 0.80/0.65 x live
    // per-unit price x qty).
    const mult = this.econ.cfg.is_on("FREE_MARKET") ? C.SELLBACK_MULT_FREEMARKET : C.SELLBACK_MULT_NORMAL;
    const bundle = weapons.ITEMS[this.slot].bundle || 1;
    return pyRound((this.econ.price[this.slot] * qty * mult) / bundle);
  }

  _build(): void {
    const p = this.panel;
    const x = p.rect.x + 18;
    let y = p.rect.y + 30;
    const it = weapons.ITEMS[this.slot];
    p.add(new Label(x, y, it.name, W.C_TEXT, 15, true));
    y += 24;
    // ~Quantity to sell: spinner, clamps 1..owned (s5)
    const owned = Math.max(1, this.tank.inventory[this.slot]);
    const getq = (): number => this.qty;
    const setq = (v: number): void => {
      this.qty = Math.trunc(v);
    };
    this.qty_spin = p.add(new Spinner(x, y, "~Quantity to sell:", getq, setq, 1, owned, 1, String, 250));
    y += 26;
    // Offer label (computed live in draw)
    this.offer_label = p.add(new Label(x, y, "Offer: $0"));
    y += 30;
    // ~Accept (default) / ~Reject
    p.add(new Button(x, p.rect.bottom - 30, "~Accept", "accept", null, true));
    p.add(new Button(x + 110, p.rect.bottom - 30, "~Reject", "pop"));
  }

  override handle(e: ScreenEvent): ScreenAction {
    const act = this.panel.handle(e);
    if (act === "accept") {
      this.committed = this.econ.sell(this.tank, this.slot, this.qty);
      return "pop";
    }
    return act;
  }

  override draw(surf: pygame.Surface): void {
    // recompute offer for the current quantity
    this.offer_label.label = `Offer: $${this._offer(this.qty)}`;
    this.panel.draw(surf, true);
    draw_cursor(surf);
  }
}

// ===========================================================================
// 6. INVENTORY / WEAPON-LOADOUT PANEL
// ===========================================================================
export class InventoryScreen extends Screen {
  /** SCREENS.md s6 / catalog 17 s3.1.  In-round Inventory panel.  Lists the
   * player's owned offensive weapons (click a row -> selected_weapon, == the HUD
   * weapon-cycle set), the guidance options (click -> selected_guidance, None
   * clears), the 8-cell weapon-icon array, and read-only defensive counts.
   *
   * Modal contract: the task overrides the binary's no_cancel and returns 'pop' on
   * ~Done / Esc / click-outside (divergence documented in screens.py:1746-1749). */
  override opaque = true;

  // guidance item slots (weapons.ITEMS category == "guidance"): 33..37.
  static readonly _GUIDANCE_SLOTS: number[] = (() => {
    const out: number[] = [];
    for (let i = 0; i < weapons.ITEMS.length; i++) {
      if (weapons.ITEMS[i].category === "guidance") {
        out.push(i);
      }
    }
    return out;
  })();

  state: unknown;
  tank: OwnTank;
  w: number;
  h: number;
  weapon_slots: number[];
  guidance_slots: number[];
  panel: Panel;
  _wrows: [number, number][] = [];
  _grows: [number | null, number][] = [];
  _array_slots: number[] = [];
  _array_y!: number;
  weapon_array: IconStrip | null = null;
  // layout (recomputed each draw)
  _wcol_x = 0;
  _gcol_x = 0;
  _list_top = 0;
  _guidance_bottom = 0;

  constructor(state: unknown, tank: OwnTank, w: number, h: number) {
    super();
    this.state = state;
    this.tank = tank;
    this.w = w;
    this.h = h;
    // weapon set == the HUD weapon-cycle set (offensive AND owned/has_ammo).
    this.weapon_slots = _owned_offensive(tank);
    // owned guidance items (count > 0); the panel always offers a "None" row.
    this.guidance_slots = InventoryScreen._GUIDANCE_SLOTS.filter((s) => tank.inventory[s] > 0);
    this.panel = new Panel(20, 16, w - 40, h - 32, "Inventory", false, "pop");
    this._wrows = []; // (slot, y) for the clickable weapon rows
    this._grows = []; // (slot_or_None, y) for the guidance rows
    this._build_chrome();
  }

  // -- helpers ----------------------------------------------------------------
  _count_str(slot: number): string {
    // Owned count for a weapon row; Baby Missile is unlimited (manual).
    if (slot === weapons.SLOT_BABY_MISSILE) {
      return "unlimited";
    }
    return String(this.tank.inventory[slot]);
  }

  _select_weapon(slot: number): void {
    this.tank.selected_weapon = slot;
  }

  _select_guidance(slot: number | null): void {
    // the "None" row clears guidance; otherwise arm the chosen guidance item.
    this.tank.selected_guidance = slot;
  }

  _weapon_array_index(): number {
    // 8-icon array cell index for the current selection (-1 if the active weapon
    // is not in the owned-offensive set, e.g. just spent its last).
    const j = this.weapon_slots.indexOf(this.tank.selected_weapon as number);
    return j; // indexOf returns -1 when absent (== Python's ValueError branch)
  }

  // -- chrome (buttons + the 8-icon weapon array) -----------------------------
  _build_chrome(): void {
    const p = this.panel;
    // ~Done [1342] default button; Enter/Esc/click-out all leave -> 'pop'.
    p.add(new Button(p.rect.right - 80, p.rect.bottom - 30, "~Done", "pop", null, true));
    // 8-cell weapon-icon array; cells map to the first <=8 owned-offensive slots.
    this._array_slots = this.weapon_slots.slice(0, 8);
    const ax = p.rect.x + 16;
    const ay = p.rect.bottom - 30 - 40;
    this._array_y = ay;
    if (this._array_slots.length) {
      this.weapon_array = p.add(new IconStrip(
        ax, ay, Array.from({ length: this._array_slots.length }, (_unused, i) => i),
        () => this._weapon_array_index(), (i: number) => this._array_click(i),
        36, (surf, box, i, c) => this._draw_array_cell(surf, box, i, c),
      ));
    } else {
      this.weapon_array = null;
    }
  }

  _array_click(i: number): void {
    if (0 <= i && i < this._array_slots.length) {
      this._select_weapon(this._array_slots[i]);
    }
  }

  _draw_array_cell(surf: pygame.Surface, box: pygame.Rect, i: number, _c: unknown): void {
    // Paint a real extracted weapon sprite (slot-indexed, through the shop's
    // authored band-0xAA palette).  Phase-3 pixels via the sprites provider.
    const slot = this._array_slots[i];
    if (_sprites !== null) {
      const spr = _sprites.get_sprite("A", slot, { color: _sprites.WEAPON_ICON_BASE, pal: _sprites.weapon_icon_palette(), scale: 2 });
      if (spr !== null) {
        surf.blit(spr, [box.x + 8, box.y + 8]);
      }
    }
  }

  // -- layout for the two clickable lists (recomputed each draw) --------------
  _layout_lists(): void {
    const p = this.panel;
    const col_w = Math.trunc((p.rect.w - 48) / 2);
    const lx = p.rect.x + 16; // left column: offensive weapons
    const rx = p.rect.x + 24 + col_w; // right column: guidance + read-only counts
    const top = p.rect.y + 48;
    this._wcol_x = lx;
    this._gcol_x = rx;
    this._list_top = top;
    this._wrows = [];
    for (let r = 0; r < this.weapon_slots.length; r++) {
      this._wrows.push([this.weapon_slots[r], top + r * 18]);
    }
    this._grows = [];
    let gy = top;
    for (const slot of this.guidance_slots) {
      // owned guidance items
      this._grows.push([slot, gy]);
      gy += 18;
    }
    this._grows.push([null, gy]); // the always-present "None" row
    this._guidance_bottom = gy + 18;
  }

  override handle(e: ScreenEvent): ScreenAction {
    if (e.type === pygame.MOUSEBUTTONDOWN && e.button === 1 && e.pos) {
      this._layout_lists();
      // weapon rows (left column) -> set selected_weapon
      for (const [slot, yy] of this._wrows) {
        const row = new pygame.Rect(this._wcol_x - 2, yy - 1, this._gcol_x - 8 - this._wcol_x, 17);
        if (row.collidepoint(e.pos)) {
          this._select_weapon(slot);
          return null;
        }
      }
      // guidance rows (right column) -> set selected_guidance (None clears)
      for (const [slot, yy] of this._grows) {
        const row = new pygame.Rect(this._gcol_x - 2, yy - 1, this.panel.rect.right - 16 - this._gcol_x, 17);
        if (row.collidepoint(e.pos)) {
          this._select_guidance(slot);
          return null;
        }
      }
    }
    // buttons + the 8-icon array + Esc/click-outside go through the Panel
    return this.panel.handle(e);
  }

  override draw(surf: pygame.Surface): void {
    surf.fill(W.C_BG);
    this.panel.draw(surf, false);
    this._layout_lists();
    const p = this.panel;
    const t = this.tank;
    const f = W.font(14);
    // column headers
    _draw_accel_text(surf, "Weapons", this._wcol_x, this._list_top - 18, W.C_SEL);
    _draw_accel_text(surf, "Guidance", this._gcol_x, this._list_top - 18, W.C_SEL);
    // left column: owned offensive weapons (name + count); highlight active
    for (const [slot, yy] of this._wrows) {
      const sel = slot === t.selected_weapon;
      if (sel) {
        pygame.draw.rect(surf, W.C_PANEL_HI, [this._wcol_x - 2, yy - 1, this._gcol_x - 8 - this._wcol_x, 17]);
      }
      const item = weapons.ITEMS[slot];
      surf.blit(f.render(item.name, true, W.C_TEXT), [this._wcol_x, yy]);
      const cnt = this._count_str(slot);
      const cw = f.size(cnt)[0];
      surf.blit(f.render(cnt, true, W.C_TEXT), [this._gcol_x - 12 - cw, yy]);
    }
    // right column: guidance options (owned + None); highlight the armed one
    for (const [slot, yy] of this._grows) {
      const armed = t.selected_guidance === slot;
      if (armed) {
        pygame.draw.rect(surf, W.C_PANEL_HI, [this._gcol_x - 2, yy - 1, p.rect.right - 16 - this._gcol_x, 17]);
      }
      let name: string;
      let cnt: string;
      if (slot === null) {
        name = "None";
        cnt = "";
      } else {
        name = weapons.ITEMS[slot].name;
        cnt = String(t.inventory[slot]);
      }
      surf.blit(f.render(name, true, W.C_TEXT), [this._gcol_x, yy]);
      if (cnt) {
        const cw = f.size(cnt)[0];
        surf.blit(f.render(cnt, true, W.C_TEXT), [p.rect.right - 24 - cw, yy]);
      }
    }
    // read-only defensive/consumable counts (status-bar fields, s8c)
    let ry = Math.max(this._guidance_bottom, this._array_y - 110) + 8;
    let shields = 0;
    for (const s of weapons.SHIELD_SLOTS) {
      shields += t.inventory[s];
    }
    const readonly: [string, number][] = [
      ["Shields", shields],
      ["Parachutes", t.inventory[weapons.SLOT_PARACHUTE]],
      ["Batteries", t.inventory[weapons.SLOT_BATTERY]],
      ["Triggers", t.inventory[weapons.SLOT_CONTACT_TRIGGER]],
      ["Fuel", t.inventory[weapons.SLOT_FUEL]],
    ];
    for (const [lbl, n] of readonly) {
      surf.blit(f.render(`${lbl}: ${n}`, true, W.C_TEXT), [this._gcol_x, ry]);
      ry += 18;
    }
    // label the 8-icon weapon array
    if (this.weapon_array !== null) {
      _draw_accel_text(surf, "Weapon array (click to select):", this._wcol_x, this._array_y - 18, W.C_TEXT);
    }
    draw_cursor(surf);
  }
}

// ===========================================================================
// 7. SAVE / RESTORE GAME
// ===========================================================================
// Catalog 04 s.5d/s.5e + catalog 18 s3: Save prompts for a filename and writes
// the game; Restore prompts for a filename, validates the magic + version, and
// queues the round to resume.  Wrapped around savegame.save / load + apply via
// the host SaveStoreProvider (no browser filesystem).
export const SAVE_EXT = ".sav";

/** Existing .sav basenames (without extension), sorted.  A missing store is not
 *  an error -- it just means no saves yet (returns []).  Pure given the listing
 *  the host supplies (os.listdir + splitext + sort + ext-filter analog). */
export function _list_saves(listing?: string[]): string[] {
  // `listing` is the host's raw file/basename list (with or without .sav).  When
  // omitted, defer to the registered save-store provider (browser host) or [].
  let names: string[];
  if (listing !== undefined) {
    names = listing;
  } else if (_saveStore !== null) {
    // The provider already returns basenames WITHOUT extension; pass them through
    // the same splitext+sort so the contract matches the raw-listing path.
    names = _saveStore.list().map((n) => n + SAVE_EXT);
  } else {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    if (n.toLowerCase().endsWith(SAVE_EXT)) {
      // os.path.splitext(n)[0]: strip the final extension.
      out.push(_splitext_root(n));
    }
  }
  out.sort();
  return out;
}

/** os.path.basename (POSIX): the final path component after the last '/'.  The
 *  oracle runs on Linux, where os.sep == '/' and a backslash is NOT a separator
 *  (os.path.basename("back\\slash\\name") == "back\\slash\\name"); reproduce that
 *  POSIX semantic exactly (do NOT treat '\\' as a separator). */
function _basename(p: string): string {
  const i = p.lastIndexOf("/");
  return p.slice(i + 1);
}

/** os.path.splitext(name)[0]: the name with its final extension removed.  A
 *  leading-dot-only name (".sav") has no extension under os.path.splitext (the
 *  root is the whole name), matching CPython. */
function _splitext_root(name: string): string {
  const base = _basename(name);
  const dot = base.lastIndexOf(".");
  // CPython: a dot at index 0 (or only leading dots) is NOT an extension.
  let lead = 0;
  while (lead < base.length && base[lead] === ".") {
    lead++;
  }
  if (dot <= lead - 1 || dot < 0) {
    return name;
  }
  // strip from the dir-qualified name, not just the basename
  const cut = name.length - (base.length - dot);
  return name.slice(0, cut);
}

/** Resolve a typed name to a .sav basename (no traversal).  basename() the name
 *  so a typed path cannot escape the save dir; returns null on an empty name.
 *  (Python returns a full os.path.join path; the TS port returns the normalised
 *  basename WITH the .sav extension -- the host store keys on that.) */
export function _save_path(name: string): string | null {
  let base = _basename(name.trim());
  if (!base) {
    return null;
  }
  if (!base.toLowerCase().endsWith(SAVE_EXT)) {
    base += SAVE_EXT;
  }
  return base;
}

abstract class _FileListScreen extends Screen {
  /** Shared chrome for Save / Restore: a name TextField, a clickable list of
   * existing .sav files, a status line, and the action buttons.  Subclasses set
   * the title, the primary button label/action, and implement _commit(). */
  override opaque = true;

  static readonly PRIMARY_LABEL: string = "~Ok";
  static readonly PRIMARY_ACTION: string = "primary";

  state: savegame.SaveGameState | null;
  w: number;
  h: number;
  name: string;
  status: string;
  saves: string[];
  panel: Panel;
  name_field!: TextField;
  _list_top!: number;
  _row_h!: number;
  _list_rows!: number;

  protected constructor(state: savegame.SaveGameState | null, w: number, h: number, title: string) {
    super();
    this.state = state;
    this.w = w;
    this.h = h;
    this.name = "";
    this.status = "";
    this.saves = _list_saves();
    this.panel = new Panel(Math.trunc(w / 2) - 200, Math.max(20, Math.trunc(h / 2) - 150), 400, 300, title, false, "pop");
    this._build();
  }

  /** The subclass primary label/action (Python class attrs PRIMARY_LABEL/ACTION). */
  protected abstract primaryLabel(): string;
  protected abstract primaryAction(): string;

  _build(): void {
    const p = this.panel;
    const x = p.rect.x + 18;
    let y = p.rect.y + 30;
    // name field (tag-2 edit; the filename to save under / restore from)
    p.add(new Label(x, y, "~File:"));
    const getn = (): string => this.name;
    const setn = (v: string): void => {
      this.name = v;
    };
    this.name_field = p.add(new TextField(x + 56, y - 2, "", getn, setn, 20, 300));
    y += 30;
    p.add(new Label(x, y, "Existing saves:"));
    y += 4;
    // the clickable list viewport top (rows drawn + hit-tested in draw/handle)
    this._list_top = y + 18;
    this._row_h = 18;
    this._list_rows = 8;
    // primary (~Save / ~Restore) + ~Cancel along the bottom
    const by = p.rect.bottom - 30;
    p.add(new Button(x, by, this.primaryLabel(), this.primaryAction(), null, true));
    p.add(new Button(p.rect.right - 90, by, "~Cancel", "pop"));
  }

  // -- the .sav list: click a row to fill the name field ----------------------
  _row_rect(r: number): pygame.Rect {
    return new pygame.Rect(this.panel.rect.x + 18, this._list_top + r * this._row_h, this.panel.rect.w - 36, this._row_h);
  }

  override handle(e: ScreenEvent): ScreenAction {
    if (e.type === pygame.MOUSEBUTTONDOWN && e.button === 1 && e.pos) {
      for (let r = 0; r < Math.min(this._list_rows, this.saves.length); r++) {
        if (this._row_rect(r).collidepoint(e.pos)) {
          this.name = this.saves[r];
          return null;
        }
      }
    }
    const act = this.panel.handle(e);
    if (act === this.primaryAction()) {
      return this._commit();
    }
    return act;
  }

  protected abstract _commit(): ScreenAction;

  override update(_dt: number): ScreenAction {
    return null;
  }

  override draw(surf: pygame.Surface): void {
    surf.fill(W.C_BG);
    this.panel.draw(surf, false);
    const f = W.font(14);
    for (let r = 0; r < Math.min(this._list_rows, this.saves.length); r++) {
      const rr = this._row_rect(r);
      if (W.plain(this.name) === this.saves[r]) {
        pygame.draw.rect(surf, W.C_PANEL_HI, rr);
      }
      surf.blit(f.render(this.saves[r] + SAVE_EXT, true, W.C_TEXT), [rr.x + 2, rr.y]);
    }
    if (this.saves.length === 0) {
      surf.blit(f.render("(none)", true, W.C_TEXT), [this.panel.rect.x + 20, this._list_top]);
    }
    if (this.status) {
      // status / error line above the buttons (the version-guard message lands here)
      _draw_accel_text(surf, this.status, this.panel.rect.x + 18, this.panel.rect.bottom - 52, W.C_ACCEL, f);
    }
    draw_cursor(surf);
  }
}

export class SaveScreen extends _FileListScreen {
  /** System Menu -> Save Game.  Type a filename (or click an existing one), ~Save
   * writes the GameState via savegame.save; ~Cancel / Esc / click-outside -> 'pop'.
   * On success the dialog pops; an I/O failure shows on the status line and the
   * dialog stays open (the save did NOT happen -- it must not report success).
   *
   * Overwrite guard (REMAINING_GAPS.md GAP 4, FUN_400b_04ab.c:31-37): saving onto
   * an existing .sav raises a two-button yes/no confirm carrying the verbatim
   * template 'File "%s" exists.  Delete it?'.  YES overwrites; NO returns. */
  static override readonly PRIMARY_LABEL = "~Save";
  static override readonly PRIMARY_ACTION = "do_save";

  // Verbatim filesystem strings (binary-read; offsets in REMAINING_GAPS.md).
  static readonly ERR_CREATE = 'Error trying to create file "%s"!';
  static readonly CONFIRM_TMPL = 'File "%s" exists.  Delete it?';

  _confirm: Panel | null;
  _pending_path: string | null;

  constructor(state: savegame.SaveGameState | null, w: number, h: number) {
    super(state, w, h, "Save Game");
    this._confirm = null; // active overwrite-confirm Panel, or None
    this._pending_path = null; // basename awaiting YES/NO
  }

  protected primaryLabel(): string {
    return SaveScreen.PRIMARY_LABEL;
  }
  protected primaryAction(): string {
    return SaveScreen.PRIMARY_ACTION;
  }

  _do_save(base: string): ScreenAction {
    // Perform the actual write.  Returns 'pop' on success; on I/O failure sets the
    // verbatim create-error status and returns null (dialog stays open -- the save
    // did NOT happen, so it MUST NOT report success; DTM s6.8).
    if (_saveStore === null || this.state === null) {
      this.status = SaveScreen.ERR_CREATE.replace("%s", base) + "  (no save store)";
      return null;
    }
    try {
      const bytes = savegame.save(this.state);
      _saveStore.write(_splitext_root(base), bytes);
    } catch (exc) {
      const detail = exc instanceof Error ? exc.message : String(exc);
      this.status = SaveScreen.ERR_CREATE.replace("%s", base) + `  (${detail})`;
      return null;
    }
    return "pop";
  }

  protected _commit(): ScreenAction {
    if (this.state === null) {
      this.status = "No game in progress.";
      return null;
    }
    const path = _save_path(this.name);
    if (path === null) {
      this.status = "Enter a file name.";
      return null;
    }
    if (_saveStore !== null && _saveStore.exists(_splitext_root(path))) {
      // Existing file: raise the yes/no confirm instead of clobbering.
      this._pending_path = path;
      this._confirm = this._build_confirm(path);
      return null;
    }
    return this._do_save(path);
  }

  _build_confirm(basename: string): Panel {
    // Two-button yes/no modal carrying 'File "%s" exists.  Delete it?'.  Esc /
    // click-outside behave as NO (cancel_action -> back to name field).
    const cw = 360;
    const ch = 110;
    const p = new Panel(Math.trunc(this.w / 2) - Math.trunc(cw / 2), Math.trunc(this.h / 2) - Math.trunc(ch / 2), cw, ch, "Save Game", false, "cancel_overwrite");
    p.add(new Label(p.rect.x + 16, p.rect.y + 34, SaveScreen.CONFIRM_TMPL.replace("%s", basename)));
    const by = p.rect.bottom - 30;
    p.add(new Button(p.rect.x + 40, by, "~Yes", "confirm_overwrite", null, true));
    p.add(new Button(p.rect.right - 90, by, "~No", "cancel_overwrite"));
    return p;
  }

  override handle(e: ScreenEvent): ScreenAction {
    if (this._confirm !== null) {
      const act = this._confirm.handle(e);
      if (act === "confirm_overwrite") {
        const path = this._pending_path as string;
        this._pending_path = null;
        this._confirm = null;
        return this._do_save(path); // 'pop' on success, null on failure
      }
      if (act === "cancel_overwrite") {
        this._confirm = null;
        this._pending_path = null;
        return null; // back to the name field, no pop
      }
      return null;
    }
    return super.handle(e);
  }

  override draw(surf: pygame.Surface): void {
    super.draw(surf);
    if (this._confirm !== null) {
      this._confirm.draw(surf, true);
      draw_cursor(surf);
    }
  }
}

export class RestoreScreen extends _FileListScreen {
  /** System Menu -> Restore Game.  Pick / type a saved file; ~Restore loads +
   * validates it (savegame.load) and, on success, restores it into the live
   * GameState (savegame.apply) and pops.  A bad magic / version / corrupt file
   * raises savegame.SaveError, whose message is shown on the status line; the
   * dialog stays open. */
  static override readonly PRIMARY_LABEL = "~Restore";
  static override readonly PRIMARY_ACTION = "do_restore";

  // Verbatim missing-file string (file 0x58eb3; REMAINING_GAPS.md GAP 4).
  static readonly ERR_MISSING = 'File "%s" doesn\'t exist!';

  restored: savegame.SaveGameState | null;

  constructor(state: savegame.SaveGameState | null, w: number, h: number) {
    super(state, w, h, "Restore Game");
    this.restored = null; // the GameState produced on success (driver reads it)
  }

  protected primaryLabel(): string {
    return RestoreScreen.PRIMARY_LABEL;
  }
  protected primaryAction(): string {
    return RestoreScreen.PRIMARY_ACTION;
  }

  protected _commit(): ScreenAction {
    const path = _save_path(this.name);
    if (path === null) {
      this.status = "Pick a saved game.";
      return null;
    }
    if (_saveStore === null || this.state === null) {
      this.status = "Cannot read: no save store";
      return null;
    }
    const bytes = _saveStore.read(_splitext_root(path));
    if (bytes === null) {
      // verbatim missing-file message (FileNotFoundError analog)
      this.status = RestoreScreen.ERR_MISSING.replace("%s", path);
      return null;
    }
    let data: savegame.SaveData;
    try {
      data = savegame.load(bytes, _splitext_root(path));
    } catch (exc) {
      if (exc instanceof savegame.SaveError) {
        // the version-guard / not-a-saved-game message (catalog 18 s3.1)
        this.status = exc.message;
        return null;
      }
      this.status = `Cannot read: ${exc instanceof Error ? exc.message : String(exc)}`;
      return null;
    }
    this.restored = savegame.apply(data, this.state);
    return "pop";
  }
}
