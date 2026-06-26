/**
 * Coverage mop-up: the lightning-visual queue helpers _register_bolt / age_bolts
 * (hazard.ts) on the state-init and empty-queue paths the cavern battery in
 * hazard.test.ts never drove. These are pure state-machine helpers (no oracle
 * vector); assertions follow the documented contract, which mirrors the Python
 * hazard._register_bolt / age_bolts control flow exactly.
 */
import { describe, it, expect } from "vitest";
import { _register_bolt, age_bolts, type State } from "../src/hazard";

describe("hazard(more): _register_bolt initializes and filters polylines", () => {
  it("creates active_bolts when absent and pushes only >=2-point polylines", () => {
    const state = {} as State; // no active_bolts field
    _register_bolt(state, [
      [
        [0, 0],
        [1, 1],
      ],
      [[5, 5]], // single point -> dropped (needs a trunk/branch, >=2 pts)
      [
        [2, 2],
        [3, 3],
        [4, 4],
      ],
    ]);
    expect(Array.isArray(state.active_bolts)).toBe(true);
    expect(state.active_bolts!.length).toBe(2);
    expect(state.active_bolts![0]).toEqual({
      pts: [
        [0, 0],
        [1, 1],
      ],
      frame: 0,
    });
    expect(state.active_bolts![1].pts.length).toBe(3);
  });

  it("appends to an existing active_bolts array (no reset)", () => {
    const state: State = {
      active_bolts: [{ pts: [[9, 9], [8, 8]], frame: 3 }],
    } as State;
    _register_bolt(state, [
      [
        [0, 0],
        [1, 1],
      ],
    ]);
    expect(state.active_bolts!.length).toBe(2);
    expect(state.active_bolts![0].frame).toBe(3); // pre-existing entry untouched
  });
});

describe("hazard(more): age_bolts no-op and expiry", () => {
  it("is a safe no-op when there are no bolts", () => {
    const empty = {} as State;
    expect(() => age_bolts(empty)).not.toThrow();
    const withEmptyArr: State = { active_bolts: [] } as unknown as State;
    expect(() => age_bolts(withEmptyArr)).not.toThrow();
    expect(withEmptyArr.active_bolts).toEqual([]);
  });

  it("ages frames and drops bolts past max_frames", () => {
    const state: State = {
      active_bolts: [
        { pts: [[0, 0], [1, 1]], frame: 0 },
        { pts: [[2, 2], [3, 3]], frame: 6 }, // at max=6 -> ages to 7 -> dropped
      ],
    } as State;
    age_bolts(state, 6);
    expect(state.active_bolts!.length).toBe(1);
    expect(state.active_bolts![0].frame).toBe(1);
  });
});
