/**
 * Type-only copy of the PocketJS 0.6 host boundary used by this workspace.
 *
 * The 0.6 npm package intentionally ships TypeScript source. Importing that
 * source into this stricter monorepo makes tsc validate PocketJS internals as
 * if they were ours, so these declarations isolate the published contract.
 * Runtime imports still resolve to the pinned @pocketjs/framework package.
 */
export interface HostOps {
  createNode(type: number): number;
  destroyNode(id: number): void;
  insertBefore(parent: number, child: number, anchorOr0: number): void;
  removeChild(parent: number, child: number): void;
  setStyle(id: number, styleId: number): void;
  setProp(id: number, propId: number, value: number): void;
  setText(id: number, value: string): void;
  replaceText(id: number, value: string): void;
  uploadTexture(bytes: Uint8Array, width: number, height: number, psm: number): number;
  setImage(id: number, texture: number): void;
  setSprite(id: number, atlas: number, frames: number, columns: number, step: number): void;
  animate(
    id: number,
    propId: number,
    to: number,
    durationMs: number,
    easing: number,
    delayMs: number,
  ): number;
  cancelAnim(animationId: number): void;
  setFocus(idOr0: number): void;
  setActive?(id: number, active: number): void;
  hitTest?(x: number, y: number): number;
  setCursor?(texture: number, hotX: number, hotY: number, width: number, height: number): void;
  setCursorPos?(x: number, y: number): void;
  loadStyles?(bytes: Uint8Array): void;
  loadFontAtlas?(bytes: Uint8Array): void;
  measureText(value: string, fontSlot: number): number;
  loadTileTexture?(key: string, index: number): number;
  freeTexture?(handle: number): void;
  uploadImgEntry?(blob: Uint8Array): number;
  svcOpen?(application: string): boolean;
  svcPoll?(): string | undefined;
  svcSend?(line: string): void;
  loadImgFile?(path: string): number;
  videoOpen?(path: string): boolean;
  videoTick?(): number;
  videoTexture?(): number;
  videoClose?(): void;
  debugInspect?(id: number): void;
  debugRectXY?(): number;
  debugRectWH?(): number;
  debugPause?(enabled: boolean | number): void;
  debugStep?(): void;
  debugStats?(): string;
  __dbgActive?(): boolean;
  __dbgPoll?(): string | undefined;
  __dbgSend?(line: string): void;
  __dbgShot?(): boolean;
  __host?: string;
  __hostAbi?: number;
}

export interface RenderOptions {
  ops?: HostOps;
  styles?: Record<string, number>;
  pak?: ArrayBuffer;
}

export type MountOptions = RenderOptions;

export function mount(code: () => unknown, options?: MountOptions): () => void;
