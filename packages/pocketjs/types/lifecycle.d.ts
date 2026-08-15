export interface ButtonPressOptions {
  allowWhenBlocked?: boolean;
  active?: boolean | (() => boolean);
  latched?: boolean;
}

export interface SpriteAnimationOptions {
  frameStep?: number;
}

export function onFrame(callback: (buttons: number) => void): void;
/** Run while requested; return true to lease the next scheduled frame. */
export function onDemandFrame(callback: (buttons: number) => boolean | void): void;
/** Wake an adaptive session for one frame. */
export function requestFrame(): void;
export function onButtonPress(
  mask: number,
  callback: (pressed: number, buttons: number) => void,
  options?: ButtonPressOptions,
): void;
export function pushButtonHandlerBlock(): () => void;
export function createSpriteAnimation(
  frames: readonly string[],
  options?: SpriteAnimationOptions,
): () => string;

/** @internal PocketTUI scheduler bridge. */
export function __hasFrameWork(): boolean;
/** @internal PocketTUI scheduler bridge. */
export function __consumeFrameRequest(): void;
/** @internal PocketTUI scheduler bridge. */
export function __setFrameWake(callback: (() => void) | undefined): void;
