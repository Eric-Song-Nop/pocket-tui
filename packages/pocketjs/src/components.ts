import type { TuiInputEvent } from "@pocket-tui/core";
import {
  createElement,
  createSignal,
  createTextNode,
  effect,
  focusNode,
  getFocused,
  insertNode,
  onCleanup,
  replaceText,
  setProp,
  type NodeMirror,
} from "#pocketjs-runtime";

import {
  registerButtonInteraction,
  registerTextInteraction,
  type TextInteraction,
} from "./interaction.js";
import { ENUM, SIZE_FULL } from "./spec.js";
import { graphemes, wrapText } from "./unicode.js";

export type PocketStyle = Readonly<Record<string, number | string>>;
export type ReactiveValue<T> = T | (() => T);

export interface ButtonProps {
  label: ReactiveValue<string>;
  onPress: () => void;
  disabled?: ReactiveValue<boolean>;
  class?: ReactiveValue<string | undefined>;
  style?: ReactiveValue<PocketStyle | undefined>;
  labelStyle?: ReactiveValue<PocketStyle | undefined>;
  debugName?: string;
  nodeRef?: (node: NodeMirror) => void;
}

/** A focusable PocketJS button with terminal-cell defaults. */
export function Button(props: ButtonProps): NodeMirror {
  const root = createElement("view");
  const label = createTextNode("");
  insertNode(root, label);

  setProp(root, "onPress", () => {
    if (!read(props.disabled, false)) props.onPress();
  });
  setProp(root, "debugName", props.debugName ?? "Button");
  reactiveProp(root, "focusable", () => !read(props.disabled, false));
  reactiveProp(root, "class", () => read(props.class));
  reactiveProp(root, "style", () => ({
    ...BUTTON_STYLE,
    ...read(props.style),
  }));
  reactiveProp(label, "style", () => ({
    ...BUTTON_LABEL_STYLE,
    ...read(props.labelStyle),
  }));
  effect<string | undefined>((previous) => {
    const next = read(props.label);
    if (next !== previous) replaceText(label, next);
    return next;
  });
  onCleanup(registerButtonInteraction(root));
  props.nodeRef?.(root);
  return root;
}

export interface CheckboxProps extends Omit<ButtonProps, "label" | "onPress"> {
  checked: ReactiveValue<boolean>;
  label: ReactiveValue<string>;
  onChange: (checked: boolean) => void;
  checkedGlyph?: string;
  uncheckedGlyph?: string;
}

/** A button-backed boolean control that participates in the same focus tree. */
export function Checkbox(props: CheckboxProps): NodeMirror {
  return Button({
    ...props,
    debugName: props.debugName ?? "Checkbox",
    label: () =>
      `${read(props.checked) ? (props.checkedGlyph ?? "☒") : (props.uncheckedGlyph ?? "☐")} ${read(props.label)}`,
    onPress: () => props.onChange(!read(props.checked)),
  });
}

export interface TextInputHandle {
  readonly node: NodeMirror;
  focus(): void;
  blur(): void;
  value(): string;
  setValue(value: string): void;
  caret(): number;
  setCaret(index: number): void;
}

export interface TextInputProps {
  /** A getter makes the input controlled; otherwise defaultValue owns state locally. */
  value?: () => string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: ReactiveValue<string>;
  disabled?: ReactiveValue<boolean>;
  multiline?: boolean;
  password?: boolean;
  maxLength?: number;
  class?: ReactiveValue<string | undefined>;
  style?: ReactiveValue<PocketStyle | undefined>;
  textStyle?: ReactiveValue<PocketStyle | undefined>;
  placeholderStyle?: ReactiveValue<PocketStyle | undefined>;
  debugName?: string;
  nodeRef?: (node: NodeMirror) => void;
  inputRef?: (handle: TextInputHandle) => void;
}

/**
 * A grapheme-aware terminal text input. Raw text, paste, editing keys, and the
 * real terminal caret are routed only while this node owns Pocket focus.
 */
export function TextInput(props: TextInputProps): NodeMirror {
  validateTextInputProps(props);
  const root = createElement("view");
  const text = createTextNode("");
  insertNode(root, text);
  const [localValue, setLocalValue] = createSignal(props.value?.() ?? props.defaultValue ?? "");
  let caret = graphemes(currentValue()).length;
  let observedLength = caret;

  function currentValue(): string {
    return localValue();
  }

  function normalize(value: string): string {
    const normalized = props.multiline ? value.replaceAll("\r\n", "\n").replaceAll("\r", "\n") : value.replace(/[\r\n]+/g, " ");
    const items = graphemes(normalized);
    return props.maxLength === undefined
      ? normalized
      : items.slice(0, props.maxLength).map((item) => item.text).join("");
  }

  function commit(value: string, nextCaret: number): void {
    const next = normalize(value);
    const length = graphemes(next).length;
    caret = clamp(nextCaret, 0, length);
    setLocalValue(next);
    props.onValueChange?.(next);
    caret = clamp(caret, 0, graphemes(currentValue()).length);
  }

  function replaceSelection(inserted: string): void {
    const before = graphemes(currentValue()).map((item) => item.text);
    const addition = graphemes(normalize(inserted)).map((item) => item.text);
    const available = props.maxLength === undefined
      ? addition.length
      : Math.max(0, props.maxLength - before.length);
    const accepted = addition.slice(0, available);
    before.splice(caret, 0, ...accepted);
    commit(before.join(""), caret + accepted.length);
  }

  const interaction: TextInteraction = {
    node: root,
    cursorNode: text,
    handleInput: (event) => handleTextInputEvent(event),
    cursorOffset: (width, height) => textCursorOffset(displayValue(false), caret, width, height),
  };

  function handleTextInputEvent(event: TuiInputEvent): boolean {
    if (read(props.disabled, false) || event.kind === "resize") return false;
    if (event.kind === "text") {
      replaceSelection(event.text);
      return true;
    }
    if (event.kind === "paste-start" || event.kind === "paste-end") return true;
    if (event.kind === "paste-chunk") {
      replaceSelection(event.text);
      return true;
    }
    if (event.kind !== "key") return false;
    const items = graphemes(currentValue()).map((item) => item.text);
    switch (event.key) {
      case "arrow-left":
        caret = Math.max(0, caret - 1);
        return true;
      case "arrow-right":
        caret = Math.min(items.length, caret + 1);
        return true;
      case "home":
        caret = 0;
        return true;
      case "end":
        caret = items.length;
        return true;
      case "backspace":
        if (caret > 0) {
          items.splice(caret - 1, 1);
          commit(items.join(""), caret - 1);
        }
        return true;
      case "delete":
        if (caret < items.length) {
          items.splice(caret, 1);
          commit(items.join(""), caret);
        }
        return true;
      case "enter":
        if (props.multiline) replaceSelection("\n");
        else props.onSubmit?.(currentValue());
        return true;
      default:
        return false;
    }
  }

  function displayValue(includePlaceholder = true): string {
    const value = currentValue();
    if (value.length === 0 && includePlaceholder) return read(props.placeholder, "");
    if (!props.password) return value;
    return graphemes(value).map(() => "•").join("");
  }

  setProp(root, "debugName", props.debugName ?? "TextInput");
  if (props.value !== undefined) {
    effect<string | undefined>((previous) => {
      const next = normalize(props.value?.() ?? "");
      if (next !== previous) setLocalValue(next);
      return next;
    });
  }
  reactiveProp(root, "focusable", () => !read(props.disabled, false));
  reactiveProp(root, "class", () => read(props.class));
  reactiveProp(root, "style", () => ({
    ...TEXT_INPUT_STYLE,
    ...read(props.style),
  }));
  reactiveProp(text, "style", () => ({
    ...TEXT_INPUT_TEXT_STYLE,
    ...(currentValue().length === 0 ? PLACEHOLDER_STYLE : undefined),
    ...(currentValue().length === 0 ? read(props.placeholderStyle) : read(props.textStyle)),
  }));
  effect<string | undefined>((previous) => {
    const value = currentValue();
    const length = graphemes(value).length;
    if (caret === observedLength) caret = length;
    else caret = Math.min(caret, length);
    observedLength = length;
    const display = displayValue();
    if (display !== previous) replaceText(text, display);
    return display;
  });

  const unregister = registerTextInteraction(interaction);
  onCleanup(unregister);
  const handle: TextInputHandle = {
    node: root,
    focus: () => focusNode(root),
    blur: () => {
      if (getFocused() === root) focusNode(null);
    },
    value: currentValue,
    setValue: (value) => commit(value, graphemes(normalize(value)).length),
    caret: () => caret,
    setCaret: (index) => {
      if (!Number.isInteger(index)) throw new RangeError("PocketTUI: caret index must be an integer");
      caret = clamp(index, 0, graphemes(currentValue()).length);
    },
  };
  props.nodeRef?.(root);
  props.inputRef?.(handle);
  return root;
}

function textCursorOffset(
  value: string,
  caret: number,
  width: number,
  height: number,
): { row: number; column: number } {
  const prefix = graphemes(value)
    .slice(0, caret)
    .map((item) => item.text)
    .join("");
  const lines = wrapText(prefix, Math.max(1, width));
  const last = lines.at(-1) ?? [];
  return {
    row: clamp(lines.length - 1, 0, Math.max(0, height - 1)),
    column: clamp(last.reduce((sum, item) => sum + item.width, 0), 0, Math.max(0, width - 1)),
  };
}

function reactiveProp<T>(node: NodeMirror, name: string, value: () => T): void {
  effect<T | undefined>((previous) => setProp(node, name, value(), previous));
}

function read<T>(value: ReactiveValue<T>): T;
function read<T>(value: ReactiveValue<T> | undefined, fallback: T): T;
function read<T>(value: ReactiveValue<T> | undefined): T | undefined;
function read<T>(value: ReactiveValue<T> | undefined, fallback?: T): T | undefined {
  if (value === undefined) return fallback;
  return typeof value === "function" ? (value as () => T)() : value;
}

function validateTextInputProps(props: TextInputProps): void {
  if (props.value !== undefined && props.defaultValue !== undefined) {
    throw new TypeError("PocketTUI: TextInput cannot combine value and defaultValue");
  }
  if (props.maxLength !== undefined && (!Number.isInteger(props.maxLength) || props.maxLength < 0)) {
    throw new RangeError("PocketTUI: TextInput maxLength must be a non-negative integer");
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

const BUTTON_STYLE: PocketStyle = {
  width: SIZE_FULL,
  height: 3,
  paddingT: 1,
  paddingR: 1,
  paddingB: 1,
  paddingL: 1,
  flexDir: ENUM.flexRow,
  align: ENUM.alignCenter,
};

const BUTTON_LABEL_STYLE: PocketStyle = {};

const TEXT_INPUT_STYLE: PocketStyle = {
  width: SIZE_FULL,
  height: 3,
  paddingT: 1,
  paddingR: 1,
  paddingB: 1,
  paddingL: 1,
  overflow: ENUM.overflowHidden,
};

const TEXT_INPUT_TEXT_STYLE: PocketStyle = {};

const PLACEHOLDER_STYLE: PocketStyle = {
  textColor: 0xff88_8888,
};
