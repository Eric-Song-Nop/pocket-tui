import {
  createPocketTuiHost,
  mountPocketTui,
  type PocketTuiSession,
  type TuiInputEvent,
} from "@pocket-tui/pocketjs";

import { TodoApp, type TodoAppHandle } from "./todo-app.js";

const host = createPocketTuiHost({
  tui: { surface: "alternate" },
  colorMode: "ansi16",
});
let app: TodoAppHandle | undefined;
let session: PocketTuiSession | undefined;
let pendingExitCode: number | undefined;

for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGQUIT", 131],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const) {
  process.once(signal, () => {
    pendingExitCode ??= exitCode;
    session?.requestClose();
  });
}

try {
  session = await mountPocketTui(
    () => TodoApp({
      viewport: host.viewportSize(),
      requestClose: () => session?.requestClose(),
      appRef: (handle) => {
        app = handle;
      },
    }),
    {
      host,
      fps: 30,
      framePolicy: "adaptive",
      textEventPolicy: "grapheme",
      onInput: handleInput,
    },
  );
  if (pendingExitCode !== undefined) session.requestClose();
  await session.run();
} finally {
  await session?.close();
  if (pendingExitCode !== undefined) process.exit(pendingExitCode);
}

function handleInput(event: TuiInputEvent): boolean | void {
  if (event.kind === "resize") app?.resize({ columns: event.columns, rows: event.rows });
  return app?.handleInput(event);
}
