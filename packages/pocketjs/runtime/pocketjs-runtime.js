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
import { createRenderEffect, createRoot } from "solid-js/dist/solid.js";
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
  createSpriteAnimation,
  onButtonPress,
  onFrame,
  pushButtonHandlerBlock,
} from "@pocketjs/framework/lifecycle";
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
  resetRendererState();
  resetTextures();
  resetSprites();
  resetPack();
  resetStyles();
}
