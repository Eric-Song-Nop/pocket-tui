export * from "./framework.js";
export * from "./input.js";
export * from "./lifecycle.js";
export * from "./solid-renderer.js";
export function simulationHz(): number;
export function virtualNow(): number;
export {
  batch,
  createComponent,
  createMemo,
  createSignal,
  mergeProps,
  onCleanup,
  untrack,
} from "solid-js";
