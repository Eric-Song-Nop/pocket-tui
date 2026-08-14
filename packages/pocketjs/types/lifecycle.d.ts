export interface ButtonPressOptions {
  allowWhenBlocked?: boolean;
  active?: boolean | (() => boolean);
  latched?: boolean;
}

export interface SpriteAnimationOptions {
  frameStep?: number;
}

export function onFrame(callback: (buttons: number) => void): void;
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
