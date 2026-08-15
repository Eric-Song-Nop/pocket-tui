// @ts-nocheck -- Bun supplies the bun:test module at test runtime.
import { describe, expect, test } from "bun:test";
import type {
  CanvasFrame,
  CursorPacketOptions,
  TuiInputEvent,
  TuiViewportSize,
} from "@pocket-tui/core";

import { createPocketTuiHost, type PocketTuiSurface } from "../src/index.js";
import { ENUM, NODE, PROP, ROOT_ID } from "../src/spec.js";

const SLOT_COLUMNS = 28;
const SLOT_ROWS = 16;
const SLOT_COUNT = SLOT_COLUMNS * SLOT_ROWS;
const MUTATIONS_PER_FRAME = 8;
const FRAMES = 32;

class RecordingSurface implements PocketTuiSurface {
  constructor(public size: TuiViewportSize = { columns: 116, rows: 34 }) {}

  viewportSize(): TuiViewportSize {
    return this.size;
  }

  present(_frame: CanvasFrame): void {}

  setCursor(_options: CursorPacketOptions): void {}

  pollInput(): TuiInputEvent[] {
    return [];
  }

  start(): void {}

  flush(): void {}

  close(): void {}
}

describe("PocketJS retained paint-index workload", () => {
  test("keeps eight updates in a 448-slot scene below one quarter of full work", () => {
    const surface = new RecordingSurface();
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const slots = Array.from({ length: SLOT_COUNT }, (_, index) => {
      const slot = host.ops.createNode(NODE.view);
      host.ops.insertBefore(ROOT_ID, slot, 0);
      host.ops.setProp(slot, PROP.posType, ENUM.absolute);
      host.ops.setProp(slot, PROP.insetL, (index % SLOT_COLUMNS) * 4);
      host.ops.setProp(slot, PROP.insetT, Math.floor(index / SLOT_COLUMNS) * 2);
      host.ops.setProp(slot, PROP.width, 3);
      host.ops.setProp(slot, PROP.height, 1);
      host.ops.setProp(slot, PROP.bgColor, 0xff10_2030 + index);
      return slot;
    });

    host.render();
    const mounted = host.diagnostics;
    const fullIndexNodes = mounted.lastPaintIndexNodes;
    const fullRasterCandidates = mounted.lastRasterCandidates;
    expect(mounted).toMatchObject({
      liveNodes: SLOT_COUNT + 1,
      fullPaintIndexFrames: 1,
      incrementalPaintIndexFrames: 0,
      reusedPaintIndexFrames: 0,
      lastPaintIndexNodes: SLOT_COUNT + 1,
      lastPaintIndexRoots: 1,
      lastRasterCandidates: SLOT_COUNT,
    });

    for (let frame = 0; frame < FRAMES; frame += 1) {
      const row = frame % SLOT_ROWS;
      const offset = (frame * MUTATIONS_PER_FRAME) % SLOT_COLUMNS;
      for (let mutation = 0; mutation < MUTATIONS_PER_FRAME; mutation += 1) {
        const column = (offset + mutation) % SLOT_COLUMNS;
        const slot = slots[row * SLOT_COLUMNS + column]!;
        host.ops.setProp(
          slot,
          PROP.bgColor,
          0xff00_0000 + ((frame + 1) << 12) + (mutation << 4) + column,
        );
      }

      host.render();
      const diagnostics = host.diagnostics;
      expect(diagnostics.fullPaintIndexFrames).toBe(1);
      expect(diagnostics.incrementalPaintIndexFrames).toBe(frame + 1);
      expect(diagnostics.reusedPaintIndexFrames).toBe(0);
      expect(diagnostics.lastPaintIndexNodes).toBe(MUTATIONS_PER_FRAME);
      expect(diagnostics.lastPaintIndexRoots).toBe(MUTATIONS_PER_FRAME);
      expect(diagnostics.lastPaintIndexNodes).toBeLessThan(fullIndexNodes * 0.25);
      expect(diagnostics.lastRasterCandidates).toBe(SLOT_COLUMNS);
      expect(diagnostics.lastRasterCandidates).toBeLessThan(fullRasterCandidates * 0.25);
    }

    const after = host.diagnostics;
    const incrementalIndexNodes = after.paintIndexNodes - mounted.paintIndexNodes;
    const incrementalRasterCandidates = after.rasterCandidates - mounted.rasterCandidates;
    expect(incrementalIndexNodes).toBe(FRAMES * MUTATIONS_PER_FRAME);
    expect(incrementalIndexNodes).toBeLessThan(FRAMES * fullIndexNodes * 0.25);
    expect(incrementalRasterCandidates).toBe(FRAMES * SLOT_COLUMNS);
    expect(incrementalRasterCandidates).toBeLessThan(
      FRAMES * fullRasterCandidates * 0.25,
    );
    expect(after.fullRasterFrames).toBe(1);
    expect(after.incrementalRasterFrames).toBe(FRAMES);
  });
});
