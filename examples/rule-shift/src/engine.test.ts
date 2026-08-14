// @ts-nocheck -- Bun supplies this test-only module at runtime.
import { describe, expect, test } from "bun:test";

import {
  createRuleGame,
  deriveRules,
  hasProperty,
  type Direction,
  type EntitySeed,
  type LevelDefinition,
  type Noun,
  type Word,
} from "./engine.js";
import { RULE_SHIFT_LEVELS } from "./levels.js";

describe("rule grammar", () => {
  test("scans horizontal and vertical clauses with stable source metadata", () => {
    const rules = deriveRules(
      [
        text("mote", "MOTE", 0, 0),
        text("is-you", "IS", 1, 0),
        text("you", "YOU", 2, 0),
        text("win", "WIN", 2, 0),
        text("wall", "WALL", 4, 0),
        text("is-stop", "IS", 4, 1),
        text("stop", "STOP", 4, 2),
      ],
      6,
      4,
    );

    expect(rules.clauses.map((clause) => [clause.subject, clause.predicate])).toEqual([
      ["MOTE", "WIN"],
      ["MOTE", "YOU"],
      ["WALL", "STOP"],
    ]);
    expect(rules.clauses.find((clause) => clause.predicate === "YOU")).toMatchObject({
      axis: "horizontal",
      textEntityIds: ["mote", "is-you", "you"],
      cells: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ],
    });
    expect(rules.clauses.find((clause) => clause.subject === "WALL")).toMatchObject({
      axis: "vertical",
      textEntityIds: ["wall", "is-stop", "stop"],
    });
    expect(hasProperty(rules, "MOTE", "YOU")).toBe(true);
    expect(hasProperty(rules, "MOTE", "STOP")).toBe(false);
  });

  test("recognizes noun transformations separately from properties", () => {
    const rules = deriveRules(
      [text("mote", "MOTE", 1, 1), text("is", "IS", 2, 1), text("bloom", "BLOOM", 3, 1)],
      6,
      4,
    );
    expect(rules.properties).toEqual([]);
    expect(rules.transformations).toEqual([
      {
        subject: "MOTE",
        target: "BLOOM",
        clauseKeys: ["horizontal:mote|is|bloom"],
      },
    ]);
  });
});

describe("movement, stacking, and collision rules", () => {
  test("moves every entity in a stacked PUSH chain exactly once", () => {
    const game = createRuleGame([
      level("stacked-freight", 9, 6, [
        ...horizontalRule("mote-you", "MOTE", "YOU", 0, 0),
        ...horizontalRule("crate-push", "CRATE", "PUSH", 4, 0),
        ...horizontalRule("wall-stop", "WALL", "STOP", 0, 5),
        object("player", "MOTE", 1, 3),
        object("crate-a", "CRATE", 2, 3),
        object("crate-b", "CRATE", 2, 3),
        object("crate-c", "CRATE", 3, 3),
        object("blocker", "WALL", 5, 3),
      ]),
    ]);

    const moved = game.move("right");
    expect(moved.consumedTurn).toBe(true);
    expect(moved.events.filter((event) => event.type === "push").map((event) => event.entityId)).toEqual(
      expect.arrayContaining(["crate-a", "crate-b", "crate-c"]),
    );
    expect(moved.events.filter((event) => event.type === "push")).toHaveLength(3);
    expect(game.entitiesAt(3, 3).map((entity) => entity.id).sort()).toEqual([
      "crate-a",
      "crate-b",
    ]);
    expect(game.entitiesAt(4, 3).map((entity) => entity.id)).toEqual(["crate-c"]);

    const blocked = game.move("right");
    expect(blocked.consumedTurn).toBe(false);
    expect(blocked.turn).toBe(1);
    expect(blocked.events).toContainEqual({
      type: "blocked",
      entityIds: ["player"],
      from: [{ x: 2, y: 3 }],
      cell: { x: 5, y: 3 },
      direction: "right",
      reason: "stop",
    });
    expect(game.entitiesAt(4, 3).map((entity) => entity.id)).toEqual(["crate-c"]);
  });

  test("treats a boundary-blocked push chain as one atomic failed move", () => {
    const game = createRuleGame([
      level("edge", 6, 5, [
        ...horizontalRule("mote-you", "MOTE", "YOU", 0, 0),
        ...horizontalRule("crate-push", "CRATE", "PUSH", 0, 4),
        object("player", "MOTE", 3, 2),
        object("crate-a", "CRATE", 4, 2),
        object("crate-b", "CRATE", 5, 2),
      ]),
    ]);
    const before = game.snapshot();
    const result = game.move("right");
    expect(result.consumedTurn).toBe(false);
    expect(result.events[0]).toMatchObject({ type: "blocked", reason: "bounds", cell: { x: 6, y: 2 } });
    expect(game.snapshot()).toEqual(before);
  });

  test("allows multiple YOU objects to move while one of them is blocked", () => {
    const game = createRuleGame(RULE_SHIFT_LEVELS, "twin-current");
    const first = game.move("right");
    expect(first.events.filter((event) => event.type === "move")).toHaveLength(2);

    const second = game.move("right");
    expect(second.consumedTurn).toBe(true);
    expect(second.events.some((event) => event.type === "blocked" && event.entityIds[0] === "twin-mote-object")).toBe(
      true,
    );
    expect(second.events.some((event) => event.type === "move" && event.entityId === "twin-orb-object")).toBe(true);

    game.move("right");
    const won = game.move("right");
    expect(won.phase).toBe("won");
    expect(won.events.at(-1)).toMatchObject({
      type: "win",
      entityIds: ["twin-orb-object", "twin-target"],
      at: { x: 6, y: 6 },
    });
  });
});

describe("live rule changes", () => {
  test("breaks YOU immediately after its word is pushed and restores it with undo", () => {
    const game = createRuleGame([
      level("cut-signal", 6, 6, [
        text("subject", "MOTE", 0, 1),
        text("operator", "IS", 1, 1),
        text("property", "YOU", 2, 1),
        object("player", "MOTE", 2, 2),
      ]),
    ]);
    const start = game.snapshot();

    const cut = game.move("up");
    const ruleEvent = cut.events.find((event) => event.type === "rules-changed");
    expect(cut.consumedTurn).toBe(true);
    expect(ruleEvent?.removed).toEqual(["horizontal:subject|operator|property"]);
    expect(hasProperty(cut.snapshot.rules, "MOTE", "YOU")).toBe(false);

    const inert = game.move("right");
    expect(inert.consumedTurn).toBe(false);
    expect(inert.events[0]).toMatchObject({ type: "blocked", reason: "no-you" });

    const undone = game.undo();
    expect(undone.events[0]).toEqual({
      type: "undo",
      restored: true,
      fromTurn: 1,
      toTurn: 0,
    });
    expect(game.snapshot()).toEqual(start);
  });

  test("forms a noun rule, transforms on the same turn, and keeps the new noun controllable", () => {
    const game = createRuleGame(RULE_SHIFT_LEVELS, "bloom");
    const changed = game.move("up");
    const rulesChanged = changed.events.find((event) => event.type === "rules-changed");
    expect(rulesChanged?.added).toEqual([
      "horizontal:bloom-change-mote|bloom-change-is|bloom-change-word",
    ]);
    expect(changed.events).toContainEqual({
      type: "transform",
      entityId: "bloom-player",
      from: "MOTE",
      to: "BLOOM",
      at: { x: 7, y: 4 },
    });
    expect(game.entitiesAt(7, 4)).toContainEqual({
      id: "bloom-player",
      kind: "object",
      noun: "BLOOM",
      x: 7,
      y: 4,
    });
    expect(hasProperty(game.rules, "BLOOM", "YOU")).toBe(true);

    run(game, ["left", "left", "left", "left"]);
    expect(game.phase).toBe("won");
  });

  test("reports added and removed clause keys without false changes", () => {
    const game = createRuleGame(RULE_SHIFT_LEVELS, "kindle");
    const formed = game.move("up");
    const event = formed.events.find((candidate) => candidate.type === "rules-changed");
    expect(event?.added).toEqual(["horizontal:kindle-goal|kindle-is-win|kindle-win"]);
    expect(event?.removed).toEqual([]);

    const ordinary = game.move("left");
    expect(ordinary.events.some((candidate) => candidate.type === "rules-changed")).toBe(false);
  });
});

describe("campaign lifecycle", () => {
  const solutions: Readonly<Record<string, readonly Direction[]>> = {
    kindle: ["up", "left", "left", "left", "left", "down", "down"],
    breakwater: [
      "up",
      "up",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
      "down",
      "down",
    ],
    freight: ["right", "right", "right", "right", "right", "right", "right"],
    "twin-current": ["right", "right", "right", "right"],
    bloom: ["up", "left", "left", "left", "left"],
  };

  test("ships five original tutorials and a deterministic solution for every board", () => {
    expect(RULE_SHIFT_LEVELS.map((level) => level.id)).toEqual([
      "kindle",
      "breakwater",
      "freight",
      "twin-current",
      "bloom",
    ]);

    for (const [levelId, commands] of Object.entries(solutions)) {
      const first = createRuleGame(RULE_SHIFT_LEVELS, levelId);
      const second = createRuleGame(RULE_SHIFT_LEVELS, levelId);
      const firstResults = run(first, commands);
      const secondResults = run(second, commands);
      expect(firstResults.every((result) => result.consumedTurn)).toBe(true);
      expect(first.phase).toBe("won");
      expect(first.snapshot()).toEqual(second.snapshot());
      expect(firstResults).toEqual(secondResults);
    }
  });

  test("undo restores the exact previous state and restart restores the level seed", () => {
    const game = createRuleGame();
    const initial = game.snapshot();
    game.move("up");
    game.move("left");
    expect(game.historyDepth).toBe(2);

    game.undo();
    expect(game.turn).toBe(1);
    game.undo();
    expect(game.snapshot()).toEqual(initial);
    expect(game.undo().events[0]).toEqual({
      type: "undo",
      restored: false,
      fromTurn: 0,
      toTurn: 0,
    });

    game.move("up");
    const restarted = game.restart();
    expect(restarted.events).toEqual([{ type: "restart", levelId: "kindle" }]);
    expect(game.snapshot()).toEqual(initial);
  });

  test("locks movement after victory but lets undo reopen the solved board", () => {
    const game = createRuleGame();
    run(game, solutions.kindle);
    expect(game.phase).toBe("won");
    const depth = game.historyDepth;

    const locked = game.dispatch("right");
    expect(locked.consumedTurn).toBe(false);
    expect(locked.events[0]).toMatchObject({ type: "blocked", reason: "phase" });
    expect(game.historyDepth).toBe(depth);

    game.dispatch("undo");
    expect(game.phase).toBe("playing");
    expect(game.turn).toBe(6);
  });

  test("selects by id or index, wraps adjacent navigation, and rejects bad selectors", () => {
    const game = createRuleGame();
    const selected = game.selectLevel("freight");
    expect(selected.snapshot).toMatchObject({ levelId: "freight", levelIndex: 2, historyDepth: 0 });
    expect(selected.events[0]).toEqual({
      type: "level-change",
      fromLevelId: "kindle",
      toLevelId: "freight",
      levelIndex: 2,
    });
    expect(game.selectLevel(4).snapshot.levelId).toBe("bloom");
    expect(game.nextLevel().snapshot.levelId).toBe("kindle");
    expect(game.previousLevel().snapshot.levelId).toBe("bloom");
    expect(game.levels).toHaveLength(5);
    expect(() => game.selectLevel(5)).toThrow(RangeError);
    expect(() => game.selectLevel("not-a-level")).toThrow(RangeError);
  });

  test("returns isolated snapshots and rule metadata", () => {
    const game = createRuleGame();
    const exposed = game.snapshot();
    exposed.entities[0].x = 99;
    exposed.rules.clauses[0].cells[0].x = 99;
    exposed.rules.properties[0].clauseKeys.push("forged");

    const fresh = game.snapshot();
    expect(fresh.entities[0].x).not.toBe(99);
    expect(fresh.rules.clauses[0].cells[0].x).not.toBe(99);
    expect(fresh.rules.properties[0].clauseKeys).not.toContain("forged");
  });

  test("copies a supplied level pack so restart cannot be changed from outside", () => {
    const source = level("private-seed", 6, 5, [
      ...horizontalRule("mote-you", "MOTE", "YOU", 0, 0),
      object("player", "MOTE", 2, 2),
    ]);
    const game = createRuleGame([source]);
    source.entities[3].x = 5;
    game.move("right");
    game.restart();
    expect(game.entitiesAt(2, 2).map((entity) => entity.id)).toEqual(["player"]);
    expect(game.entitiesAt(5, 2)).toEqual([]);
  });
});

function level(
  id: string,
  width: number,
  height: number,
  entities: readonly EntitySeed[],
): LevelDefinition {
  return { id, title: id.toUpperCase(), hint: "test", width, height, entities };
}

function object(id: string, noun: Noun, x: number, y: number): EntitySeed {
  return { id, kind: "object", noun, x, y };
}

function text(id: string, word: Word, x: number, y: number): EntitySeed {
  return { id, kind: "text", word, x, y };
}

function horizontalRule(
  id: string,
  subject: Noun,
  predicate: Word,
  x: number,
  y: number,
): readonly EntitySeed[] {
  return [
    text(`${id}-subject`, subject, x, y),
    text(`${id}-is`, "IS", x + 1, y),
    text(`${id}-predicate`, predicate, x + 2, y),
  ];
}

function run(game, commands: readonly Direction[]) {
  return commands.map((command) => game.move(command));
}
