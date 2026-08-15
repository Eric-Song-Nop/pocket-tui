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
  Text,
  TextInput,
  View,
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
  test("keeps facade View and Text primitives retained and reactive", async () => {
    const surface = new FakeSurface({ columns: 12, rows: 4 });
    const [label, setLabel] = createSignal("idle");
    const [background, setBackground] = createSignal(0xff20_2020);
    const [foreground, setForeground] = createSignal(0xff00_00ff);
    let view!: NodeMirror;
    let text!: NodeMirror;
    const session = await mountPocketTui(
      () =>
        View({
          children: Text({
            value: label,
            style: () => ({ textColor: foreground() }),
            nodeRef: (node) => {
              text = node;
            },
          }),
          style: () => ({
            width: 12,
            height: 4,
            paddingT: 1,
            paddingL: 1,
            bgColor: background(),
          }),
          nodeRef: (node) => {
            view = node;
          },
        }),
      { surface, colorMode: "truecolor" },
    );

    try {
      const viewId = view.id;
      const textId = text.id;
      expect(frameText(session.host.frame)).toContain("idle");

      setLabel("awake");
      setBackground(0xff00_ff00);
      setForeground(0xffff_0000);
      await session.step();

      expect(view.id).toBe(viewId);
      expect(text.id).toBe(textId);
      expect(snapshot(session, view).children).toContain(text.id);
      const run = textRun(session.host.frame, "awake");
      expect(run?.style?.foreground).toEqual(rgb(0, 0, 255));
      expect(run?.style?.background).toEqual(rgb(0, 255, 0));
    } finally {
      await session.close();
    }
  });

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

  test("publishes focus changes before render and supports complete inline focus styles", async () => {
    const surface = new FakeSurface({ columns: 18, rows: 8 });
    const [firstFocused, setFirstFocused] = createSignal(false);
    const [secondFocused, setSecondFocused] = createSignal(false);
    const firstFocusEvents: Array<{ focused: boolean; presentedFrames: number }> = [];
    let first!: NodeMirror;
    let second!: NodeMirror;
    const session = await mountPocketTui(
      () => {
        const root = createElement("view");
        first = Button({
          label: "First",
          onPress: () => {},
          onFocusChange: (focused) => {
            firstFocusEvents.push({ focused, presentedFrames: surface.frames.length });
            setFirstFocused(focused);
          },
          style: () => ({
            bgColor: firstFocused() ? 0xff00_ff00 : 0xff00_00ff,
            borderColor: firstFocused() ? 0xff00_ff00 : 0xff00_00ff,
            borderWidth: 1,
          }),
        });
        second = Button({
          label: "Second",
          onPress: () => {},
          onFocusChange: setSecondFocused,
          style: () => ({
            bgColor: secondFocused() ? 0xff00_ff00 : 0xff00_00ff,
            borderColor: secondFocused() ? 0xff00_ff00 : 0xff00_00ff,
            borderWidth: 1,
          }),
        });
        insertNode(root, first);
        insertNode(root, second);
        return root;
      },
      { surface, colorMode: "truecolor" },
    );

    try {
      expect(firstFocusEvents).toEqual([{ focused: false, presentedFrames: 0 }]);
      expect(textRun(session.host.frame, "First")?.style?.background).toEqual(rgb(255, 0, 0));

      const framesBeforeFocus = surface.frames.length;
      surface.inputs.push(key("arrow-down"));
      await session.step();
      expect(firstFocusEvents.at(-1)).toEqual({
        focused: true,
        presentedFrames: framesBeforeFocus,
      });
      expect(textRun(session.host.frame, "First")?.style?.background).toEqual(rgb(0, 255, 0));

      await session.step();
      surface.inputs.push(key("arrow-down"));
      await session.step();
      expect(getFocused()).toBe(second);
      expect(firstFocusEvents.map((event) => event.focused)).toEqual([false, true, false]);
      expect(textRun(session.host.frame, "First")?.style?.background).toEqual(rgb(255, 0, 0));
      expect(textRun(session.host.frame, "Second")?.style?.background).toEqual(rgb(0, 255, 0));
    } finally {
      await session.close();
    }
  });

  test("settles reactive focus on a target selected by a blur callback", async () => {
    const surface = new FakeSurface({ columns: 18, rows: 9 });
    const states = new Map<string, boolean>();
    let first!: NodeMirror;
    let second!: NodeMirror;
    let redirected!: NodeMirror;
    const session = await mountPocketTui(
      () => {
        const root = createElement("view");
        first = Button({
          label: "First",
          onPress: () => {},
          onFocusChange: (focused) => {
            states.set("first", focused);
            if (!focused && getFocused() === second) focusNode(redirected);
          },
        });
        second = Button({
          label: "Second",
          onPress: () => {},
          onFocusChange: (focused) => states.set("second", focused),
        });
        redirected = Button({
          label: "Redirected",
          onPress: () => {},
          onFocusChange: (focused) => states.set("redirected", focused),
        });
        insertNode(root, first);
        insertNode(root, second);
        insertNode(root, redirected);
        return root;
      },
      { surface },
    );

    try {
      focusNode(first);
      await session.step();
      focusNode(second);
      await session.step();
      expect(getFocused()).toBe(redirected);
      expect(states).toEqual(new Map([
        ["first", false],
        ["second", false],
        ["redirected", true],
      ]));
      expect(snapshot(session, redirected).focused).toBe(true);
      expect(snapshot(session, second).focused).toBe(false);
    } finally {
      await session.close();
    }
  });

  test("moves focus with Tab and Shift-Tab without TextInput swallowing either key", async () => {
    const surface = new FakeSurface();
    let input!: TextInputHandle;
    let button!: NodeMirror;
    const session = await mountPocketTui(
      () => {
        const root = createElement("view");
        insertNode(
          root,
          TextInput({
            defaultValue: "keep me",
            inputRef: (handle) => {
              input = handle;
            },
          }),
        );
        button = Button({ label: "Next", onPress: () => {} });
        insertNode(root, button);
        return root;
      },
      { surface },
    );

    try {
      input.focus();
      surface.inputs.push(key("tab"));
      expect((await session.step()).buttons).toBe(POCKET_BUTTON.DOWN);
      expect(getFocused()).toBe(button);
      expect(input.value()).toBe("keep me");
      await session.step();

      surface.inputs.push(key("tab", { shift: true }));
      expect((await session.step()).buttons).toBe(POCKET_BUTTON.UP);
      expect(getFocused()).toBe(input.node);
      expect(input.value()).toBe("keep me");
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

  test("keeps a long single-line TextInput caret inside its laid-out horizontal viewport", async () => {
    const surface = new FakeSurface({ columns: 10, rows: 3 });
    let input!: TextInputHandle;
    const session = await mountPocketTui(
      () =>
        TextInput({
          defaultValue: "abcdefghijk",
          placeholder: "hint",
          textStyle: { textColor: 0xff00_00ff },
          placeholderStyle: { textColor: 0xff88_8888 },
          inputRef: (handle) => {
            input = handle;
          },
        }),
      { surface, colorMode: "truecolor" },
    );

    try {
      expect(frameText(session.host.frame)).toContain("efghijk");
      expect(frameText(session.host.frame)).not.toContain("abcdefgh");

      input.focus();
      await session.step();
      expect(surface.cursors.at(-1)).toMatchObject({ row: 1, column: 8, visible: true });

      session.setCursor({ row: 0, column: 0, visible: false });
      expect(surface.cursors.at(-1)).toMatchObject({ visible: false });
      await session.step();
      expect(surface.cursors.at(-1)).toMatchObject({ row: 1, column: 8, visible: true });

      surface.inputs.push(key("home"));
      await session.step();
      expect(frameText(session.host.frame)).toContain("abcdefgh");
      expect(surface.cursors.at(-1)).toMatchObject({ row: 1, column: 1, visible: true });

      surface.inputs.push(key("delete"));
      await session.step();
      expect(input.value()).toBe("bcdefghijk");
      expect(frameText(session.host.frame)).toContain("bcdefghi");
      expect(surface.cursors.at(-1)).toMatchObject({ row: 1, column: 1, visible: true });

      surface.inputs.push(key("end"));
      await session.step();
      expect(frameText(session.host.frame)).toContain("efghijk");
      expect(surface.cursors.at(-1)).toMatchObject({ row: 1, column: 8, visible: true });

      input.setValue("");
      await session.step();
      expect(textRun(session.host.frame, "hint")?.style?.foreground).toEqual(rgb(136, 136, 136));

      input.setValue("Z");
      await session.step();
      expect(textRun(session.host.frame, "Z")?.style?.foreground).toEqual(rgb(255, 0, 0));
    } finally {
      await session.close();
    }
  });

  test("normalizes initial input and pins caret-safe text and root metrics", async () => {
    const surface = new FakeSurface({ columns: 10, rows: 3 });
    let input!: TextInputHandle;
    const session = await mountPocketTui(
      () => TextInput({
        defaultValue: "abcdefghijk\nz",
        maxLength: 12,
        style: { align: 0, flexDir: 0 },
        textStyle: { tracking: 2, textAlign: 2, lineHeight: 3 },
        inputRef: (handle) => {
          input = handle;
          handle.focus();
        },
      }),
      { surface },
    );

    try {
      expect(input.value()).toBe("abcdefghijk ");
      for (let index = 0; index < 10; index += 1) await session.step();
      expect(frameText(session.host.frame)).toContain("fghijk ");
      expect(textRun(session.host.frame, "fghijk ")?.column).toBe(1);
      expect(surface.cursors.at(-1)).toMatchObject({ row: 1, column: 8, visible: true });
    } finally {
      await session.close();
    }
  });

  test("programmatic TextInput caret movement wakes one adaptive frame", async () => {
    const surface = new FakeSurface({ columns: 10, rows: 3 });
    let input!: TextInputHandle;
    const session = await mountPocketTui(
      () =>
        TextInput({
          defaultValue: "abcdef",
          inputRef: (handle) => {
            input = handle;
          },
        }),
      {
        surface,
        fps: 60,
        framePolicy: "adaptive",
        idlePollMs: 1_000,
      },
    );
    input.focus();
    const running = session.run();

    try {
      await waitFor(() => session.diagnostics.idleWaits >= 1);
      const settledFrames = session.diagnostics.steppedFrames;

      input.setCaret(0);
      await waitFor(() => session.diagnostics.steppedFrames > settledFrames);
      expect(surface.cursors.at(-1)).toMatchObject({ row: 1, column: 1, visible: true });

      const awakenedFrames = session.diagnostics.steppedFrames;
      await delay(60);
      expect(session.diagnostics.steppedFrames).toBe(awakenedFrames);
    } finally {
      session.requestClose();
      await running;
    }
  });

  test("positions a multiline password cursor from the displayed bullets", async () => {
    const surface = new FakeSurface({ columns: 6, rows: 4 });
    let input!: TextInputHandle;
    const session = await mountPocketTui(
      () =>
        TextInput({
          defaultValue: "界a",
          multiline: true,
          password: true,
          inputRef: (handle) => {
            input = handle;
          },
        }),
      { surface },
    );

    try {
      input.focus();
      await session.step();
      expect(frameText(session.host.frame)).toContain("••");
      expect(surface.cursors.at(-1)).toMatchObject({ row: 1, column: 3, visible: true });
    } finally {
      await session.close();
    }
  });

  test("windows multiline input vertically around its real caret line", async () => {
    const surface = new FakeSurface({ columns: 6, rows: 6 });
    const session = await mountPocketTui(
      () => TextInput({
        defaultValue: "aa\nbb\ncc\ndd\nee",
        multiline: true,
        style: { height: 6 },
        inputRef: (handle) => handle.focus(),
      }),
      { surface },
    );

    try {
      expect(frameText(session.host.frame)).not.toContain("aa");
      expect(frameText(session.host.frame)).toContain("bb");
      expect(frameText(session.host.frame)).toContain("ee");
      expect(surface.cursors.at(-1)).toMatchObject({ row: 4, column: 3, visible: true });
    } finally {
      await session.close();
    }
  });

  test("grows a multiline viewport and places an exact-wrap caret on the next row", async () => {
    const surface = new FakeSurface({ columns: 6, rows: 6 });
    let input!: TextInputHandle;
    const session = await mountPocketTui(
      () => TextInput({
        multiline: true,
        style: { height: 6 },
        inputRef: (handle) => {
          input = handle;
          handle.focus();
        },
      }),
      { surface },
    );

    try {
      input.setValue("aa\nbb\ncc\ndd");
      await session.step();
      expect(frameText(session.host.frame)).toContain("aa");
      expect(frameText(session.host.frame)).toContain("dd");
      expect(surface.cursors.at(-1)).toMatchObject({ row: 4, column: 3, visible: true });

      input.setValue("abcde");
      input.setCaret(4);
      await session.step();
      expect(frameText(session.host.frame)).toContain("abcd");
      expect(frameText(session.host.frame)).toContain("e");
      expect(surface.cursors.at(-1)).toMatchObject({ row: 2, column: 1, visible: true });
    } finally {
      await session.close();
    }
  });

  test("cleans interaction state after component and surface start failures", async () => {
    const callbackFailure = new FakeSurface();
    await expect(mountPocketTui(
      () => TextInput({
        onFocusChange: () => {
          throw new Error("focus callback failed");
        },
      }),
      { surface: callbackFailure },
    )).rejects.toThrow("focus callback failed");

    const startFailure = new FakeSurface({ columns: 8, rows: 3 });
    startFailure.start = () => {
      throw new Error("surface start failed");
    };
    await expect(mountPocketTui(
      () => TextInput({
        defaultValue: "x",
        inputRef: (handle) => handle.focus(),
      }),
      { surface: startFailure },
    )).rejects.toThrow("surface start failed");

    const recoveredSurface = new FakeSurface({ columns: 8, rows: 3 });
    const recovered = await mountPocketTui(
      () => TextInput({
        defaultValue: "x",
        inputRef: (handle) => handle.focus(),
      }),
      { surface: recoveredSurface },
    );
    try {
      expect(recoveredSurface.cursors.at(-1)).toMatchObject({
        row: 1,
        column: 2,
        visible: true,
      });
    } finally {
      await recovered.close();
    }
  });

  test("optionally routes native text batches as ordered grapheme events", async () => {
    const surface = new FakeSurface();
    const seen: string[] = [];
    const session = await mountPocketTui(
      () => createElement("view"),
      {
        surface,
        textEventPolicy: "grapheme",
        onInput(event) {
          if (event.kind !== "text") return false;
          seen.push(event.text);
          return true;
        },
      },
    );

    try {
      const nativeEvent = { kind: "text", text: "x界e\u0301" } as const;
      surface.inputs.push(nativeEvent);
      const result = await session.step();
      expect(seen).toEqual(["x", "界", "é"]);
      expect(result.events).toEqual([nativeEvent]);
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

function key(
  name: string,
  modifiers: Readonly<{ ctrl?: boolean; alt?: boolean; shift?: boolean }> = {},
): TuiInputEvent {
  return {
    kind: "key",
    key: name,
    ctrl: modifiers.ctrl ?? false,
    alt: modifiers.alt ?? false,
    shift: modifiers.shift ?? false,
  };
}

function snapshot(session: PocketTuiSession, node: NodeMirror) {
  const value = session.host.snapshot().find((candidate) => candidate.id === node.id);
  if (value === undefined) throw new Error(`missing snapshot for node ${node.id}`);
  return value;
}

function frameText(frame: CanvasFrame): string {
  return frame.runs.map((run) => run.text).join("\n");
}

function textRun(frame: CanvasFrame, text: string) {
  return frame.runs.find((run) => run.text.includes(text));
}

function rgb(red: number, green: number, blue: number) {
  return { kind: "rgb", red, green, blue } as const;
}

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("timed out waiting for component condition");
    await delay(2);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
