import type { CursorPacketOptions, TuiInputEvent } from "@pocket-tui/core";
import { BTN, getFocused, type NodeMirror } from "#pocketjs-runtime";

import type { PocketTuiHost } from "./host.js";

export interface TextInteraction {
  readonly node: NodeMirror;
  readonly cursorNode: NodeMirror;
  handleInput(event: TuiInputEvent): boolean;
  cursorOffset(width: number, height: number): { row: number; column: number };
}

const textInteractions = new Map<NodeMirror, TextInteraction>();
const buttonInteractions = new Set<NodeMirror>();
let cursorOwned = false;
let lastCursorKey = "";
let pasteInteraction: TextInteraction | undefined;

/** @internal Register a focusable component that consumes terminal text input. */
export function registerTextInteraction(interaction: TextInteraction): () => void {
  if (textInteractions.has(interaction.node)) {
    throw new Error("PocketTUI: a node cannot own more than one text interaction");
  }
  textInteractions.set(interaction.node, interaction);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    textInteractions.delete(interaction.node);
    if (pasteInteraction === interaction) pasteInteraction = undefined;
  };
}

/** @internal Let Enter use Pocket's ordinary CIRCLE active/press lifecycle. */
export function registerButtonInteraction(node: NodeMirror): () => void {
  buttonInteractions.add(node);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    buttonInteractions.delete(node);
  };
}

/** @internal Return a focused-component mapping without changing global defaults. */
export function focusedInteractionMapping(event: TuiInputEvent): number | undefined {
  if (event.kind !== "key" || event.key !== "enter") return undefined;
  let node = getFocused();
  while (node !== null) {
    if (buttonInteractions.has(node)) return BTN.CIRCLE;
    node = node.parent;
  }
  return undefined;
}

/** @internal Route an event to the focused TextInput before button mapping. */
export function dispatchTextInteraction(event: TuiInputEvent): boolean {
  if (event.kind === "paste-start") {
    pasteInteraction = focusedTextInteraction();
    return pasteInteraction?.handleInput(event) ?? false;
  }
  if (event.kind === "paste-chunk" || event.kind === "paste-end") {
    const interaction = pasteInteraction;
    if (event.kind === "paste-end") pasteInteraction = undefined;
    if (
      interaction === undefined ||
      textInteractions.get(interaction.node) !== interaction
    ) {
      return false;
    }
    return interaction.handleInput(event);
  }
  return focusedTextInteraction()?.handleInput(event) ?? false;
}

/** @internal Anchor the real terminal cursor after the latest layout pass. */
export function syncInteractionCursor(host: PocketTuiHost): void {
  const interaction = focusedTextInteraction();
  const rect = interaction === undefined ? undefined : host.nodeRect(interaction.cursorNode.id);
  if (interaction === undefined || rect === undefined || rect.width <= 0 || rect.height <= 0) {
    if (cursorOwned) publishCursor(host, { row: 0, column: 0, visible: false });
    cursorOwned = false;
    return;
  }

  const offset = interaction.cursorOffset(rect.width, rect.height);
  publishCursor(host, {
    row: clamp(rect.y + offset.row, 0, host.viewportSize().rows - 1),
    column: clamp(rect.x + offset.column, 0, host.viewportSize().columns - 1),
    visible: true,
    shape: "bar",
  });
  cursorOwned = true;
}

/** @internal Release cursor ownership when a session closes. */
export function releaseInteractionCursor(host: PocketTuiHost): void {
  if (cursorOwned) publishCursor(host, { row: 0, column: 0, visible: false });
  cursorOwned = false;
  lastCursorKey = "";
  pasteInteraction = undefined;
}

function focusedTextInteraction(): TextInteraction | undefined {
  let node = getFocused();
  while (node !== null) {
    const interaction = textInteractions.get(node);
    if (interaction !== undefined) return interaction;
    node = node.parent;
  }
  return undefined;
}

function publishCursor(host: PocketTuiHost, cursor: CursorPacketOptions): void {
  const key = `${cursor.row}:${cursor.column}:${cursor.visible ? 1 : 0}:${cursor.shape ?? "block"}`;
  if (key === lastCursorKey) return;
  host.setCursor(cursor);
  lastCursorKey = key;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
