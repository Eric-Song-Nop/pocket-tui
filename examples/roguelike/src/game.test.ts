// @ts-nocheck -- Bun supplies this test-only module at runtime.
import { describe, expect, test } from "bun:test";

import {
  createGame,
  createGameFromAscii,
  type Direction,
  type RoguelikeGame,
} from "./game.js";

describe("seeded dungeon generation", () => {
  test("the same seed produces the same dungeon, actors, and pickups", () => {
    const options = { width: 52, height: 22, seed: "ghost-signal", enemyCount: 9, itemCount: 5 };
    const first = createGame(options).snapshot();
    const second = createGame(options).snapshot();
    const different = createGame({ ...options, seed: "another-signal" }).snapshot();

    expect(first).toEqual(second);
    expect(first.map.join("\n")).not.toBe(different.map.join("\n"));
    expect(new Set(first.enemies.map((enemy) => enemy.kind))).toEqual(
      new Set(["crawler", "brute", "watcher"]),
    );
  });

  test("every carved floor and the exit are connected to the player", () => {
    const game = createGame({ width: 61, height: 25, seed: 9042, enemyCount: 0, itemCount: 0 });
    const reachable = reachableCells(game);
    let floors = 0;
    for (let y = 0; y < game.height; y += 1) {
      for (let x = 0; x < game.width; x += 1) {
        if (game.tileAt(x, y) === "floor") {
          floors += 1;
          expect(reachable.has(`${x},${y}`)).toBe(true);
        }
      }
    }
    expect(floors).toBeGreaterThan(80);
    expect(game.rooms.length).toBeGreaterThan(1);
    expect(reachable.has(`${game.exit.x},${game.exit.y}`)).toBe(true);
  });
});

describe("turn rules and semantic events", () => {
  test("wall bumps do not consume a turn; melee kills and advances into the cell", () => {
    const game = createGameFromAscii([
      "########",
      "#@c..>.#",
      "########",
    ]);

    const blocked = game.step("up");
    expect(blocked.consumedTurn).toBe(false);
    expect(blocked.turn).toBe(0);
    expect(blocked.events).toContainEqual({
      type: "blocked",
      actorId: "player",
      at: { x: 1, y: 0 },
      reason: "wall",
    });

    const combat = game.step("right");
    expect(combat.consumedTurn).toBe(true);
    expect(game.player).toMatchObject({ x: 2, y: 1 });
    expect(game.enemies).toHaveLength(0);
    expect(combat.events.slice(0, 4).map((event) => event.type)).toEqual([
      "attack",
      "damage",
      "death",
      "move",
    ]);
  });

  test("items apply immediately and pulse emits animation-ready combat events", () => {
    const game = createGameFromAscii(
      [
        "#########",
        "#@!*..c>#",
        "#########",
      ],
      { pulseRadius: 3, playerAttack: 3 },
    );

    game.step("right");
    expect(game.items.some((item) => item.kind === "battery")).toBe(false);
    game.step("right");
    expect(game.player.relics).toBe(1);
    expect(game.player.score).toBe(100);

    const pulse = game.step("pulse");
    expect(pulse.events[0]).toEqual({ type: "pulse", at: { x: 3, y: 1 }, radius: 3 });
    expect(pulse.events.some((event) => event.type === "attack" && event.mode === "pulse")).toBe(true);
    expect(game.enemies).toHaveLength(0);
  });

  test("crawler pursues, watcher fires a beam, and brute attacks on contact", () => {
    const pursuit = createGameFromAscii([
      "#########",
      "#@..c..>#",
      "#.......#",
      "#########",
    ]);
    const before = { ...pursuit.enemies[0] };
    const turn = pursuit.step("wait");
    expect(turn.events).toContainEqual({
      type: "move",
      actor: "enemy",
      actorId: "enemy-1",
      from: { x: before.x, y: before.y },
      to: { x: before.x - 1, y: before.y },
    });

    const beam = createGameFromAscii([
      "#########",
      "#@...w.>#",
      "#########",
    ]);
    const beamTurn = beam.step("wait");
    expect(beamTurn.events.some((event) => event.type === "attack" && event.mode === "beam")).toBe(true);
    expect(beam.player.hp).toBe(beam.player.maxHp - 1);

    const brute = createGameFromAscii([
      "######",
      "#@b.>#",
      "######",
    ]);
    brute.step("wait");
    expect(brute.player.hp).toBe(brute.player.maxHp - 2);
  });

  test("reaching the exit wins; death locks turns until deterministic restart", () => {
    const victory = createGameFromAscii([
      "#####",
      "#@>.#",
      "#####",
    ]);
    const won = victory.step("right");
    expect(won.phase).toBe("won");
    expect(won.events.some((event) => event.type === "win")).toBe(true);
    expect(victory.step("left").consumedTurn).toBe(false);

    const doomed = createGameFromAscii(
      [
        "######",
        "#@b.>#",
        "######",
      ],
      { playerMaxHp: 4, seed: "loop" },
    );
    doomed.step("wait");
    const death = doomed.step("wait");
    expect(death.phase).toBe("dead");
    expect(death.events.map((event) => event.type)).toContain("game-over");

    const restarted = doomed.step("restart");
    expect(restarted.phase).toBe("playing");
    expect(restarted.turn).toBe(0);
    expect(doomed.player).toMatchObject({ x: 1, y: 1, hp: 4 });
    expect(doomed.enemies).toHaveLength(1);
    expect(restarted.events[0]).toEqual({ type: "restart", seed: "loop" });
  });
});

describe("field of view and exploration", () => {
  test("visibility moves with the player while explored cells persist", () => {
    const game = createGameFromAscii(
      [
        "#####################",
        "#@...............>..#",
        "#####################",
      ],
      { fovRadius: 3 },
    );
    expect(game.isVisible(1, 1)).toBe(true);
    expect(game.isVisible(8, 1)).toBe(false);

    let revealCount = 0;
    for (let step = 0; step < 6; step += 1) {
      const result = game.step("right");
      revealCount += result.events
        .filter((event) => event.type === "reveal")
        .reduce((count, event) => count + event.cells.length, 0);
    }

    expect(game.isVisible(1, 1)).toBe(false);
    expect(game.isExplored(1, 1)).toBe(true);
    expect(game.isVisible(9, 1)).toBe(true);
    expect(revealCount).toBeGreaterThan(0);
  });
});

function reachableCells(game: RoguelikeGame): Set<string> {
  const found = new Set([`${game.player.x},${game.player.y}`]);
  const queue = [{ x: game.player.x, y: game.player.y }];
  const directions: readonly Direction[] = ["up", "down", "left", "right"];
  const deltas = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0],
  } as const;
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const direction of directions) {
      const [dx, dy] = deltas[direction];
      const x = current.x + dx;
      const y = current.y + dy;
      const key = `${x},${y}`;
      if (!found.has(key) && game.isWalkable(x, y)) {
        found.add(key);
        queue.push({ x, y });
      }
    }
  }
  return found;
}
