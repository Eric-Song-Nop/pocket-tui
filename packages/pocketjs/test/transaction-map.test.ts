// @ts-nocheck -- Bun supplies the bun:test module at test runtime.
import { describe, expect, test } from "bun:test";

import {
  beginMapTransaction,
  collectChangedMapKeys,
  commitMap,
} from "../src/transaction-map.js";

describe("render transaction maps", () => {
  test("preserves Map iteration order across updates, deletes, and reinserts", () => {
    const base = new Map([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    const candidate = beginMapTransaction(base);

    candidate.set("b", 20);
    candidate.delete("a");
    candidate.set("d", 4);
    candidate.set("a", 10);

    expect([...candidate]).toEqual([
      ["b", 20],
      ["c", 3],
      ["d", 4],
      ["a", 10],
    ]);
    expect(candidate.size).toBe(4);
    expect([...base]).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
  });

  test("commits into the retained Map only after explicit confirmation", () => {
    const base = new Map<number, string>([
      [1, "one"],
      [2, "two"],
    ]);
    const discarded = beginMapTransaction(base);
    discarded.delete(1);
    discarded.set(2, "discarded");
    expect([...base]).toEqual([
      [1, "one"],
      [2, "two"],
    ]);

    const candidate = beginMapTransaction(base);
    candidate.delete(1);
    candidate.set(2, "confirmed");
    candidate.set(3, "three");
    const committed = commitMap(candidate);

    expect(committed).toBe(base);
    expect([...base]).toEqual([
      [2, "confirmed"],
      [3, "three"],
    ]);
    expect(() => candidate.set(4, "late")).toThrow("committed map transaction");
  });

  test("flattens nested render layers and reports their complete touched-key union", () => {
    const base = new Map([
      [1, "one"],
      [2, "two"],
      [3, "three"],
    ]);
    const layout = beginMapTransaction(base);
    layout.set(1, "layout");
    layout.delete(2);
    const paint = beginMapTransaction(layout);
    paint.set(1, "paint");
    paint.set(4, "four");

    const changed = new Set<number>();
    expect(collectChangedMapKeys(paint, changed)).toBe(true);
    expect([...changed].sort((left, right) => left - right)).toEqual([1, 2, 4]);
    expect(commitMap(paint)).toBe(base);
    expect([...base]).toEqual([
      [1, "paint"],
      [3, "three"],
      [4, "four"],
    ]);
  });

  test("materializes non-Map ReadonlyMap implementations without mutating them", () => {
    const backing = new Map([[1, "one"]]);
    const readonlyView: ReadonlyMap<number, string> = {
      get size() {
        return backing.size;
      },
      entries: () => backing.entries(),
      forEach: (callback, thisArg) => backing.forEach(callback, thisArg),
      get: (key) => backing.get(key),
      has: (key) => backing.has(key),
      keys: () => backing.keys(),
      values: () => backing.values(),
      [Symbol.iterator]: () => backing[Symbol.iterator](),
    };

    const candidate = beginMapTransaction(readonlyView);
    candidate.set(2, "two");
    const committed = commitMap(candidate);
    expect(committed).not.toBe(backing);
    expect([...committed]).toEqual([
      [1, "one"],
      [2, "two"],
    ]);
    expect([...backing]).toEqual([[1, "one"]]);
  });

  test("matches native Map across seeded nested transaction histories", () => {
    let state = 0x51a7_2026;
    const random = (limit: number): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state % limit;
    };

    for (let round = 0; round < 512; round += 1) {
      const retained = new Map<number, number>();
      for (let key = 0; key < 8; key += 1) {
        if (random(2) === 1) retained.set(key, random(16));
      }
      const confirmed = [...retained];
      const expected = new Map(retained);
      let candidate = beginMapTransaction(retained);

      for (let operation = 0; operation < 32; operation += 1) {
        const key = random(12);
        switch (random(8)) {
          case 0:
            candidate = beginMapTransaction(candidate);
            break;
          case 1:
            candidate.clear();
            expected.clear();
            break;
          case 2:
          case 3:
            expect(candidate.delete(key)).toBe(expected.delete(key));
            break;
          default: {
            const value = random(32);
            candidate.set(key, value);
            expected.set(key, value);
            break;
          }
        }
        expect([...candidate]).toEqual([...expected]);
        expect(candidate.size).toBe(expected.size);
      }

      expect([...retained]).toEqual(confirmed);
      expect(commitMap(candidate)).toBe(retained);
      expect([...retained]).toEqual([...expected]);
      expect([...candidate]).toEqual([...expected]);
    }
  });
});
