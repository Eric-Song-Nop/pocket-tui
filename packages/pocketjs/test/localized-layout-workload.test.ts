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

const VIEWPORT = { columns: 108, rows: 38 } as const;
const SLOT_COUNT = 448;
const TRANSITION_SLOT_COUNT = 190;
const ACTIVE_FRAME_COUNT = 22;
const ACTIVE_SLOTS_PER_FRAME = 8;

class WorkloadSurface implements PocketTuiSurface {
  size: TuiViewportSize = VIEWPORT;
  lastFrame: CanvasFrame | undefined;

  viewportSize(): TuiViewportSize {
    return this.size;
  }

  present(frame: CanvasFrame): void {
    this.lastFrame = frame;
  }

  setCursor(_options: CursorPacketOptions): void {}

  pollInput(): TuiInputEvent[] {
    return [];
  }

  start(): void {}

  flush(): void {}

  close(): void {}
}

describe("PocketJS localized layout workloads", () => {
  test("keeps a RULE//SHIFT-shaped absolute slot pool off the full-layout path", () => {
    const surface = new WorkloadSurface();
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    const layer = host.ops.createNode(NODE.view);
    host.ops.insertBefore(ROOT_ID, layer, 0);
    host.ops.setProp(layer, PROP.width, VIEWPORT.columns);
    host.ops.setProp(layer, PROP.height, VIEWPORT.rows);

    // RULE//SHIFT keeps a bounded pool of 448 absolute text slots. Pocket's
    // renderer stores the text value in an unlaid child node, so mutations
    // originate below the absolute boundary instead of on its LayoutEntry.
    const slots = Array.from({ length: SLOT_COUNT }, (_, index) => {
      const slot = host.ops.createNode(NODE.text);
      const content = host.ops.createNode(NODE.text);
      host.ops.insertBefore(layer, slot, 0);
      host.ops.insertBefore(slot, content, 0);
      host.ops.setProp(slot, PROP.posType, ENUM.absolute);
      host.ops.setProp(slot, PROP.insetL, index % (VIEWPORT.columns - 4));
      host.ops.setProp(slot, PROP.insetT, index % VIEWPORT.rows);
      host.ops.setProp(slot, PROP.width, 2);
      host.ops.setProp(slot, PROP.height, 1);
      host.ops.setProp(
        slot,
        PROP.display,
        index < SLOT_COUNT - TRANSITION_SLOT_COUNT ? ENUM.displayFlex : ENUM.displayNone,
      );
      host.ops.setText(content, `${index % 10}`);
      return { slot, content };
    });

    host.render();
    const mounted = host.diagnostics;
    const initialFullNodeCount = mounted.lastLayoutNodes;
    expect(mounted).toMatchObject({
      fullLayoutFrames: 1,
      localizedLayoutFrames: 0,
      lastRelayoutRoots: 1,
      lastLayoutNodes: SLOT_COUNT + 2,
    });

    // Model the largest measured level transition: 190 pooled slots change
    // text and geometry in one reactive batch, including hidden/visible reuse.
    mutateSlots(host, slots, range(0, TRANSITION_SLOT_COUNT), 1, true);
    host.render();
    expect(host.diagnostics).toMatchObject({
      fullLayoutFrames: mounted.fullLayoutFrames,
      localizedLayoutFrames: mounted.localizedLayoutFrames + 1,
      lastLayoutNodes: TRANSITION_SLOT_COUNT,
      lastRelayoutRoots: TRANSITION_SLOT_COUNT,
    });

    // Typical animation frames touch only a small subset of the retained
    // pool. Twenty-two frames approximates the measured demo sequence while
    // keeping this regression deterministic and fast.
    for (let frame = 0; frame < ACTIVE_FRAME_COUNT; frame += 1) {
      const selected = Array.from(
        { length: ACTIVE_SLOTS_PER_FRAME },
        (_, offset) => (TRANSITION_SLOT_COUNT + frame * 17 + offset * 29) % SLOT_COUNT,
      );
      expect(new Set(selected).size).toBe(ACTIVE_SLOTS_PER_FRAME);
      mutateSlots(host, slots, selected, frame + 2, false);
      host.render();
      expect(host.diagnostics.fullLayoutFrames).toBe(mounted.fullLayoutFrames);
      expect(host.diagnostics.lastLayoutNodes).toBe(ACTIVE_SLOTS_PER_FRAME);
      expect(host.diagnostics.lastRelayoutRoots).toBe(ACTIVE_SLOTS_PER_FRAME);
    }

    const active = host.diagnostics;
    const localizedFrames = active.localizedLayoutFrames - mounted.localizedLayoutFrames;
    const localizedNodes = active.layoutNodes - mounted.layoutNodes;
    expect(localizedFrames).toBe(ACTIVE_FRAME_COUNT + 1);
    expect(localizedNodes).toBe(
      TRANSITION_SLOT_COUNT + ACTIVE_FRAME_COUNT * ACTIVE_SLOTS_PER_FRAME,
    );
    expect(localizedNodes / (localizedFrames * initialFullNodeCount)).toBeLessThan(0.25);
    expect(active.fullLayoutFrames).toBe(mounted.fullLayoutFrames);
    expect(active.localizedLayoutFrames).toBeGreaterThan(mounted.localizedLayoutFrames);

    const beforeResize = host.diagnostics;
    surface.size = { columns: 96, rows: 34 };
    host.resize(surface.size.columns, surface.size.rows);
    host.render();
    expect(host.diagnostics).toMatchObject({
      fullLayoutFrames: beforeResize.fullLayoutFrames + 1,
      localizedLayoutFrames: beforeResize.localizedLayoutFrames,
      lastRelayoutRoots: 1,
      lastLayoutNodes: initialFullNodeCount,
    });
    expect(surface.lastFrame).toMatchObject({ width: 96, height: 34 });
  });
});

function mutateSlots(
  host: ReturnType<typeof createPocketTuiHost>,
  slots: readonly { readonly slot: number; readonly content: number }[],
  selected: readonly number[],
  revision: number,
  transition: boolean,
): void {
  for (const index of selected) {
    const { slot, content } = slots[index]!;
    host.ops.setText(content, `${revision.toString(36)}${index.toString(36)}`);
    host.ops.setProp(slot, PROP.insetL, (index * 7 + revision * 3) % (VIEWPORT.columns - 6));
    host.ops.setProp(slot, PROP.insetT, (index * 5 + revision) % VIEWPORT.rows);
    host.ops.setProp(slot, PROP.width, 2 + ((index + revision) % 4));
    if (transition) {
      host.ops.setProp(
        slot,
        PROP.display,
        index % 3 === 0 ? ENUM.displayNone : ENUM.displayFlex,
      );
    }
  }
}

function range(start: number, length: number): number[] {
  return Array.from({ length }, (_, offset) => start + offset);
}
