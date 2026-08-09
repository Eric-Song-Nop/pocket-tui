import { createTui, type TuiInputEvent } from "@pocket-tui/core";

const app = createTui({ surface: "alternate" });
const transcript = app.transcript();
const root = app.box({ direction: "column", padding: 1 });
root.virtualTranscript(transcript);
const footer = root.text("Streaming through native DocumentDB…");
app.mount(root);

await app.start();
try {
  const block = transcript.openBlock();
  for (const chunk of [
    "PocketTUI ",
    "keeps this block ",
    "in DocumentDB ",
    "and appends ordered UTF-8 deltas.",
  ] as const) {
    block.appendText(chunk);
    await app.flush("terminal");
    await delay(140);
  }
  block.seal();
  await app.flush("terminal");

  const stats = app.memoryStats();
  footer.setText(
    `blocks=${stats.blocks} sealed=${stats.sealedBlocks} text=${stats.documentTextBytes}B · press any key`,
  );
  await app.flush("terminal");

  const event = await waitForInput(1_500);
  if (event !== undefined) {
    footer.setText(`input: ${describeInput(event)} · closing`);
    await app.flush("terminal");
    await delay(180);
  }
} finally {
  await app.close();
}

async function waitForInput(timeoutMs: number): Promise<TuiInputEvent | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = app.pollInput()[0];
    if (event !== undefined) return event;
    await delay(16);
  }
  return undefined;
}

function describeInput(event: TuiInputEvent): string {
  if (event.kind === "key") return event.key;
  if (event.kind === "resize") return `${event.columns}×${event.rows}`;
  if (event.kind === "text" || event.kind === "paste-chunk") return event.text;
  return event.kind;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
