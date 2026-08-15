import type { CursorPacketOptions, TuiInputEvent } from "@pocket-tui/core";
import { BTN, getFocused, type NodeMirror } from "#pocketjs-runtime";

import type { PocketTuiHost } from "./host.js";

export interface TextInteraction {
  readonly node: NodeMirror;
  readonly cursorNode: NodeMirror;
  handleInput(event: TuiInputEvent): boolean;
  updateViewport(width: number, height: number): boolean;
  cursorOffset(width: number, height: number): { row: number; column: number };
}

type FocusListener = (focused: boolean) => void;

const textInteractions = new Map<NodeMirror, TextInteraction>();
const buttonInteractions = new Set<NodeMirror>();
const focusListeners = new Map<NodeMirror, Set<FocusListener>>();
let cursorOwned = false;
let lastCursorKey = "";
let pasteInteraction: TextInteraction | undefined;
let syncedFocus: NodeMirror | null = null;

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

/** @internal Observe Pocket's focus tree from the client Solid runtime. */
export function registerFocusListener(node: NodeMirror, listener: FocusListener): () => void {
  let listeners = focusListeners.get(node);
  if (listeners === undefined) {
    listeners = new Set();
    focusListeners.set(node, listeners);
  }
  listeners.add(listener);
  try {
    listener(getFocused() === node);
  } catch (error) {
    listeners.delete(listener);
    if (listeners.size === 0) focusListeners.delete(node);
    throw error;
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    listeners?.delete(listener);
    if (listeners?.size === 0) focusListeners.delete(node);
  };
}

/** @internal Synchronize imperative Pocket focus into registered Solid owners. */
export function syncInteractionFocus(): void {
  // Focus callbacks may legally redirect focus. Publish one transition at a
  // time and re-read Pocket's authoritative focus after every callback so
  // reactive styling settles on the node that will actually receive input.
  for (let step = 0; step < 64; step += 1) {
    const focused = getFocused();
    if (focused === syncedFocus) return;
    if (syncedFocus !== null) {
      const blurred = syncedFocus;
      syncedFocus = null;
      notifyFocus(blurred, false);
      continue;
    }
    if (focused !== null) {
      syncedFocus = focused;
      notifyFocus(focused, true);
    }
  }
  throw new Error("PocketTUI: focus-change callbacks did not settle");
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

/** @internal Feed the laid-out text viewport back to the focused input. */
export function syncInteractionLayout(host: PocketTuiHost): boolean {
  let changed = false;
  for (const interaction of textInteractions.values()) {
    const rect = host.nodeRect(interaction.cursorNode.id);
    if (rect === undefined || rect.width <= 0 || rect.height <= 0) continue;
    changed = interaction.updateViewport(rect.width, rect.height) || changed;
  }
  return changed;
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

/** @internal Let a focused TextInput reclaim the cursor after a manual override. */
export function invalidateInteractionCursor(): void {
  lastCursorKey = "";
}

/** @internal Release cursor ownership when a session closes. */
export function releaseInteractionCursor(host: PocketTuiHost): void {
  try {
    if (cursorOwned) publishCursor(host, { row: 0, column: 0, visible: false });
  } finally {
    textInteractions.clear();
    buttonInteractions.clear();
    focusListeners.clear();
    cursorOwned = false;
    lastCursorKey = "";
    pasteInteraction = undefined;
    syncedFocus = null;
  }
}

function notifyFocus(node: NodeMirror, focused: boolean): void {
  const listeners = focusListeners.get(node);
  if (listeners === undefined) return;
  for (const listener of [...listeners]) listener(focused);
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
