// @ts-nocheck -- Bun supplies the bun:test module at test runtime.
import { describe, expect, test } from "bun:test";
import type {
  CanvasFrame,
  CursorPacketOptions,
  TuiInputEvent,
  TuiViewportSize,
} from "@pocket-tui/core";

import {
  Button,
  Checkbox,
  createElement,
  createSignal,
  focusNode,
  getFocused,
  insertNode,
  mountPocketTui,
  POCKET_BUTTON,
  pushFocusGrid,
  pushFocusScope,
  TextInput,
  type NodeMirror,
  type PocketTuiSession,
  type PocketTuiSurface,
  type TextInputHandle,
} from "../src/index.js";

class FakeSurface implements PocketTuiSurface {
  readonly frames: CanvasFrame[] = [];
  readonly inputs: TuiInputEvent[] = [];
  readonly cursors: CursorPacketOptions[] = [];
  started = 0;
  flushed = 0;
  closed = 0;

  constructor(public size: TuiViewportSize = { columns: 24, rows: 8 }) {}

  viewportSize(): TuiViewportSize {
    return this.size;
  }

  present(frame: CanvasFrame): void {
    this.frames.push(frame);
  }

  setCursor(cursor: CursorPacketOptions): void {
    this.cursors.push(cursor);
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

describe("PocketJS terminal components", () => {
  test("focuses buttons in document order and maps Enter only for a focused button", async () => {
    const surface = new FakeSurface();
    let first!: NodeMirror;
    let second!: NodeMirror;
    const presses: string[] = [];
    const session = await mountPocketTui(
      () => {
        const root = createElement("view");
        first = Button({ label: "First", onPress: () => presses.push("first") });
        second = Button({ label: "Second", onPress: () => presses.push("second") });
        insertNode(root, first);
        insertNode(root, second);
        return root;
      },
      { surface },
    );

    try {
      surface.inputs.push(key("enter"));
      expect((await session.step()).buttons).toBe(POCKET_BUTTON.START);
      expect(presses).toEqual([]);
      await session.step();

      surface.inputs.push(key("arrow-down"));
      expect((await session.step()).buttons).toBe(POCKET_BUTTON.DOWN);
      expect(getFocused()).toBe(first);
      expect(snapshot(session, first).focused).toBe(true);
      await session.step();

      surface.inputs.push(key("enter"));
      expect((await session.step()).buttons).toBe(POCKET_BUTTON.CIRCLE);
      expect(presses).toEqual(["first"]);
      expect(snapshot(session, first).active).toBe(true);
      expect((await session.step()).buttons).toBe(0);
      expect(snapshot(session, first).active).toBe(false);

      surface.inputs.push(key("arrow-down"));
      await session.step();
      expect(getFocused()).toBe(second);
    } finally {
      await session.close();
    }
  });

  test("keeps Button and Checkbox nodes reactive and removes disabled controls from focus", async () => {
    const surface = new FakeSurface();
    const [label, setLabel] = createSignal("Ready");
    const [disabled, setDisabled] = createSignal(false);
    const [checked, setChecked] = createSignal(false);
    let button!: NodeMirror;
    let checkbox!: NodeMirror;
    let buttonPresses = 0;
    const session = await mountPocketTui(
      () => {
        const root = createElement("view");
        button = Button({
          label,
          disabled,
          onPress: () => {
            buttonPresses += 1;
          },
        });
        checkbox = Checkbox({
          label: "Telemetry",
          checked,
          onChange: setChecked,
        });
        insertNode(root, button);
        insertNode(root, checkbox);
        return root;
      },
      { surface },
    );

    try {
      const buttonId = button.id;
      setLabel("Running");
      await session.step();
      expect(button.id).toBe(buttonId);
      expect(frameText(session.host.frame)).toContain("Running");

      focusNode(button);
      setDisabled(true);
      await session.step();
      expect(getFocused()).toBeNull();
      surface.inputs.push(key("enter"));
      expect((await session.step()).buttons).toBe(POCKET_BUTTON.START);
      expect(buttonPresses).toBe(0);
      await session.step();

      focusNode(checkbox);
      surface.inputs.push(key("enter"));
      expect((await session.step()).buttons).toBe(POCKET_BUTTON.CIRCLE);
      expect(checked()).toBe(true);
      expect(frameText(session.host.frame)).toContain("☒ Telemetry");
    } finally {
      await session.close();
    }
  });

  test("exposes programmatic focus scopes and grid traversal", async () => {
    const surface = new FakeSurface();
    let outside!: NodeMirror;
    let scope!: NodeMirror;
    let left!: NodeMirror;
    let right!: NodeMirror;
    const session = await mountPocketTui(
      () => {
        const root = createElement("view");
        outside = Button({ label: "Outside", onPress: () => {} });
        scope = createElement("view");
        left = Button({ label: "Left", onPress: () => {} });
        right = Button({ label: "Right", onPress: () => {} });
        insertNode(scope, left);
        insertNode(scope, right);
        insertNode(root, outside);
        insertNode(root, scope);
        return root;
      },
      { surface },
    );

    try {
      focusNode(outside);
      const popScope = pushFocusScope(scope);
      expect(getFocused()).toBe(left);
      popScope();
      expect(getFocused()).toBe(outside);

      const popGrid = pushFocusGrid(scope, { columns: 2 });
      focusNode(left);
      surface.inputs.push(key("arrow-right"));
      await session.step();
      expect(getFocused()).toBe(right);
      popGrid();
    } finally {
      await session.close();
    }
  });

  test("edits TextInput with text, paste, grapheme keys, submit, and a real cursor", async () => {
    const surface = new FakeSurface();
    let input!: TextInputHandle;
    const submissions: string[] = [];
    const session = await mountPocketTui(
      () =>
        TextInput({
          defaultValue: "A👨‍👩‍👧‍👦",
          placeholder: "Type here",
          onSubmit: (value) => submissions.push(value),
          inputRef: (handle) => {
            input = handle;
          },
        }),
      { surface },
    );

    try {
      input.focus();
      surface.inputs.push({ kind: "text", text: "wasd " });
      expect((await session.step()).buttons).toBe(0);
      expect(input.value()).toBe("A👨‍👩‍👧‍👦wasd ");
      expect(surface.cursors.at(-1)).toMatchObject({ visible: true, shape: "bar" });

      input.setValue("A👨‍👩‍👧‍👦");
      surface.inputs.push(key("backspace"));
      await session.step();
      expect(input.value()).toBe("A");

      surface.inputs.push(
        { kind: "paste-start" },
        { kind: "paste-chunk", text: "界" },
        { kind: "paste-chunk", text: "!" },
        { kind: "paste-end" },
      );
      await session.step();
      expect(input.value()).toBe("A界!");

      surface.inputs.push(key("enter"));
      expect((await session.step()).buttons).toBe(0);
      expect(submissions).toEqual(["A界!"]);

      input.blur();
      await session.step();
      expect(surface.cursors.at(-1)).toMatchObject({ visible: false });
    } finally {
      await session.close();
    }
  });

  test("honors onInput before TextInput routing and clears interactions between sessions", async () => {
    const firstSurface = new FakeSurface();
    let input!: TextInputHandle;
    const first = await mountPocketTui(
      () =>
        TextInput({
          inputRef: (handle) => {
            input = handle;
          },
        }),
      {
        surface: firstSurface,
        onInput(event) {
          return event.kind === "text";
        },
      },
    );

    try {
      input.focus();
      firstSurface.inputs.push({ kind: "text", text: "blocked" });
      expect((await first.step()).buttons).toBe(0);
      expect(input.value()).toBe("");
    } finally {
      await first.close();
    }
    expect(getFocused()).toBeNull();
    expect(firstSurface.cursors.at(-1)).toMatchObject({ visible: false });

    const secondSurface = new FakeSurface();
    const second = await mountPocketTui(() => createElement("view"), { surface: secondSurface });
    try {
      secondSurface.inputs.push({ kind: "text", text: "w" });
      expect((await second.step()).buttons).toBe(POCKET_BUTTON.UP);
    } finally {
      await second.close();
    }
  });
});

function key(name: string): TuiInputEvent {
  return { kind: "key", key: name, ctrl: false, alt: false, shift: false };
}

function snapshot(session: PocketTuiSession, node: NodeMirror) {
  const value = session.host.snapshot().find((candidate) => candidate.id === node.id);
  if (value === undefined) throw new Error(`missing snapshot for node ${node.id}`);
  return value;
}

function frameText(frame: CanvasFrame): string {
  return frame.runs.map((run) => run.text).join("\n");
}
