import { createTui } from "@pocket-tui/core";

const app = createTui({ surface: "alternate" });
const root = app.box({ direction: "column", border: true, padding: 1 });
const title = root.text("PocketTUI PTX1 / N-API MVP");
const stream = root.text("Streaming: ");
root.text("The demo closes and restores the terminal automatically.");
app.mount(root);

await app.start();
try {
  for (const chunk of ["semantic ", "delta ", "→ ", "native ", "scene"] as const) {
    stream.appendText(chunk);
    await app.flush("terminal");
    await delay(160);
  }

  title.setText("PocketTUI alternate-screen demo");
  await app.flush("terminal");
  await delay(900);
} finally {
  await app.close();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
