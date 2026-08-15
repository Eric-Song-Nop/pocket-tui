// @ts-nocheck -- Bun supplies the bun:test module at test runtime.
import { describe, expect, test } from "bun:test";
import type {
  CanvasFrame,
  CursorPacketOptions,
  TuiInputEvent,
  TuiViewportSize,
} from "@pocket-tui/core";
import {
  POCKET_BUTTON,
  createPocketTuiHost,
  getFocused,
  mountPocketTui,
  type PocketTuiSession,
  type PocketTuiSurface,
} from "@pocket-tui/pocketjs";

import { TodoApp, type TodoAppHandle } from "./todo-app.js";
import { addTodo, createTodoState, toggleTodo } from "./todo-model.js";

class TodoSurface implements PocketTuiSurface {
  readonly frames: CanvasFrame[] = [];
  readonly inputs: TuiInputEvent[] = [];
  readonly cursors: CursorPacketOptions[] = [];
  size: TuiViewportSize = { columns: 72, rows: 30 };
  started = 0;
  flushed = 0;
  closed = 0;

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

describe("Pocket Tasks backend integration", () => {
  test("runs the complete retained Solid todo flow through PocketJS HostOps", async () => {
    const surface = new TodoSurface();
    const host = createPocketTuiHost({ surface, colorMode: "ansi16" });
    let app!: TodoAppHandle;
    let session: PocketTuiSession | undefined;

    try {
      session = await mountPocketTui(
        () => TodoApp({
          viewport: surface.size,
          requestClose: () => session?.requestClose(),
          appRef: (handle) => {
            app = handle;
          },
        }),
        {
          host,
          framePolicy: "adaptive",
          textEventPolicy: "grapheme",
          onInput(event) {
            if (event.kind === "resize") {
              app.resize({ columns: event.columns, rows: event.rows });
            }
            return app.handleInput(event);
          },
        },
      );

      expect(surface.started).toBe(1);
      expect(frameText(host.frame)).toContain("POCKET TASKS");
      expect(frameText(host.frame)).toContain("Keep PocketJS state retained");
      expect(frameText(host.frame)).toContain("1/3 done");
      expect(surface.cursors.at(-1)).toMatchObject({ visible: true, shape: "bar" });
      expect(app.snapshot().state.todos).toHaveLength(3);
      const retainedNodes = host.diagnostics.liveNodes;

      surface.inputs.push({ kind: "text", text: "  Verify the todo backend  " });
      await session.step();
      surface.inputs.push(key("enter"));
      await session.step();

      expect(app.snapshot().state.todos.at(-1)?.title).toBe("Verify the todo backend");
      expect(app.snapshot().state.todos).toHaveLength(4);
      expect(frameText(host.frame)).toContain("Verify the todo backend");
      expect(host.diagnostics.liveNodes).toBe(retainedNodes);

      surface.inputs.push(key("tab"));
      expect((await session.step()).buttons).toBe(POCKET_BUTTON.DOWN);
      expect(app.snapshot().focusedTodoId).toBe(app.snapshot().state.todos[0]?.id);
      await session.step();

      const first = app.snapshot().state.todos[0];
      expect(first).toBeDefined();
      surface.inputs.push(key("enter"));
      expect((await session.step()).buttons).toBe(POCKET_BUTTON.CIRCLE);
      expect(app.snapshot().state.todos[0]?.completed).toBe(!first.completed);
      await session.step();

      for (const expected of [
        "TodoRow2",
        "TodoRow3",
        "TodoRow4",
        "FilterAll",
        "FilterOpen",
      ]) {
        surface.inputs.push(key("tab"));
        await session.step();
        expect(getFocused()?.debugName).toBe(expected);
        await session.step();
      }
      surface.inputs.push(key("tab", { shift: true }));
      await session.step();
      expect(getFocused()?.debugName).toBe("FilterAll");
      await session.step();

      app.focusComposer();
      await session.step();
      surface.inputs.push(key("tab"));
      await session.step();
      await session.step();
      expect(app.snapshot().focusedTodoId).toBe(first.id);

      surface.inputs.push({ kind: "text", text: "x3" });
      await session.step();
      expect(app.snapshot().state.todos.some((todo) => todo.id === first.id)).toBe(false);
      expect(app.snapshot().state.todos).toHaveLength(3);
      expect(host.diagnostics.liveNodes).toBe(retainedNodes);
      expect(app.snapshot().filter).toBe("done");
      expect(app.snapshot().visible.every((todo) => todo.completed)).toBe(true);

      surface.inputs.push({ kind: "text", text: "c" });
      await session.step();
      expect(app.snapshot().state.todos.every((todo) => !todo.completed)).toBe(true);
      expect(app.snapshot().visible).toHaveLength(0);

      surface.size = { columns: 44, rows: 20 };
      surface.inputs.push({ kind: "resize", columns: 44, rows: 20 });
      await session.step();
      expect(host.frame).toMatchObject({ width: 44, height: 20 });
      expect(frameText(host.frame)).toContain("POCKET TASKS");
      expect(host.diagnostics.liveNodes).toBe(retainedNodes);
    } finally {
      await session?.close();
    }

    expect(surface.closed).toBe(1);
  });

  test("pages an arbitrary model through stable retained row slots", async () => {
    const surface = new TodoSurface();
    const host = createPocketTuiHost({ surface, colorMode: "ansi16" });
    let state = createTodoState();
    for (let index = 4; index <= 12; index += 1) {
      state = addTodo(state, `Retained task ${index}`);
    }
    let app!: TodoAppHandle;
    let session: PocketTuiSession | undefined;

    try {
      session = await mountPocketTui(
        () => TodoApp({
          viewport: surface.size,
          initialState: state,
          requestClose: () => session?.requestClose(),
          appRef: (handle) => {
            app = handle;
          },
        }),
        {
          host,
          framePolicy: "adaptive",
          textEventPolicy: "grapheme",
          onInput(event) {
            if (event.kind === "resize") {
              app.resize({ columns: event.columns, rows: event.rows });
            }
            return app.handleInput(event);
          },
        },
      );
      const retainedNodes = host.diagnostics.liveNodes;
      expect(app.snapshot().visible).toHaveLength(4);

      surface.inputs.push(key("tab"));
      await session.step();
      await session.step();
      expect(app.snapshot().focusedTodoId).toBe(1);

      surface.inputs.push(key("page-down"));
      await session.step();
      expect(app.snapshot().focusedTodoId).toBe(5);
      expect(app.snapshot().visible.map((todo) => todo.id)).toEqual([2, 3, 4, 5]);

      surface.inputs.push(key("page-down"));
      await session.step();
      expect(app.snapshot().focusedTodoId).toBe(9);
      expect(app.snapshot().visible.map((todo) => todo.id)).toEqual([6, 7, 8, 9]);
      expect(host.diagnostics.liveNodes).toBe(retainedNodes);

      surface.size = { columns: 72, rows: 17 };
      surface.inputs.push({ kind: "resize", columns: 72, rows: 17 });
      await session.step();
      expect(app.snapshot().focusedTodoId).toBe(9);
      expect(app.snapshot().visible.map((todo) => todo.id)).toEqual([9]);
      expect(host.diagnostics.liveNodes).toBe(retainedNodes);

      surface.size = { columns: 24, rows: 10 };
      surface.inputs.push({ kind: "resize", columns: 24, rows: 10 });
      await session.step();
      expect(app.snapshot().focusedTodoId).toBe(9);
      expect(frameText(host.frame)).toContain("Add a task");
      expect(frameText(host.frame)).not.toContain("Clear ");
      expect(host.diagnostics.liveNodes).toBe(retainedNodes);
    } finally {
      await session?.close();
    }

    expect(surface.closed).toBe(1);
  });

  test("keeps focus on a surviving todo when completed predecessors are cleared", async () => {
    const surface = new TodoSurface();
    const host = createPocketTuiHost({ surface, colorMode: "ansi16" });
    const initial = toggleTodo(toggleTodo(createTodoState(), 1), 2);
    let app!: TodoAppHandle;
    let session: PocketTuiSession | undefined;

    try {
      session = await mountPocketTui(
        () => TodoApp({
          viewport: surface.size,
          initialState: initial,
          requestClose: () => session?.requestClose(),
          appRef: (handle) => {
            app = handle;
          },
        }),
        {
          host,
          framePolicy: "adaptive",
          textEventPolicy: "grapheme",
          onInput: (event) => app.handleInput(event),
        },
      );

      surface.inputs.push(key("tab"));
      await session.step();
      await session.step();
      surface.inputs.push(key("tab"));
      await session.step();
      await session.step();
      expect(app.snapshot().focusedTodoId).toBe(2);

      surface.inputs.push({ kind: "text", text: "c" });
      await session.step();
      expect(app.snapshot().state.todos.map((todo) => todo.id)).toEqual([2, 3]);
      expect(app.snapshot().focusedTodoId).toBe(2);
    } finally {
      await session?.close();
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

function frameText(frame: CanvasFrame): string {
  return frame.runs.map((run) => run.text).join("\n");
}
