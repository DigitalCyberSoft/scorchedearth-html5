/**
 * Real-path gate for src/assets.ts -- the browser fetch+decode bridge that
 * stages the original game's *.MTN / TALK*.CFG data for the port.
 *
 * assets.ts has NO whole-module Python counterpart (the Python port reads files
 * straight off disk; the browser cannot), so this test asserts against:
 *   - the byte-fidelity ORACLE it claims: latin1Decode == scorch/talk.py:144
 *     `.decode("latin-1")`, via oracle/vectors/assets.json (dump_assets.py);
 *   - the oracle WHITELIST it mirrors: MTN_FILES / MTN_DEFAULT ==
 *     scorch/sprites.py:1119-1126 TITLE_MTN_DEFAULT / TITLE_MTN_WHITELIST;
 *   - the verified decoder it delegates to: loadMtn == mtn.parseHeader+decode on
 *     the real shipped ROCK001.MTN bytes;
 *   - its own documented contract: in-memory caching, the assets/<name> URL, and
 *     the non-OK-HTTP throw.
 *
 * The network is the only browser dependency; it is replaced with a scripted
 * fetch mock (vi.stubGlobal) so fetchBytes/fetchText/loadMtn run end to end in
 * Node. No DOM is touched (assets.ts never constructs a Surface).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import * as assets from "../src/assets";
import * as mtn from "../src/mtn";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "assets.json");
const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as {
  module: string;
  full256: string;
  crosschunk_len: number;
  crosschunk: string;
};

// The whitelist VERBATIM from scorch/sprites.py:1122-1126 (TITLE_MTN_WHITELIST).
// Hard-coded here so the assertion is a real cross-check of the port's tuple
// against the oracle, not a re-read of the port's own constant.
const ORACLE_WHITELIST = [
  "ICE001.MTN", "ICE002.MTN", "ICE003.MTN",
  "ROCK001.MTN", "ROCK002.MTN", "ROCK003.MTN", "ROCK004.MTN",
  "ROCK005.MTN", "ROCK006.MTN", "SNOW001.MTN",
];

// ---------------------------------------------------------------------------
// Scripted fetch mock. Routes name -> bytes (ok 200) or a forced error status.
// Records each requested URL + a per-name fetch count so caching is observable.
// ---------------------------------------------------------------------------
type Route = { bytes?: Uint8Array; status?: number };
function installFetch(routes: { [name: string]: Route }): ReturnType<typeof vi.fn> {
  const f = vi.fn(async (url: string) => {
    const name = String(url).replace(/^assets\//, "");
    const r = routes[name];
    if (r === undefined) {
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (r.status !== undefined && (r.status < 200 || r.status >= 300)) {
      return { ok: false, status: r.status, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const b = r.bytes as Uint8Array;
    // hand back a detached copy of exactly this asset's bytes
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    return { ok: true, status: 200, arrayBuffer: async () => ab };
  });
  vi.stubGlobal("fetch", f);
  return f;
}

afterEach(() => {
  vi.unstubAllGlobals();
  assets.clearCache(); // never leak a cached asset into the next test
});

// ===========================================================================
// 1. latin1Decode == talk.py:144 .decode("latin-1")  (oracle differential)
// ===========================================================================
describe("assets.latin1Decode == latin-1 oracle (talk.py:144)", () => {
  it("decodes every byte 0x00..0xff to U+0000..U+00FF exactly", () => {
    const input = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(assets.latin1Decode(input)).toBe(vec.full256);
    // spot the standard latin-1 anchors so a regression is legible, not opaque.
    const out = assets.latin1Decode(input);
    expect(out.charCodeAt(0x00)).toBe(0x00);
    expect(out.charCodeAt(0x41)).toBe(0x41); // 'A'
    expect(out.charCodeAt(0x80)).toBe(0x80); // C1 control byte -> U+0080 (not UTF-8 mangled)
    expect(out.charCodeAt(0xe9)).toBe(0xe9); // latin-1 'e-acute'
    expect(out.charCodeAt(0xff)).toBe(0xff);
  });

  it("reassembles byte-exact across the 0x8000 fromCharCode chunk seam", () => {
    const n = vec.crosschunk_len;
    const input = Uint8Array.from({ length: n }, (_, i) => i % 256);
    const out = assets.latin1Decode(input);
    expect(out).toBe(vec.crosschunk);
    expect(out.length).toBe(n);
    // the seam itself: chars on either side of the 0x8000 boundary are intact.
    expect(out.charCodeAt(0x7fff)).toBe(0x7fff % 256);
    expect(out.charCodeAt(0x8000)).toBe(0x8000 % 256);
    expect(out.charCodeAt(0x8001)).toBe(0x8001 % 256);
  });

  it("empty input -> empty string", () => {
    expect(assets.latin1Decode(new Uint8Array(0))).toBe("");
  });
});

// ===========================================================================
// 2. fetchBytes -- URL, caching, non-OK throw
// ===========================================================================
describe("assets.fetchBytes", () => {
  it("fetches assets/<name>, returns the raw bytes", async () => {
    const data = Uint8Array.of(1, 2, 3, 250, 255);
    const f = installFetch({ "X.BIN": { bytes: data } });
    const got = await assets.fetchBytes("X.BIN");
    expect(Array.from(got)).toEqual([1, 2, 3, 250, 255]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe("assets/X.BIN");
  });

  it("caches by name: a second fetchBytes does not re-hit the network and is the same ref", async () => {
    const f = installFetch({ "X.BIN": { bytes: Uint8Array.of(7, 8) } });
    const a = await assets.fetchBytes("X.BIN");
    const b = await assets.fetchBytes("X.BIN");
    expect(f).toHaveBeenCalledTimes(1);
    expect(b).toBe(a); // cache returns the identical Uint8Array
  });

  it("throws on a non-OK HTTP status (no silent HTML-as-game-data)", async () => {
    installFetch({ "GONE.MTN": { status: 404 } });
    await expect(assets.fetchBytes("GONE.MTN")).rejects.toThrow(
      /asset fetch failed: assets\/GONE\.MTN \(HTTP 404\)/,
    );
  });

  it("a thrown fetch is NOT cached: a later success populates the cache", async () => {
    installFetch({ "LATE.BIN": { status: 500 } });
    await expect(assets.fetchBytes("LATE.BIN")).rejects.toThrow(/HTTP 500/);
    // swap in a route that now serves the bytes
    vi.unstubAllGlobals();
    const f = installFetch({ "LATE.BIN": { bytes: Uint8Array.of(9) } });
    const got = await assets.fetchBytes("LATE.BIN");
    expect(Array.from(got)).toEqual([9]);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 3. fetchText -- latin-1 (NOT utf-8), separate text cache
// ===========================================================================
describe("assets.fetchText", () => {
  it("decodes the fetched bytes as latin-1, keeping 8-bit chars", async () => {
    // 0xE9 is latin-1 'e-acute'; a utf-8 decode of this lone byte would corrupt it.
    const f = installFetch({ "TALK1.CFG": { bytes: Uint8Array.of(0x41, 0xe9, 0x0a, 0xff) } });
    const txt = await assets.fetchText("TALK1.CFG");
    expect(txt).toBe("Aé\nÿ");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("caches the decoded text: a second fetchText does not re-fetch", async () => {
    const f = installFetch({ "TALK1.CFG": { bytes: Uint8Array.of(0x68, 0x69) } });
    const a = await assets.fetchText("TALK1.CFG");
    const b = await assets.fetchText("TALK1.CFG");
    expect(a).toBe("hi");
    expect(b).toBe("hi");
    expect(f).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 4. listMtnFiles / MTN_FILES / MTN_DEFAULT == sprites.py oracle whitelist
// ===========================================================================
describe("assets MTN whitelist == sprites.py oracle", () => {
  it("MTN_FILES is the 10 TITLE_MTN_WHITELIST names, in order", () => {
    expect(Array.from(assets.MTN_FILES)).toEqual(ORACLE_WHITELIST);
  });

  it("MTN_DEFAULT == TITLE_MTN_DEFAULT (sprites.py:1119)", () => {
    expect(assets.MTN_DEFAULT).toBe("ROCK001.MTN");
    expect(assets.MTN_FILES).toContain(assets.MTN_DEFAULT);
  });

  it("listMtnFiles() returns the whitelist as a FRESH array (caller cannot mutate the export)", async () => {
    const a = await assets.listMtnFiles();
    expect(a).toEqual(ORACLE_WHITELIST);
    a.push("EVIL.MTN");
    a[0] = "MUTATED";
    const b = await assets.listMtnFiles();
    expect(b).toEqual(ORACLE_WHITELIST); // unaffected by the mutation above
    expect(Array.from(assets.MTN_FILES)).toEqual(ORACLE_WHITELIST);
  });
});

// ===========================================================================
// 5. loadMtn -- whitelist guard, case-fold, and the fetch->mtn delegation
// ===========================================================================
describe("assets.loadMtn", () => {
  // the real shipped asset; loadMtn must reproduce mtn.parseHeader+decode on it.
  const ROCK001 = new Uint8Array(
    readFileSync(join(__dirname, "..", "public", "assets", "ROCK001.MTN")),
  );

  it("rejects an off-whitelist name BEFORE fetching", async () => {
    const f = installFetch({}); // nothing routed
    await expect(assets.loadMtn("NOPE.MTN")).rejects.toThrow(/is not a known \.MTN/);
    expect(f).not.toHaveBeenCalled(); // guard fires before any network call
  });

  it("case-folds the name to the upper-cased shipped file", async () => {
    const f = installFetch({ "ROCK001.MTN": { bytes: ROCK001 } });
    const loaded = await assets.loadMtn("rock001.mtn");
    expect(loaded.name).toBe("ROCK001.MTN");
    expect(f.mock.calls[0][0]).toBe("assets/ROCK001.MTN"); // upper-cased URL
  });

  it("delegates to the verified decoder: header+grid == mtn.parseHeader/decode of the same bytes", async () => {
    installFetch({ "ROCK001.MTN": { bytes: ROCK001 } });
    const loaded = await assets.loadMtn("ROCK001.MTN");
    expect(loaded.bytes.length).toBe(ROCK001.length);
    expect(loaded.bytes[0]).toBe(ROCK001[0]);

    const expHeader = mtn.parseHeader(loaded.bytes, "ROCK001.MTN");
    const expGrid = mtn.decode(loaded.bytes, "ROCK001.MTN");
    expect(loaded.header).toEqual(expHeader);
    expect(loaded.grid.width).toBe(expGrid.width);
    expect(loaded.grid.height).toBe(expGrid.height);
    // byte-exact decoded index plane (fast native compare over the Int16 buffer)
    expect(Buffer.from(loaded.grid.data.buffer).equals(Buffer.from(expGrid.data.buffer))).toBe(true);
  });

  it("caches the bytes: a follow-up fetchBytes for the same name does not re-fetch", async () => {
    const f = installFetch({ "ROCK001.MTN": { bytes: ROCK001 } });
    await assets.loadMtn("ROCK001.MTN");
    const again = await assets.fetchBytes("ROCK001.MTN");
    expect(again.length).toBe(ROCK001.length);
    expect(f).toHaveBeenCalledTimes(1); // loadMtn's fetch is the only network hit
  });
});

// ===========================================================================
// 6. clearCache -- drops both caches so the next fetch re-hits the network
// ===========================================================================
describe("assets.clearCache", () => {
  it("forces a re-fetch of bytes and text after clearing", async () => {
    const f = installFetch({ "Y.CFG": { bytes: Uint8Array.of(0x6f, 0x6b) } });
    await assets.fetchBytes("Y.CFG");
    await assets.fetchText("Y.CFG");
    expect(f).toHaveBeenCalledTimes(1); // text reused the byte cache
    assets.clearCache();
    await assets.fetchBytes("Y.CFG");
    expect(f).toHaveBeenCalledTimes(2); // cache dropped -> network hit again
  });
});
