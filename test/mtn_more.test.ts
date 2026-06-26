/**
 * Coverage mop-up (differential): every MALFORMED-input reject branch in the .MTN
 * decoder. oracle/dump_more.py builds each corrupt blob, feeds it to the Python
 * port (port/mtn.py), and records that the port RAISES (ValueError) on each -- a
 * conformance claim that the TS decoder rejects the identical bytes rather than
 * silently mis-decoding them. The one valid blob is decoded and its grid checked.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseHeader, decode } from "../src/mtn";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "mtn_more.json");
const vec = JSON.parse(readFileSync(VECTORS, "utf-8"));

function hexToBytes(hex: string): Uint8Array {
  const n = hex.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

describe("mtn(more): malformed blobs rejected, matching the Python port", () => {
  for (const c of vec.cases) {
    const bytes = hexToBytes(c.hex);
    const call = () =>
      c.fn === "parse_header" ? parseHeader(bytes, c.label) : decode(bytes, c.label);
    if (c.py_raises) {
      it(`${c.label}: ${c.fn} throws (Python raised ${c.py_err})`, () => {
        expect(call).toThrow();
      });
    } else {
      it(`${c.label}: ${c.fn} decodes without error`, () => {
        expect(call).not.toThrow();
      });
    }
  }

  it("valid_minimal decodes to the Python-decoded grid byte-exact", () => {
    const g = vec.valid_grid;
    const bytes = hexToBytes(
      vec.cases.find((c: { label: string }) => c.label === "valid_minimal").hex,
    );
    const decoded = decode(bytes, "valid_minimal");
    expect([decoded.height, decoded.width]).toEqual(g.shape);
    expect(Array.from(decoded.data)).toEqual(g.data);
  });
});
