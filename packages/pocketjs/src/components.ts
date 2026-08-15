import type { TuiInputEvent } from "@pocket-tui/core";
import {
  batch,
  createElement,
  createMemo,
  createSignal,
  createTextNode,
  effect,
  focusNode,
  getFocused,
  insertNode,
  onCleanup,
  replaceText,
  requestFrame,
  setProp,
  type NodeMirror,
} from "#pocketjs-runtime";

import {
  registerButtonInteraction,
  registerFocusListener,
  registerTextInteraction,
  type TextInteraction,
} from "./interaction.js";
import { ENUM, SIZE_FULL } from "./spec.js";
import { graphemes, wrapText } from "./unicode.js";

export type PocketStyle = Readonly<Record<string, number | string>>;
export type ReactiveValue<T> = T | (() => T);

export interface ViewProps {
  children?: NodeMirror | readonly NodeMirror[];
  class?: ReactiveValue<string | undefined>;
  style?: ReactiveValue<PocketStyle | undefined>;
  debugName?: string;
  nodeRef?: (node: NodeMirror) => void;
}

/** A retained PocketJS view primitive bound to the client Solid runtime. */
export function View(props: ViewProps = {}): NodeMirror {
  const node = createElement("view");
  setProp(node, "debugName", props.debugName ?? "View");
  reactiveProp(node, "class", () => read(props.class));
  reactiveProp(node, "style", () => read(props.style));
  const children = props.children === undefined
    ? []
    : Array.isArray(props.children)
      ? props.children
      : [props.children];
  for (const child of children) insertNode(node, child);
  props.nodeRef?.(node);
  return node;
}

export interface TextProps {
  value: ReactiveValue<string>;
  class?: ReactiveValue<string | undefined>;
  style?: ReactiveValue<PocketStyle | undefined>;
  debugName?: string;
  nodeRef?: (node: NodeMirror) => void;
}

/** A retained PocketJS text primitive with reactive content and style. */
export function Text(props: TextProps): NodeMirror {
  const node = createElement("text");
  const content = createTextNode("");
  insertNode(node, content);
  setProp(node, "debugName", props.debugName ?? "Text");
  reactiveProp(node, "class", () => read(props.class));
  reactiveProp(node, "style", () => read(props.style));
  effect<string | undefined>((previous) => {
    const next = read(props.value);
    if (next !== previous) replaceText(content, next);
    return next;
  });
  props.nodeRef?.(node);
  return node;
}

export interface ButtonProps {
  label: ReactiveValue<string>;
  onPress: () => void;
  disabled?: ReactiveValue<boolean>;
  class?: ReactiveValue<string | undefined>;
  style?: ReactiveValue<PocketStyle | undefined>;
  labelStyle?: ReactiveValue<PocketStyle | undefined>;
  onFocusChange?: (focused: boolean) => void;
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
  const unregisterButton = registerButtonInteraction(root);
  let unregisterFocus: (() => void) | undefined;
  try {
    unregisterFocus = props.onFocusChange === undefined
      ? undefined
      : registerFocusListener(root, props.onFocusChange);
  } catch (error) {
    unregisterButton();
    throw error;
  }
  onCleanup(() => {
    unregisterFocus?.();
    unregisterButton();
  });
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
  /** Normal text state. Repeat every key used only by placeholderStyle so it can be restored. */
  textStyle?: ReactiveValue<PocketStyle | undefined>;
  /**
   * Placeholder text state. HostOps cannot unset omitted inline style keys.
   * Editable text always pins textAlign=left, tracking=0, and lineHeight=1 so
   * the terminal cursor remains cell-exact.
   */
  placeholderStyle?: ReactiveValue<PocketStyle | undefined>;
  onFocusChange?: (focused: boolean) => void;
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
  const [localValue, setLocalValue] = createSignal(normalize(
    props.value?.() ?? props.defaultValue ?? "",
  ));
  const [caret, setCaret] = createSignal(graphemes(currentValue()).length);
  const [textViewport, setTextViewport] = createSignal({ width: 0, height: 0 });
  let observedLength = caret();

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
    batch(() => {
      setCaret(clamp(nextCaret, 0, length));
      setLocalValue(next);
    });
    props.onValueChange?.(next);
    setCaret((current) => clamp(current, 0, graphemes(currentValue()).length));
  }

  function replaceSelection(inserted: string): void {
    const before = graphemes(currentValue()).map((item) => item.text);
    const addition = graphemes(normalize(inserted)).map((item) => item.text);
    const available = props.maxLength === undefined
      ? addition.length
      : Math.max(0, props.maxLength - before.length);
    const accepted = addition.slice(0, available);
    const currentCaret = caret();
    before.splice(currentCaret, 0, ...accepted);
    commit(before.join(""), currentCaret + accepted.length);
  }

  const displayed = createMemo(() => inputDisplay(
    currentValue(),
    caret(),
    props.password === true,
    props.multiline === true,
    textViewport().width,
    textViewport().height,
    read(props.placeholder, ""),
  ));

  const interaction: TextInteraction = {
    node: root,
    cursorNode: text,
    handleInput: (event) => handleTextInputEvent(event),
    updateViewport: (width, height) => {
      const previous = textViewport();
      if (previous.width === width && previous.height === height) return false;
      setTextViewport({ width, height });
      return true;
    },
    cursorOffset: (width, height) => {
      return {
        row: clamp(displayed().caretRow, 0, Math.max(0, height - 1)),
        column: clamp(displayed().caretColumn, 0, Math.max(0, width - 1)),
      };
    },
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
        setCaret((current) => Math.max(0, current - 1));
        return true;
      case "arrow-right":
        setCaret((current) => Math.min(items.length, current + 1));
        return true;
      case "home":
        setCaret(0);
        return true;
      case "end":
        setCaret(items.length);
        return true;
      case "backspace":
        if (caret() > 0) {
          items.splice(caret() - 1, 1);
          commit(items.join(""), caret() - 1);
        }
        return true;
      case "delete":
        if (caret() < items.length) {
          items.splice(caret(), 1);
          commit(items.join(""), caret());
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
    flexDir: ENUM.flexColumn,
    align: ENUM.alignStretch,
    overflow: ENUM.overflowHidden,
  }));
  reactiveProp(text, "style", () => ({
    ...TEXT_INPUT_TEXT_STYLE,
    ...(currentValue().length === 0 ? PLACEHOLDER_STYLE : undefined),
    ...(currentValue().length === 0 ? read(props.placeholderStyle) : read(props.textStyle)),
    // Cursor math and horizontal windowing are cell-exact only with these
    // conventional terminal-input metrics. Decorative tracking/alignment
    // belongs on surrounding Text, not on the editable caret line.
    textAlign: ENUM.textLeft,
    height: props.multiline ? SIZE_FULL : 1,
    lineHeight: 1,
    tracking: 0,
  }));
  effect<string | undefined>((previous) => {
    const value = currentValue();
    const length = graphemes(value).length;
    if (caret() === observedLength) setCaret(length);
    else setCaret((current) => Math.min(current, length));
    observedLength = length;
    const display = displayed().text;
    if (display !== previous) replaceText(text, display);
    return display;
  });

  const unregisterText = registerTextInteraction(interaction);
  let unregisterFocus: (() => void) | undefined;
  try {
    unregisterFocus = props.onFocusChange === undefined
      ? undefined
      : registerFocusListener(root, props.onFocusChange);
  } catch (error) {
    unregisterText();
    throw error;
  }
  onCleanup(() => {
    unregisterFocus?.();
    unregisterText();
  });
  const handle: TextInputHandle = {
    node: root,
    focus: () => focusNode(root),
    blur: () => {
      if (getFocused() === root) focusNode(null);
    },
    value: currentValue,
    setValue: (value) => commit(value, graphemes(normalize(value)).length),
    caret,
    setCaret: (index) => {
      if (!Number.isInteger(index)) throw new RangeError("PocketTUI: caret index must be an integer");
      setCaret(clamp(index, 0, graphemes(currentValue()).length));
      requestFrame();
    },
  };
  props.nodeRef?.(root);
  props.inputRef?.(handle);
  return root;
}

interface InputDisplay {
  readonly text: string;
  readonly caretRow: number;
  readonly caretColumn: number;
}

function inputDisplay(
  value: string,
  caret: number,
  password: boolean,
  multiline: boolean,
  viewportWidth: number,
  viewportHeight: number,
  placeholder: string,
): InputDisplay {
  if (multiline) {
    return multilineInputDisplay(
      value.length === 0 ? placeholder : passwordText(value, password),
      value.length === 0 ? 0 : caret,
      viewportWidth,
      viewportHeight,
    );
  }

  const width = Math.max(0, Math.floor(viewportWidth));
  if (value.length === 0) {
    return {
      text: width === 0 ? placeholder : fitText(placeholder, width),
      caretRow: 0,
      caretColumn: 0,
    };
  }

  const source = graphemes(passwordText(value, password));
  const boundedCaret = clamp(caret, 0, source.length);
  if (width === 0) {
    return {
      text: source.map((item) => item.text).join(""),
      caretRow: 0,
      caretColumn: source
        .slice(0, boundedCaret)
        .reduce((sum, item) => sum + item.width, 0),
    };
  }

  // Keep one terminal cell free when the caret is at the end so the real bar
  // cursor never has to overlap the final grapheme. Moving left reveals the
  // earliest window that can still contain the caret.
  let start = 0;
  let caretColumn = source
    .slice(0, boundedCaret)
    .reduce((sum, item) => sum + item.width, 0);
  while (caretColumn > width - 1 && start < boundedCaret) {
    caretColumn -= source[start]?.width ?? 0;
    start += 1;
  }

  const textLimit = Math.max(0, width - (boundedCaret === source.length ? 1 : 0));
  let used = 0;
  let text = "";
  for (let index = start; index < source.length; index += 1) {
    const item = source[index];
    if (item === undefined || used + item.width > textLimit) break;
    text += item.text;
    used += item.width;
  }
  return { text, caretRow: 0, caretColumn };
}

function multilineInputDisplay(
  value: string,
  caret: number,
  viewportWidth: number,
  viewportHeight: number,
): InputDisplay {
  const width = Math.max(0, Math.floor(viewportWidth));
  const height = Math.max(0, Math.floor(viewportHeight));
  const items = graphemes(value);
  const boundedCaret = clamp(caret, 0, items.length);
  if (width === 0 || height === 0) {
    return { text: value, caretRow: 0, caretColumn: 0 };
  }

  const lines = wrapText(value, width);
  const prefix = items.slice(0, boundedCaret).map((item) => item.text).join("");
  const prefixLines = wrapText(prefix, width);
  let logicalCaretRow = Math.max(0, prefixLines.length - 1);
  let caretColumn = (prefixLines.at(-1) ?? [])
    .reduce((sum, item) => sum + item.width, 0);
  // A caret immediately after a cell-exact full line belongs at the start of
  // the next visual row. wrapText intentionally omits that trailing empty row,
  // so materialize it for cursor/window calculations.
  if (caretColumn === width) {
    logicalCaretRow += 1;
    caretColumn = 0;
  }
  while (lines.length <= logicalCaretRow) lines.push([]);
  const start = clamp(
    logicalCaretRow - height + 1,
    0,
    Math.max(0, lines.length - height),
  );
  const text = lines
    .slice(start, start + height)
    .map((line) => line.map((item) => item.text).join(""))
    .join("\n");
  return {
    text,
    caretRow: logicalCaretRow - start,
    caretColumn,
  };
}

function passwordText(value: string, password: boolean): string {
  return password
    ? graphemes(value).map((item) => item.text.includes("\n") ? "\n" : "•").join("")
    : value;
}

function fitText(value: string, width: number): string {
  let used = 0;
  let text = "";
  for (const item of graphemes(value)) {
    if (used + item.width > width) break;
    text += item.text;
    used += item.width;
  }
  return text;
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

const TEXT_INPUT_TEXT_STYLE: PocketStyle = {
  textColor: 0xffff_ffff,
};

const PLACEHOLDER_STYLE: PocketStyle = {
  textColor: 0xff88_8888,
};
