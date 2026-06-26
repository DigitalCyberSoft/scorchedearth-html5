/**
 * Browser asset loader for the HTML5 port. The original game's data files (the 10
 * scanned-mountain *.MTN, the two TALK*.CFG speech configs, SCORCH.ICO) are
 * staged under public/assets/ and fetched at runtime; the Python port reads them
 * straight off disk (sprites._data_dir, talk._read), which the browser cannot do,
 * so this module is the fetch+decode bridge the integration layer calls.
 *
 * Two byte-fidelity points carried from the oracle:
 *   - .MTN / .ICO are BINARY: fetched as raw bytes (Uint8Array), never decoded as
 *     text (a text decode would mangle the 8-bit body). loadMtn hands the bytes
 *     straight to src/mtn.ts (parseHeader/decode), which is the verified decoder.
 *   - TALK*.CFG are DOS text: decoded LATIN-1, matching scorch/talk.py:144
 *     `fh.read().decode("latin-1")` -- each byte maps 1:1 to U+0000..U+00FF, so an
 *     8-bit char a user put in their talk file survives (talk.py:135-139).
 *
 * All fetches are cached in-memory (an MTN/CFG is read once, reused across screen
 * rebuilds). The cache keys on the asset name; bytes and text are cached
 * separately so the same file fetched both ways (not something the port does) is
 * still correct.
 */

import * as mtn from "./mtn";

/** Where staged assets live relative to the page (public/assets/ -> assets/). */
const ASSET_BASE = "assets";

/**
 * The 10 .MTN scanned-mountain filenames, VERBATIM from the oracle whitelist
 * scorch/sprites.py:1122-1126 (TITLE_MTN_WHITELIST, itself the find_mtn_file
 * names FUN_3c44_0676 / strings_clean.txt:1599-1608). The browser cannot glob the
 * assets directory, so this fixed whitelist IS the directory listing -- it must
 * stay identical to the oracle's tuple. Upper-cased to match the shipped files.
 */
export const MTN_FILES: readonly string[] = [
  "ICE001.MTN",
  "ICE002.MTN",
  "ICE003.MTN",
  "ROCK001.MTN",
  "ROCK002.MTN",
  "ROCK003.MTN",
  "ROCK004.MTN",
  "ROCK005.MTN",
  "ROCK006.MTN",
  "SNOW001.MTN",
];

/** The default title mountain (sprites.py:1119 TITLE_MTN_DEFAULT). */
export const MTN_DEFAULT = "ROCK001.MTN";

// In-memory caches: a fetched asset is decoded once and reused. Keyed by name.
const _byteCache = new Map<string, Uint8Array>();
const _textCache = new Map<string, string>();

/**
 * fetchBytes(name): fetch `assets/<name>` and return its raw bytes, cached. For
 * BINARY assets (.MTN, .ICO). Throws on a non-OK HTTP status so a missing/renamed
 * asset surfaces as a real failure rather than silently decoding HTML error
 * pages as game data.
 */
export async function fetchBytes(name: string): Promise<Uint8Array> {
  const hit = _byteCache.get(name);
  if (hit) return hit;
  const url = `${ASSET_BASE}/${name}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`asset fetch failed: ${url} (HTTP ${resp.status})`);
  }
  const buf = await resp.arrayBuffer();
  const bytes = new Uint8Array(buf);
  _byteCache.set(name, bytes);
  return bytes;
}

/**
 * fetchText(name): fetch `assets/<name>` and decode LATIN-1, cached. For DOS text
 * (TALK1.CFG / TALK2.CFG). Latin-1 is the byte-faithful 1:1 decode used by the
 * oracle (talk.py:144); it is implemented here by fetching bytes and mapping each
 * to its code point, NOT via TextDecoder("utf-8") (which would corrupt 8-bit
 * bytes). TextDecoder("latin1") is equivalent but bytes->String.fromCharCode is
 * dependency-free and exact.
 */
export async function fetchText(name: string): Promise<string> {
  const hit = _textCache.get(name);
  if (hit !== undefined) return hit;
  const bytes = await fetchBytes(name);
  const text = latin1Decode(bytes);
  _textCache.set(name, text);
  return text;
}

/**
 * Decode bytes as latin-1: byte b -> U+00<b>. Matches Python `.decode("latin-1")`
 * (talk.py:144). Chunked through String.fromCharCode to avoid a huge spread on
 * large files while staying an exact 1:1 byte->codepoint map.
 */
export function latin1Decode(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000; // 32 KiB per fromCharCode.apply, safe arg-count budget
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    out += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return out;
}

/**
 * listMtnFiles(): the 10 known .MTN names. async to match a directory-listing
 * shape (the browser has no glob; the whitelist is the listing). Returns a fresh
 * array so callers cannot mutate the exported constant.
 */
export async function listMtnFiles(): Promise<string[]> {
  return MTN_FILES.slice();
}

/**
 * loadMtn(name): fetch a .MTN's bytes and hand back the decoded grid + header via
 * the verified decoder (src/mtn.ts), the browser analog of
 * sprites.load_title_mountain's `mtn.parse_header(path)` + `mtn.decode(path)`.
 * Validates `name` against the whitelist first (find_mtn_file rejects off-list
 * names; sprites.py:1147), so a bad name fails loudly instead of 404-ing.
 *
 * Returns the raw bytes plus the parsed header and the decoded row-major index
 * grid, so the caller (the render/sprites port) can build the title surface (RGB
 * via mtn.toRgb, or composite through the file palette) without re-fetching.
 */
export interface LoadedMtn {
  name: string;
  bytes: Uint8Array;
  header: mtn.MtnHeader;
  grid: mtn.MtnGrid;
}

export async function loadMtn(name: string): Promise<LoadedMtn> {
  const upper = name.toUpperCase();
  if (!MTN_FILES.includes(upper)) {
    throw new Error(`loadMtn: ${name} is not a known .MTN (whitelist: ${MTN_FILES.join(", ")})`);
  }
  const bytes = await fetchBytes(upper);
  const header = mtn.parseHeader(bytes, upper);
  const grid = mtn.decode(bytes, upper);
  return { name: upper, bytes, header, grid };
}

/**
 * clearCache(): drop the in-memory asset caches. Not used by the game loop;
 * provided for tests/tools that need a clean fetch (e.g. swapping fixtures).
 */
export function clearCache(): void {
  _byteCache.clear();
  _textCache.clear();
}
