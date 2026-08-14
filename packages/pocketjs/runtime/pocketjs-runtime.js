// Runtime-only bridge. The matching package-import "types" condition points
// tsc at a local PocketJS 0.6 contract, while Bun executes these real npm
// exports. Keeping that split here prevents the dependency's shipped .ts
// sources from inheriting this workspace's compiler settings.
//
// `solid-js` selects its non-reactive SSR build under Bun's default "node"
// condition. A terminal is an interactive client, so the facade deliberately
// imports the client runtime by its public dist subpath and owns one client
// root around Pocket's mount. Apps take their reactive primitives from this
// facade so effects and signals always share the same runtime. PocketJS 0.6's
// npm package publishes TypeScript source, so this adapter's executable runtime
// is Bun; Node is not advertised until that upstream artifact can be bundled.
import { mount as mountPocketJs, resetPack } from "@pocketjs/framework";
import {
  createRenderEffect,
  createRoot,
  createSignal as createClientSignal,
  onCleanup,
} from "solid-js/dist/solid.js";
import { onFrame as registerPocketFrame } from "@pocketjs/framework/lifecycle";
import { after as schedulePocketAfter } from "@pocketjs/framework/clock";
import {
  resetRendererState,
  resetSprites,
  resetTextures,
} from "@pocketjs/framework/solid/renderer";

// PocketJS 0.6 exposes resetStyles() in its source but omits that symbol from
// the package export map. This adapter pins exactly 0.6.0, resolves the real
// package entry, and loads the sibling module so sequential terminal sessions
// do not inherit another application's class table. Remove this compatibility
// bridge once upstream exports a complete runtime reset.
const frameworkEntry = import.meta.resolve("@pocketjs/framework");
const { resetStyles } = await import(new URL("./styles.ts", frameworkEntry).href);

export {
  batch,
  createComponent,
  createMemo,
  createSignal,
  mergeProps,
  onCleanup,
  untrack,
} from "solid-js/dist/solid.js";
export { BTN } from "@pocketjs/framework/input";
export {
  focusNode,
  getFocused,
  pushFocusController,
  pushFocusGrid,
  pushFocusScope,
} from "@pocketjs/framework/input";
export { simulationHz, virtualNow } from "@pocketjs/framework/clock";
export {
  createElement,
  createTextNode,
  insertNode,
  release,
  render,
  replaceText,
  retain,
  runSweep,
  setProp,
} from "@pocketjs/framework/solid/renderer";

export const effect = createRenderEffect;

let requestedFrame = false;
let frameWake;
const continuousFrameLeases = new Set();
const demandFrames = new Set();
const clientFrameCallbacks = new Set();
let frameBridgeInstalled = false;
const buttonHandlerBlocks = new Set();

export function onFrame(callback) {
  acquireContinuousFrame();
  registerClientFrame(callback);
}

export function onButtonPress(mask, callback, options = {}) {
  let previousButtons = options.latched ? ~0 : 0;
  registerClientFrame((buttons) => {
    const pressed = buttons & ~previousButtons;
    previousButtons = buttons;
    const active =
      typeof options.active === "function" ? options.active() : (options.active ?? true);
    if (!active) return;
    if (buttonHandlerBlocks.size > 0 && !options.allowWhenBlocked) return;
    if (pressed & mask) callback(pressed, buttons);
  });
}

export function pushButtonHandlerBlock() {
  const block = Symbol("PocketJS button handler block");
  buttonHandlerBlocks.add(block);
  return () => {
    buttonHandlerBlocks.delete(block);
  };
}

export function after(seconds, callback) {
  const release = acquireContinuousFrame(false);
  let active = true;
  let cancel;
  try {
    cancel = schedulePocketAfter(seconds, () => {
      if (!active) return;
      active = false;
      release();
      callback();
    });
  } catch (error) {
    active = false;
    release();
    throw error;
  }
  return () => {
    if (!active) return;
    active = false;
    try {
      cancel();
    } finally {
      release();
    }
  };
}

export function createSpriteAnimation(frames, options) {
  if (frames.length === 0) {
    throw new Error("PocketJS: createSpriteAnimation() requires at least one frame");
  }
  const frameStep = Math.max(1, Math.floor(options?.frameStep ?? 1));
  const [frame, setFrame] = createClientSignal(0);
  onFrame(() => {
    setFrame((current) => (current + 1) % (frames.length * frameStep));
  });
  return () => frames[Math.floor(frame() / frameStep) % frames.length];
}

export function onDemandFrame(callback) {
  const demand = { next: true };
  demandFrames.add(demand);
  registerClientFrame((buttons) => {
    demand.next = callback(buttons) === true;
  });
  onCleanup(() => demandFrames.delete(demand));
  notifyFrameWake();
}

export function requestFrame() {
  requestedFrame = true;
  notifyFrameWake();
}

export function __hasFrameWork() {
  if (continuousFrameLeases.size > 0 || requestedFrame) return true;
  for (const demand of demandFrames) {
    if (demand.next) return true;
  }
  return false;
}

export function __consumeFrameRequest() {
  requestedFrame = false;
}

export function __setFrameWake(callback) {
  frameWake = callback;
  if (callback && __hasFrameWork()) callback();
}

export function mount(code, options = {}) {
  resetPocketRuntimeState();
  let disposeClient = () => {};
  let disposePocket;
  try {
    createRoot((dispose) => {
      disposeClient = dispose;
      disposePocket = mountPocketJs(code, options);
    });
  } catch (error) {
    try {
      disposeClient();
    } catch {
      // Preserve the causal mount error.
    }
    resetPocketRuntimeState();
    throw error;
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    let failure;
    // Stop reactive writers before Pocket destroys retained native nodes.
    // Pocket cleanup still runs if a user-owned client cleanup throws.
    try {
      disposeClient();
    } catch (error) {
      failure = error;
    }
    try {
      disposePocket?.();
    } catch (error) {
      failure ??= error;
    } finally {
      // PocketJS 0.6 keeps its mirror root in module-global state. Clearing it
      // makes a later exclusive session safe even when upstream disposal or a
      // component cleanup threw partway through teardown.
      resetPocketRuntimeState();
    }
    if (failure !== undefined) throw failure;
  };
}

function resetPocketRuntimeState() {
  continuousFrameLeases.clear();
  requestedFrame = false;
  demandFrames.clear();
  clientFrameCallbacks.clear();
  frameBridgeInstalled = false;
  buttonHandlerBlocks.clear();
  frameWake = undefined;
  resetRendererState();
  resetTextures();
  resetSprites();
  resetPack();
  resetStyles();
}

function acquireContinuousFrame(lifecycleScoped = true) {
  const lease = Symbol("PocketTUI continuous frame lease");
  continuousFrameLeases.add(lease);
  const release = () => {
    continuousFrameLeases.delete(lease);
  };
  if (lifecycleScoped) onCleanup(release);
  notifyFrameWake();
  return release;
}

function registerClientFrame(callback) {
  if (!frameBridgeInstalled) {
    registerPocketFrame((buttons) => {
      for (const frameCallback of [...clientFrameCallbacks]) frameCallback(buttons);
    });
    frameBridgeInstalled = true;
  }
  const registration = (buttons) => callback(buttons);
  clientFrameCallbacks.add(registration);
  onCleanup(() => clientFrameCallbacks.delete(registration));
}

function notifyFrameWake() {
  frameWake?.();
}
