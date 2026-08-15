/** PocketJS 0.6 PSP-compatible input bitmask. */
export const BTN: {
  readonly SELECT: 0x0001;
  readonly START: 0x0008;
  readonly UP: 0x0010;
  readonly RIGHT: 0x0020;
  readonly DOWN: 0x0040;
  readonly LEFT: 0x0080;
  readonly LTRIGGER: 0x0100;
  readonly RTRIGGER: 0x0200;
  readonly TRIANGLE: 0x1000;
  readonly CIRCLE: 0x2000;
  readonly CROSS: 0x4000;
  readonly SQUARE: 0x8000;
};

import type { NodeMirror } from "./solid-renderer.js";

export type FocusDirection = "up" | "down" | "left" | "right";

export interface FocusGridOptions {
  columns: number;
  wrap?: boolean;
}

export interface FocusScopeOptions {
  autoFocus?: boolean;
  restoreFocus?: boolean;
}

export function focusNode(node: NodeMirror | null): void;
export function getFocused(): NodeMirror | null;
export function pushFocusController(
  node: NodeMirror,
  move: (direction: FocusDirection) => boolean,
): () => void;
export function pushFocusGrid(node: NodeMirror, options: FocusGridOptions): () => void;
export function pushFocusScope(node: NodeMirror, options?: FocusScopeOptions): () => void;
