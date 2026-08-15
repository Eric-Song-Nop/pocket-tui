// @ts-nocheck -- Bun supplies the bun:test module at test runtime.
import { describe, expect, test } from "bun:test";

import type { ComputedStyle, HostNode, LayoutResult, Rect } from "../src/model.js";
import {
  type IndexedRasterRecord,
  rasterize,
  rasterizeIndexed,
} from "../src/raster.js";
import { ENUM, NODE } from "../src/spec.js";

describe("indexed raster", () => {
  test("matches the scene oracle for full and candidate-only dirty-row passes", () => {
    const root = node(1, NODE.view);
    const panel = node(2, NODE.view);
    const label = node(3, NODE.text, "A界B\nCD");
    const image = node(4, NODE.image);
    const overlay = node(5, NODE.view);
    append(root, panel);
    append(panel, label);
    append(root, image);
    append(root, overlay);

    const viewport: Rect = { x: 0, y: 0, width: 9, height: 5 };
    const panelRect: Rect = { x: 1, y: 1, width: 5, height: 3 };
    const labelRect: Rect = { x: 0, y: 1, width: 7, height: 2 };
    const imageRect: Rect = { x: 6, y: 0, width: 2, height: 1 };
    const overlayRect: Rect = { x: 3, y: 2, width: 4, height: 2 };
    const rootStyle = style();
    const panelStyle = style({
      background: 0xff20_4060,
      borderColor: 0xffe0_a020,
      borderWidth: 1,
      opacity: 0.5,
      overflow: ENUM.overflowHidden,
    });
    const labelStyle = style({
      background: 0x8020_80c0,
      opacity: 0.8,
      textColor: 0xffff_ffff,
      tracking: 1,
    });
    const imageStyle = style({ textColor: 0xff40_ff80 });
    const overlayStyle = style({
      background: 0xc0ff_3030,
      opacity: 0.6,
      zIndex: 2,
    });
    const layout: LayoutResult = {
      entries: new Map([
        [root.id, { node: root, rect: viewport, style: rootStyle }],
        [panel.id, { node: panel, rect: panelRect, style: panelStyle }],
        [label.id, { node: label, rect: labelRect, style: labelStyle }],
        [image.id, { node: image, rect: imageRect, style: imageStyle }],
        [overlay.id, { node: overlay, rect: overlayRect, style: overlayStyle }],
      ]),
      flattenedText: new Map([[label.id, label.text]]),
    };

    const records: readonly IndexedRasterRecord[] = [
      record(panel, panelRect, panelStyle, panelRect, 0.5),
      record(label, labelRect, labelStyle, { x: 1, y: 1, width: 5, height: 2 }, 0.4),
      record(image, imageRect, imageStyle, imageRect, 1),
      record(overlay, overlayRect, overlayStyle, overlayRect, 0.6),
    ];
    const paintOrder = [panel.id, label.id, image.id, overlay.id];
    const full = rasterize(root, layout, viewport.width, viewport.height, "truecolor");
    const indexed = rasterizeIndexed(
      { candidates: records, paintOrder },
      viewport.width,
      viewport.height,
      "truecolor",
    );

    expect(indexed).toEqual(full);

    const dirtyRows = new Set([1]);
    const incrementalOracle = rasterize(
      root,
      layout,
      viewport.width,
      viewport.height,
      "truecolor",
      { previousFrame: full.frame, dirtyRows },
    );
    const incrementalIndexed = rasterizeIndexed(
      { candidates: records.slice(0, 2), paintOrder },
      viewport.width,
      viewport.height,
      "truecolor",
      { previousFrame: full.frame, dirtyRows },
    );

    expect(incrementalIndexed).toEqual(incrementalOracle);
    expect(incrementalIndexed.paintOrder).toEqual(paintOrder);
  });
});

function node(id: number, type: number, text = ""): HostNode {
  return {
    id,
    type,
    layoutRevision: 0,
    parent: null,
    children: [],
    text,
    styleId: -1,
    inline: new Map(),
    active: false,
    image: 0,
  };
}

function append(parent: HostNode, child: HostNode): void {
  parent.children.push(child);
  child.parent = parent;
}

function record(
  target: HostNode,
  rect: Rect,
  computed: ComputedStyle,
  clip: Rect,
  opacity: number,
): IndexedRasterRecord {
  return {
    id: target.id,
    type: target.type,
    rect,
    style: computed,
    text: target.type === NODE.text ? target.text : undefined,
    clip,
    opacity,
  };
}

function style(overrides: Partial<ComputedStyle> = {}): ComputedStyle {
  return {
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    gap: 0,
    flexDirection: ENUM.flexColumn,
    justify: ENUM.justifyStart,
    align: ENUM.alignStart,
    grow: 0,
    shrink: 1,
    position: ENUM.relative,
    inset: {},
    display: ENUM.displayFlex,
    overflow: ENUM.overflowVisible,
    zIndex: 0,
    background: 0,
    opacity: 1,
    borderColor: 0,
    borderWidth: 0,
    textColor: 0xffff_ffff,
    textAlign: ENUM.textLeft,
    tracking: 0,
    ...overrides,
  };
}
