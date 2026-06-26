/**
 * Coverage mop-up: TalkConfig's pyInt STRING coercion (cfg fields arriving as
 * strings -> int(...)) and _resolve's literal-exists fast path (the file is found
 * by a direct join, so the case-insensitive directory scan is skipped). Both
 * mirror the Python control flow (int(cfg.X); os.path.exists(literal) -> return).
 */
import { describe, it, expect } from "vitest";
import { TalkConfig, _resolve, type TalkSettingsSource } from "../src/talk";

describe("talk(more): TalkConfig coerces string probability/delay via int()", () => {
  it("string '75'/'30' truncate to integers 75/30 (pyInt string path)", () => {
    const cfg = {
      TALKING_TANKS: "ALL",
      TALK_PROBABILITY: "75",
      TALK_DELAY: "30",
      ATTACK_COMMENTS: "talk1.cfg",
      DIE_COMMENTS: "talk2.cfg",
    } as unknown as TalkSettingsSource;
    const tc = new TalkConfig(["a"], ["b"], cfg);
    expect(tc.probability).toBe(75);
    expect(tc.delay).toBe(30);
    expect(tc.talking).toBe("ALL");
  });
});

describe("talk(more): _resolve returns the literal path when it exists", () => {
  it("a literal hit short-circuits before the directory scan", () => {
    let scanned = false;
    const fs = {
      joinPath: (a: string, b: string) => `${a}/${b}`,
      pathExists: (p: string) => p === "DATA/TALK1.CFG", // literal exists
      listDir: (_p: string): string[] | null => {
        scanned = true;
        return ["TALK1.CFG"];
      },
    };
    const out = _resolve("DATA", "TALK1.CFG", fs);
    expect(out).toBe("DATA/TALK1.CFG");
    expect(scanned, "listDir must NOT be called on a literal hit").toBe(false);
  });

  it("a literal miss falls back to the case-insensitive scan", () => {
    let scanned = false;
    const fs = {
      joinPath: (a: string, b: string) => `${a}/${b}`,
      pathExists: (p: string) => p === "DATA/TALK1.CFG", // only the uppercase exists
      listDir: (_p: string): string[] | null => {
        scanned = true;
        return ["TALK1.CFG"];
      },
    };
    const out = _resolve("DATA", "talk1.cfg", fs); // lowercase request
    expect(out).toBe("DATA/TALK1.CFG"); // resolved to the real cased file
    expect(scanned).toBe(true);
  });
});
