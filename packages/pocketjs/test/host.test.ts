// @ts-nocheck -- Bun supplies the bun:test module at test runtime.
import { describe, expect, test } from "bun:test";
import type {
  CanvasFrame,
  CursorPacketOptions,
  EffectBusFrame,
  TuiInputEvent,
  TuiViewportSize,
} from "@pocket-tui/core";

import {
  createPocketTuiHost,
  createElement,
  createSignal,
  createTextNode,
  effect,
  type HostOps,
  insertNode,
  mountPocketTui,
  onButtonPress,
  POCKET_BUTTON,
  replaceText,
  setProp,
  simulationHz,
  type PocketTuiSurface,
  virtualNow,
} from "../src/index.js";
import {
  ENUM,
  ID_SLOT_MASK,
  NODE,
  PROP,
  ROOT_ID,
  STYLE_ACTIVE,
  STYLE_BASE,
  STYLE_FOCUS,
  STYLE_HEADER_BYTES,
  STYLE_MAGIC,
  STYLE_VERSION,
} from "../src/spec.js";

class FakeSurface implements PocketTuiSurface {
  readonly frames: CanvasFrame[] = [];
  readonly inputs: TuiInputEvent[] = [];
  readonly cursors: CursorPacketOptions[] = [];
  started = 0;
  flushed = 0;
  closed = 0;

  constructor(public size: TuiViewportSize = { columns: 24, rows: 10 }) {}

  viewportSize(): TuiViewportSize {
    return this.size;
  }

  present(frame: CanvasFrame): void {
    this.frames.push(frame);
  }

  setCursor(options: CursorPacketOptions): void {
    this.cursors.push(options);
  }

  pollInput(): TuiInputEvent[] {
    return this.inputs.splice(0);
  }

  start(): void {
    this.started += 1;
  }

  flush(): void {
    this.flushed += 1;
  }

  close(): void {
    this.closed += 1;
  }
}

class EffectSurface extends FakeSurface {
  readonly effects: EffectBusFrame[] = [];
  cleared = 0;

  setEffectBus(frame: EffectBusFrame): void {
    this.effects.push(frame);
  }

  clearEffectBus(): void {
    this.cleared += 1;
  }
}

describe("PocketJS HostOps retained contract", () => {
  test("implements the pinned HostOps type and DOM move/detach/destroy semantics", () => {
    const surface = new FakeSurface();
    const host = createPocketTuiHost({ surface });
    const ops: HostOps = host.ops;
    const left = ops.createNode(NODE.view);
    const right = ops.createNode(NODE.view);
    const child = ops.createNode(NODE.text);

    ops.insertBefore(ROOT_ID, left, 0);
    ops.insertBefore(ROOT_ID, right, 0);
    ops.insertBefore(left, child, 0);
    ops.removeChild(left, child);
    expect(host.snapshot().find((node) => node.id === child)?.parent).toBeNull();

    ops.insertBefore(right, child, 0);
    expect(host.snapshot().find((node) => node.id === child)?.parent).toBe(right);
    ops.insertBefore(left, child, 0);
    expect(host.snapshot().find((node) => node.id === child)?.parent).toBe(left);

    ops.destroyNode(child);
    const reused = ops.createNode(NODE.text);
    expect(reused & ID_SLOT_MASK).toBe(child & ID_SLOT_MASK);
    expect(reused).not.toBe(child);
    expect(() => ops.setText(child, "stale")).toThrow(/stale/);
    expect(host.diagnostics.liveNodes).toBe(4);
  });

  test("lays out cell flex and absolute children and rasterizes ABGR styles", () => {
    const surface = new FakeSurface({ columns: 20, rows: 8 });
    const { ops, render, snapshot } = hostMethods(
      createPocketTuiHost({ surface, colorMode: "truecolor" }),
    );
    const panel = ops.createNode(NODE.view);
    const title = ops.createNode(NODE.text);
    const badge = ops.createNode(NODE.text);
    ops.insertBefore(ROOT_ID, panel, 0);
    ops.insertBefore(panel, title, 0);
    ops.insertBefore(panel, badge, 0);
    ops.setText(title, "Pocket");
    ops.setText(badge, "JS");

    ops.setProp(panel, PROP.width, 20);
    ops.setProp(panel, PROP.height, 8);
    ops.setProp(panel, PROP.flexDir, ENUM.flexRow);
    ops.setProp(panel, PROP.gap, 1);
    ops.setProp(panel, PROP.paddingL, 1);
    ops.setProp(panel, PROP.paddingT, 1);
    ops.setProp(panel, PROP.bgColor, 0xff20_1810);
    ops.setProp(panel, PROP.borderColor, 0xffff_8844);
    ops.setProp(panel, PROP.borderWidth, 1);
    ops.setProp(title, PROP.textColor, 0xff00_88ff);
    ops.setProp(badge, PROP.posType, ENUM.absolute);
    ops.setProp(badge, PROP.insetR, 1);
    ops.setProp(badge, PROP.insetB, 1);
    ops.setProp(badge, PROP.textColor, 0xff44_ff44);

    const frame = render();
    expect(frame.width).toBe(20);
    expect(frame.height).toBe(8);
    expect(frameText(frame)).toContain("Pocket");
    expect(frameText(frame)).toContain("JS");
    const titleRun = frame.runs.find((run) => run.text.includes("Pocket"));
    expect(titleRun?.style?.foreground).toEqual({ kind: "rgb", red: 255, green: 136, blue: 0 });
    const badgeRect = snapshot().find((node) => node.id === badge)?.rect;
    expect(badgeRect?.x).toBe(17);
    expect(badgeRect?.y).toBe(6);
  });

  test("supports indexed ANSI16 and preserves RGB in truecolor mode", () => {
    const renderColor = (colorMode: "ansi16" | "truecolor") => {
      const host = createPocketTuiHost({
        surface: new FakeSurface({ columns: 4, rows: 1 }),
        colorMode,
      });
      const text = host.ops.createNode(NODE.text);
      host.ops.insertBefore(ROOT_ID, text, 0);
      host.ops.setText(text, "X");
      host.ops.setProp(text, PROP.textColor, 0xff31_31cd);
      return host.render().runs.find((run) => run.text === "X")?.style?.foreground;
    };

    expect(renderColor("ansi16")).toEqual({ kind: "indexed", index: 1 });
    expect(renderColor("truecolor")).toEqual({ kind: "rgb", red: 205, green: 49, blue: 49 });
  });

  test("loads PocketJS v2 base/focus style variants and collapses animation to its endpoint", () => {
    const surface = new FakeSurface({ columns: 12, rows: 3 });
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    host.ops.loadStyles?.(styleTable());
    const text = host.ops.createNode(NODE.text);
    host.ops.insertBefore(ROOT_ID, text, 0);
    host.ops.setText(text, "focus");
    host.ops.setStyle(text, 0);
    host.ops.setFocus(text);

    let frame = host.render();
    expect(frame.runs.find((run) => run.text === "focus")?.style?.foreground).toEqual({
      kind: "rgb",
      red: 0,
      green: 255,
      blue: 0,
    });

    const animation = host.ops.animate(text, PROP.textColor, 0xffff_0000, 250, 0, 0);
    expect(animation).toBeGreaterThan(0);
    frame = host.render();
    expect(frame.runs.find((run) => run.text === "focus")?.style?.foreground).toEqual({
      kind: "rgb",
      red: 0,
      green: 0,
      blue: 255,
    });
    expect(host.diagnostics.collapsedAnimations).toBe(1);
  });

  test("degrades texture/image operations explicitly and exposes stable telemetry", () => {
    const surface = new FakeSurface();
    const host = createPocketTuiHost({ surface });
    const image = host.ops.createNode(NODE.image);
    host.ops.insertBefore(ROOT_ID, image, 0);
    const texture = host.ops.uploadTexture(new Uint8Array(16), 2, 2, 3);
    expect(texture).toBe(-1);
    host.ops.setImage(image, 7);
    host.render();
    host.render();
    expect(host.diagnostics).toMatchObject({
      liveNodes: 2,
      renderedFrames: 1,
      skippedFrames: 1,
      unsupportedTextures: 1,
      unsupportedImages: 1,
    });
    expect(host.diagnostics.lastRunCount).toBeGreaterThan(0);
  });

  test("forwards the typed effect bus and rejects surfaces without that capability", () => {
    const surface = new EffectSurface();
    const host = createPocketTuiHost({ surface });
    const frame = {
      trigger: true,
      channels: [
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
      ],
    } as const;
    host.setEffectBus(frame);
    host.clearEffectBus();
    expect(surface.effects).toEqual([frame]);
    expect(surface.cleared).toBe(1);

    const unsupported = createPocketTuiHost({ surface: new FakeSurface() });
    expect(() => unsupported.setEffectBus(frame)).toThrow(/does not support an effect bus/);
  });
});

describe("PocketTUI session drives the real PocketJS frame lifecycle", () => {
  test("latches pump fps as Pocket virtual time and accepts exact simulation divisors", async () => {
    const surface = new FakeSurface({ columns: 12, rows: 3 });
    const previousPolicy = globalThis.__simHz;
    globalThis.__simHz = 12;
    const session = await mountPocketTui(() => createElement("view"), { surface, fps: 30 });

    expect(simulationHz()).toBe(30);
    expect(globalThis.__simHz).toBe(12);
    for (let frame = 0; frame < 31; frame += 1) await session.step();
    expect(virtualNow()).toBeCloseTo(1, 8);
    await session.close();

    if (previousPolicy === undefined) delete globalThis.__simHz;
    else globalThis.__simHz = previousPolicy;
    await expect(
      mountPocketTui(() => createElement("view"), {
        surface: new FakeSurface(),
        fps: 24,
      }),
    ).rejects.toThrow(/fps must be one of/);
  });

  test("rejects concurrent sessions and releases the runtime lease after close", async () => {
    const first = await mountPocketTui(() => createElement("view"), {
      surface: new FakeSurface(),
    });
    const secondSurface = new FakeSurface();
    await expect(
      mountPocketTui(() => createElement("view"), { surface: secondSurface }),
    ).rejects.toThrow(/one active session/);
    expect(secondSurface.started).toBe(0);
    expect(secondSurface.closed).toBe(0);

    await first.close();
    const second = await mountPocketTui(() => createElement("view"), {
      surface: secondSurface,
    });
    await expect(second.close()).resolves.toBeUndefined();
  });

  test("recovers the global Pocket renderer after a component throws during mount", async () => {
    const failedSurface = new FakeSurface();
    await expect(
      mountPocketTui(
        () => {
          createElement("view");
          throw new Error("component boom");
        },
        { surface: failedSurface },
      ),
    ).rejects.toThrow("component boom");
    expect(failedSurface.closed).toBe(1);

    const recovered = await mountPocketTui(() => createElement("view"), {
      surface: new FakeSurface(),
    });
    await expect(recovered.close()).resolves.toBeUndefined();
  });

  test("clears Pocket pack and class registries between sequential sessions", async () => {
    const styledHost = createPocketTuiHost({ surface: new FakeSurface() });
    styledHost.loadStyles(styleTable());
    const styled = await mountPocketTui(
      () => {
        const node = createElement("text");
        setProp(node, "class", "session-only");
        return node;
      },
      { host: styledHost, pocket: { styles: { "session-only": 0 } } },
    );
    await styled.close();

    const cleanHost = createPocketTuiHost({ surface: new FakeSurface() });
    cleanHost.loadStyles(styleTable());
    await expect(
      mountPocketTui(
        () => {
          const node = createElement("text");
          setProp(node, "class", "session-only");
          return node;
        },
        { host: cleanHost },
      ),
    ).rejects.toThrow(/unknown class/);

    const packedHost = createPocketTuiHost({ surface: new FakeSurface() });
    let firstLoads = 0;
    const firstLoadStyles = packedHost.ops.loadStyles;
    packedHost.ops.loadStyles = (bytes) => {
      firstLoads += 1;
      firstLoadStyles?.(bytes);
    };
    const packed = await mountPocketTui(() => createElement("view"), {
      host: packedHost,
      pocket: { pak: packWithStyles(styleTable()) },
    });
    expect(firstLoads).toBe(1);
    await packed.close();

    const unpackedHost = createPocketTuiHost({ surface: new FakeSurface() });
    let secondLoads = 0;
    const secondLoadStyles = unpackedHost.ops.loadStyles;
    unpackedHost.ops.loadStyles = (bytes) => {
      secondLoads += 1;
      secondLoadStyles?.(bytes);
    };
    const unpacked = await mountPocketTui(() => createElement("view"), {
      host: unpackedHost,
    });
    expect(secondLoads).toBe(0);
    await unpacked.close();
  });

  test("keeps client signals reactive under Bun's default node condition", async () => {
    const surface = new FakeSurface({ columns: 18, rows: 3 });
    let updateLabel: (value: string) => void = () => {};
    const session = await mountPocketTui(
      () => {
        const [label, setLabel] = createSignal("T+0000");
        updateLabel = setLabel;
        const root = createElement("view");
        const text = createTextNode("");
        insertNode(root, text);
        effect<string | undefined>(() => {
          const next = label();
          replaceText(text, next);
          return next;
        });
        return root;
      },
      { surface, colorMode: "truecolor" },
    );

    expect(frameText(session.host.frame)).toContain("T+0000");
    const mutations = session.diagnostics.mutations;
    updateLabel("T+0033");
    await session.step();
    expect(session.diagnostics.mutations).toBeGreaterThan(mutations);
    expect(frameText(session.host.frame)).toContain("T+0033");

    await session.close();
    const afterClose = session.diagnostics.mutations;
    expect(() => updateLabel("T+0066")).not.toThrow();
    expect(session.diagnostics.mutations).toBe(afterClose);
  });

  test("maps terminal keys to press/release frames, resizes, positions cursor, and closes", async () => {
    const surface = new FakeSurface({ columns: 18, rows: 6 });
    let presses = 0;
    const session = await mountPocketTui(
      () => {
        onButtonPress(POCKET_BUTTON.UP, () => {
          presses += 1;
        });
        const root = createElement("view");
        const text = createTextNode("Pocket lifecycle");
        insertNode(root, text, null);
        return root;
      },
      { surface, fps: 60 },
    );

    surface.inputs.push({ kind: "key", key: "arrow-up", ctrl: false, alt: false, shift: false });
    const pressed = await session.step();
    expect(pressed.buttons).toBe(POCKET_BUTTON.UP);
    expect(presses).toBe(1);
    const released = await session.step();
    expect(released.buttons).toBe(0);

    surface.inputs.push({ kind: "key", key: "arrow-up", ctrl: false, alt: false, shift: false });
    await session.step();
    expect(presses).toBe(2);
    surface.inputs.push({ kind: "resize", columns: 30, rows: 12 });
    await session.step();
    expect(session.viewportSize()).toEqual({ columns: 30, rows: 12 });

    session.setCursor({ row: 2, column: 4, visible: true });
    expect(surface.cursors.at(-1)).toMatchObject({ row: 2, column: 4, visible: true });
    session.requestClose();
    await session.close();
    await session.closed;
    expect(surface.started).toBe(1);
    expect(surface.closed).toBe(1);
  });

  test("preserves multi-character text, coalesces directions, and bounds pulses", async () => {
    const surface = new FakeSurface({ columns: 12, rows: 4 });
    const session = await mountPocketTui(() => createElement("view"), { surface });

    for (let index = 0; index < 24; index += 1) {
      surface.inputs.push({
        kind: "key",
        key: index === 23 ? "arrow-down" : "arrow-up",
        ctrl: false,
        alt: false,
        shift: false,
      });
    }
    expect((await session.step()).buttons).toBe(POCKET_BUTTON.DOWN);
    expect((await session.step()).buttons).toBe(0);
    expect((await session.step()).buttons).toBe(0);

    surface.inputs.push({ kind: "text", text: ".q" });
    expect((await session.step()).buttons).toBe(POCKET_BUTTON.SQUARE);
    expect((await session.step()).buttons).toBe(0);
    expect((await session.step()).buttons).toBe(POCKET_BUTTON.SELECT);
    expect((await session.step()).buttons).toBe(0);

    for (let index = 0; index < 24; index += 1) {
      surface.inputs.push({ kind: "text", text: "." });
    }
    const tail: number[] = [];
    for (let frame = 0; frame < 20; frame += 1) tail.push((await session.step()).buttons);
    expect(tail.filter((buttons) => buttons === POCKET_BUTTON.SQUARE)).toHaveLength(8);
    expect(tail.slice(-4)).toEqual([0, 0, 0, 0]);

    await session.close();
  });
});

function hostMethods(host: ReturnType<typeof createPocketTuiHost>) {
  return {
    ops: host.ops,
    render: () => host.render(),
    snapshot: () => host.snapshot(),
  };
}

function frameText(frame: CanvasFrame): string {
  return frame.runs.map((run) => run.text).join("\n");
}

function styleTable(): Uint8Array {
  const bytes = new Uint8Array(STYLE_HEADER_BYTES + 1 + 7 * 2);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, STYLE_MAGIC, true);
  view.setUint16(4, STYLE_VERSION, true);
  view.setUint16(6, 1, true);
  let offset = STYLE_HEADER_BYTES;
  bytes[offset++] = STYLE_BASE | STYLE_FOCUS;
  bytes[offset++] = 1;
  bytes[offset++] = PROP.textColor;
  bytes[offset++] = 0;
  view.setUint32(offset, 0xffff_ffff, true);
  offset += 4;
  bytes[offset++] = 1;
  bytes[offset++] = PROP.textColor;
  bytes[offset++] = 0;
  view.setUint32(offset, 0xff00_ff00, true);
  return bytes;
}

function packWithStyles(styles: Uint8Array): ArrayBuffer {
  const key = new TextEncoder().encode("ui:styles");
  const directoryOffset = 32;
  const namesOffset = directoryOffset + 24;
  const blobOffset = namesOffset + key.byteLength;
  const buffer = new ArrayBuffer(blobOffset + styles.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, 0x4b50_4344, true);
  view.setUint16(4, 1, true);
  view.setUint32(8, 1, true);
  view.setUint32(12, directoryOffset, true);
  view.setUint32(16, namesOffset, true);
  view.setUint32(directoryOffset + 4, blobOffset, true);
  view.setUint32(directoryOffset + 8, styles.byteLength, true);
  view.setUint32(directoryOffset + 12, 0, true);
  view.setUint16(directoryOffset + 16, key.byteLength, true);
  new Uint8Array(buffer).set(key, namesOffset);
  new Uint8Array(buffer).set(styles, blobOffset);
  return buffer;
}
