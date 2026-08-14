// @ts-nocheck -- Bun supplies this test-only module at runtime.
import { describe, expect, test } from "bun:test";

import { createGameFromAscii } from "./game.js";
import {
  ECHO_DURATIONS,
  PRESENTATION_TOKENS,
  computePresentationLayout,
  present,
  sampleEchoRing,
  sampleEchoTimeline,
  scheduleEchoTimeline,
} from "./presentation.js";

describe("hydrophone presentation tokens and layout", () => {
  test("defines the deliberate six-color RGB palette with ANSI fallbacks", () => {
    expect(Object.keys(PRESENTATION_TOKENS)).toEqual([
      "abyss",
      "silt",
      "bone",
      "verdigris",
      "bruise",
      "flare",
    ]);
    expect(PRESENTATION_TOKENS.abyss).toEqual({
      rgb: { red: 0x07, green: 0x10, blue: 0x14 },
      ansi: 0,
    });
    expect(PRESENTATION_TOKENS.verdigris.ansi).toBe(14);
    expect(PRESENTATION_TOKENS.flare.rgb).toEqual({ red: 0xff, green: 0x71, blue: 0x5b });
  });

  test("wide mode reserves a receiver rail while compact mode folds it into telemetry", () => {
    const wide = computePresentationLayout({ columns: 96, rows: 30 });
    expect(wide.mode).toBe("wide");
    expect(wide.receiver).not.toBeNull();
    expect(wide.field.column + wide.field.width).toBeLessThan(wide.receiver.column);
    expect(wide.command.row).toBe(29);

    const compact = computePresentationLayout({ columns: 52, rows: 20 });
    expect(compact.mode).toBe("compact");
    expect(compact.receiver).toBeNull();
    expect(compact.field.width).toBe(52);
    expect(compact.field.row + compact.field.height).toBeLessThan(compact.trace.row);
    expect(compact.command.row).toBe(19);
  });

  test("keeps the 68-cell demo field continuous across responsive thresholds", () => {
    const at71 = computePresentationLayout({ columns: 71, rows: 30 });
    const at72 = computePresentationLayout({ columns: 72, rows: 30 });
    expect(at71.mode).toBe("compact");
    expect(at72.mode).toBe("compact");
    expect(at72.field.width).toBe(at71.field.width + 1);

    const mapRow = `#@${".".repeat(64)}>#`;
    const game = createGameFromAscii([
      "#".repeat(68),
      mapRow,
      `#${".".repeat(66)}#`,
      "#".repeat(68),
    ], { fovRadius: 68, seed: "layout-threshold" });
    const timeline = scheduleEchoTimeline([], 0);
    const before = present(game, timeline, { columns: 91, rows: 30 }, 0);
    const after = present(game, timeline, { columns: 92, rows: 30 }, 0);
    expect(before.layout.mode).toBe("compact");
    expect(after.layout.mode).toBe("wide");
    expect(after.layout.field.width).toBeGreaterThanOrEqual(game.width);
    expect(after.projection.width).toBe(before.projection.width);
  });

  test("keeps every compact scene primitive legal in tiny viewports", () => {
    const game = createGameFromAscii([
      "#####",
      "#@.>#",
      "#####",
    ]);
    const timeline = scheduleEchoTimeline([], 0);

    for (const columns of [1, 2, 4, 8, 20]) {
      for (let rows = 1; rows <= 8; rows += 1) {
        const scene = present(game, timeline, { columns, rows }, 0);
        expect(scene.layout.mode).toBe("compact");
        for (const candidate of [
          scene.layout.viewport,
          scene.layout.topline,
          scene.layout.field,
          scene.layout.trace,
          scene.layout.command,
          ...scene.panels.map((panel) => panel.rect),
        ]) {
          expect(candidate.column).toBeGreaterThanOrEqual(0);
          expect(candidate.row).toBeGreaterThanOrEqual(0);
          expect(candidate.width).toBeGreaterThanOrEqual(0);
          expect(candidate.height).toBeGreaterThanOrEqual(0);
          expect(candidate.column + candidate.width).toBeLessThanOrEqual(columns);
          expect(candidate.row + candidate.height).toBeLessThanOrEqual(rows);
        }
        for (const cell of scene.cells) {
          expect(cell.column).toBeGreaterThanOrEqual(0);
          expect(cell.column).toBeLessThan(columns);
          expect(cell.row).toBeGreaterThanOrEqual(0);
          expect(cell.row).toBeLessThan(rows);
        }
        for (const panel of scene.panels) {
          for (const text of panel.texts) {
            expect(text.column).toBeGreaterThanOrEqual(0);
            expect(text.column + [...text.text].length).toBeLessThanOrEqual(columns);
            expect(text.row).toBeGreaterThanOrEqual(0);
            expect(text.row).toBeLessThan(rows);
          }
          for (const rule of panel.rules) {
            expect(rule.column).toBeGreaterThanOrEqual(0);
            expect(rule.row).toBeGreaterThanOrEqual(0);
            if (rule.orientation === "horizontal") {
              expect(rule.column + rule.length).toBeLessThanOrEqual(columns);
              expect(rule.row).toBeLessThan(rows);
            } else {
              expect(rule.column).toBeLessThan(columns);
              expect(rule.row + rule.length).toBeLessThanOrEqual(rows);
            }
          }
        }
        expect(scene.cursor.column).toBeGreaterThanOrEqual(0);
        expect(scene.cursor.column).toBeLessThan(columns);
        expect(scene.cursor.row).toBeGreaterThanOrEqual(0);
        expect(scene.cursor.row).toBeLessThan(rows);
      }
    }
  });
});

describe("echo geometry and compositing", () => {
  test("corrects rings for cells that are twice as tall as they are wide", () => {
    const ring = sampleEchoRing(6);
    const coordinates = new Set(ring.map(({ dx, dy }) => `${dx},${dy}`));
    expect(coordinates.has("6,0")).toBe(true);
    expect(coordinates.has("-6,0")).toBe(true);
    expect(coordinates.has("0,3")).toBe(true);
    expect(coordinates.has("0,-3")).toBe(true);
    expect(coordinates.has("0,6")).toBe(false);
    expect(Math.max(...ring.map(({ dx }) => Math.abs(dx)))).toBe(6);
    expect(Math.max(...ring.map(({ dy }) => Math.abs(dy)))).toBe(3);
  });

  test("effect terrain never replaces actors, even when a pulse begins on the player", () => {
    const game = createGameFromAscii([
      "#########",
      "#.......#",
      "#..@c.>.#",
      "#.......#",
      "#########",
    ]);
    const timeline = scheduleEchoTimeline([
      { type: "pulse", at: { x: game.player.x, y: game.player.y }, radius: 3 },
    ], 1_000);
    const scene = present(game, timeline, { columns: 80, rows: 24 }, 1_000);
    const playerCells = scene.cells.filter(
      (cell) => cell.world.x === game.player.x && cell.world.y === game.player.y,
    );
    expect(playerCells).toHaveLength(1);
    expect(playerCells[0]).toMatchObject({ glyph: "◉", layer: "actor", token: "verdigris" });
    expect(scene.effectSignal).toMatchObject({ kind: "pulse", token: "bruise" });
    expect(scene.cursor.shape).toBe("underline");
  });

  test("sparse terrain and panel slots are deterministic", () => {
    const game = createGameFromAscii([
      "#############",
      "#@.........>#",
      "#...........#",
      "#############",
    ], { fovRadius: 13, seed: "hydrophone" });
    const timeline = scheduleEchoTimeline([], 0);
    const diagnostics = { liveNodes: 42, operations: 7, frameGeneration: 9n };
    const first = present(game, timeline, { columns: 96, rows: 30 }, 0, diagnostics);
    const second = present(game, timeline, { columns: 96, rows: 30 }, 0, diagnostics);
    expect(first).toEqual(second);
    expect(first.cells.filter((cell) => cell.layer === "terrain").length).toBeLessThan(
      game.width * game.height,
    );
    const receiver = first.panels.find((panel) => panel.id === "receiver");
    expect(receiver?.texts.find((text) => text.id === "receiver.host-link")?.text).toBe(
      "HOST LINK N42 O7 G9",
    );

    const compact = present(game, timeline, { columns: 52, rows: 20 }, 0);
    expect(compact.layout.mode).toBe("compact");
    expect(compact.panels.find((panel) => panel.id === "receiver")?.texts[0]?.id).toBe(
      "receiver.compact",
    );
  });
});

describe("semantic event choreography", () => {
  test("schedules every visual event class with stable timing", () => {
    const events = [
      { type: "move", actor: "player", actorId: "player", from: { x: 1, y: 1 }, to: { x: 2, y: 1 } },
      { type: "attack", attackerId: "player", targetId: "enemy-1", mode: "melee", from: { x: 2, y: 1 }, to: { x: 3, y: 1 } },
      { type: "attack", attackerId: "enemy-2", targetId: "player", mode: "beam", from: { x: 8, y: 1 }, to: { x: 2, y: 1 } },
      { type: "pulse", at: { x: 2, y: 1 }, radius: 3 },
      { type: "pickup", itemId: "item-1", item: "battery", at: { x: 2, y: 1 }, amount: 3 },
      { type: "damage", targetId: "player", amount: 1, hp: 9, at: { x: 2, y: 1 } },
      { type: "death", actor: "enemy", actorId: "enemy-1", at: { x: 3, y: 1 } },
      { type: "win", at: { x: 9, y: 1 }, turn: 12 },
    ];
    const timeline = scheduleEchoTimeline(events, 5_000);
    expect(timeline.cues.map((entry) => entry.kind)).toEqual([
      "move",
      "melee",
      "beam",
      "pulse",
      "pickup",
      "damage",
      "death",
      "win",
    ]);
    for (const entry of timeline.cues) {
      expect(entry.durationMs).toBe(ECHO_DURATIONS[entry.kind]);
      expect(entry.startsAt).toBeGreaterThanOrEqual(5_000);
    }
    expect(timeline.trace).toEqual([
      "charge / +3",
      "hull −1 / impact",
      "contact / extinguished",
      "carrier lock / true",
    ]);
    expect(scheduleEchoTimeline(events, 5_000)).toEqual(timeline);
  });

  test("timeline sampling is bounded and deterministic", () => {
    const timeline = scheduleEchoTimeline([
      { type: "move", actor: "player", actorId: "player", from: { x: 1, y: 1 }, to: { x: 2, y: 1 } },
      { type: "damage", targetId: "player", amount: 2, hp: 4, at: { x: 2, y: 1 } },
    ], 200);
    expect(sampleEchoTimeline(timeline, 199)).toEqual([]);
    const active = sampleEchoTimeline(timeline, 270);
    expect(active.map((entry) => entry.kind)).toEqual(["move", "damage"]);
    expect(active.every((entry) => entry.progress >= 0 && entry.progress < 1)).toBe(true);
    expect(sampleEchoTimeline(timeline, 200 + timeline.durationMs)).toEqual([]);
  });
});
