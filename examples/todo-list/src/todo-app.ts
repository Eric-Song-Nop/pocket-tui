import {
  Button,
  Checkbox,
  POCKET_BUTTON,
  Text,
  TextInput,
  View,
  createMemo,
  createSignal,
  focusNode,
  getFocused,
  onButtonPress,
  onCleanup,
  pushFocusController,
  type NodeMirror,
  type PocketStyle,
  type TextInputHandle,
  type TuiInputEvent,
  type TuiViewportSize,
} from "@pocket-tui/pocketjs";

import {
  TODO_FILTERS,
  addTodo,
  clearCompleted,
  createTodoState,
  filterTodos,
  removeTodo,
  todoCounts,
  toggleTodo,
  type Todo,
  type TodoFilter,
  type TodoState,
} from "./todo-model.js";

const MAX_VISIBLE_ROWS = 8;

const FLEX = {
  row: 0,
  column: 1,
  start: 0,
  center: 1,
  end: 2,
  between: 3,
  stretch: 3,
  visible: 0,
  hidden: 1,
  clip: 1,
} as const;

// PocketJS colors are ABGR integers. The backend explicitly quantizes this
// small truecolor palette when the session selects conservative ANSI16.
const COLOR = {
  carbon: abgr(0x10, 0x18, 0x20),
  panel: abgr(0x16, 0x22, 0x2e),
  paper: abgr(0xea, 0xf2, 0xf8),
  blue: abgr(0x4d, 0xa3, 0xff),
  mint: abgr(0x59, 0xd6, 0x9a),
  slate: abgr(0x77, 0x88, 0x99),
} as const;

export interface TodoAppSnapshot {
  readonly state: TodoState;
  readonly filter: TodoFilter;
  readonly offset: number;
  readonly visible: readonly Todo[];
  readonly focusedTodoId?: number;
}

export interface TodoAppHandle {
  handleInput(event: TuiInputEvent): boolean;
  resize(viewport: TuiViewportSize): void;
  snapshot(): TodoAppSnapshot;
  focusComposer(): void;
}

export interface TodoAppProps {
  readonly viewport: TuiViewportSize;
  readonly requestClose: () => void;
  readonly initialState?: TodoState;
  readonly appRef?: (handle: TodoAppHandle) => void;
}

/**
 * A terminal-native PocketJS component: Solid owns the model and reactive
 * slots; PocketJS owns components/focus; the TUI backend owns Canvas/PTX/Rust.
 */
export function TodoApp(props: TodoAppProps): NodeMirror {
  const [state, setState] = createSignal(props.initialState ?? createTodoState());
  const [filter, setFilterSignal] = createSignal<TodoFilter>("all");
  const [draft, setDraft] = createSignal("");
  const [composerFocused, setComposerFocused] = createSignal(false);
  const [offset, setOffset] = createSignal(0);
  const [viewport, setViewport] = createSignal(props.viewport);
  const rowNodes: NodeMirror[] = [];
  let composer!: TextInputHandle;

  const layout = createMemo(() => todoLayout(viewport()));
  const counts = createMemo(() => todoCounts(state().todos));
  const filtered = createMemo(() => filterTodos(state().todos, filter()));
  const capacity = createMemo(() => layout().visibleRows);
  const visible = createMemo(() => {
    const start = clamp(offset(), 0, maxOffset(filtered().length, capacity()));
    return filtered().slice(start, start + capacity());
  });
  const progress = createMemo(() => progressMeter(counts().completed, counts().total));

  const title = Text({
    value: "POCKET TASKS",
    debugName: "TodoTitle",
    style: TITLE_STYLE,
  });
  const count = Text({
    value: () => `${counts().remaining} open · ${counts().total} total`,
    debugName: "TodoCount",
    style: COUNT_STYLE,
  });
  const titleRow = View({
    debugName: "TodoTitleRow",
    style: TITLE_ROW_STYLE,
    children: [title, count],
  });
  const meter = Text({
    value: progress,
    debugName: "TodoProgress",
    style: () => ({
      ...PROGRESS_STYLE,
      display: layout().showMeter ? FLEX.visible : FLEX.hidden,
    }),
  });
  const header = View({
    debugName: "TodoHeader",
    style: () => ({
      ...HEADER_STYLE,
      height: layout().headerHeight,
      gap: layout().showMeter ? 1 : 0,
      display: layout().showHeader ? FLEX.visible : FLEX.hidden,
    }),
    children: [titleRow, meter],
  });

  const input = TextInput({
    value: draft,
    onValueChange: setDraft,
    onSubmit: submitDraft,
    placeholder: "Add a task, then press Enter",
    maxLength: 240,
    debugName: "TodoComposer",
    onFocusChange: setComposerFocused,
    inputRef: (handle) => {
      composer = handle;
    },
    style: () => ({
      ...INPUT_STYLE,
      borderColor: composerFocused() ? COLOR.blue : COLOR.slate,
      bgColor: composerFocused() ? COLOR.panel : COLOR.carbon,
    }),
    textStyle: INPUT_TEXT_STYLE,
    placeholderStyle: INPUT_PLACEHOLDER_STYLE,
  });

  const listTitle = Text({
    value: () => listHeading(filter(), filtered().length, offset(), capacity()),
    debugName: "TodoListHeading",
    style: () => ({
      ...LIST_HEADING_STYLE,
      display: layout().showListHeading ? FLEX.visible : FLEX.hidden,
    }),
  });
  const rows: NodeMirror[] = [];
  for (let slot = 0; slot < MAX_VISIBLE_ROWS; slot += 1) {
    rows.push(TodoRow({
      slot,
      item: () => visible()[slot],
      onToggle: (id) => mutateAndRepair(slot, (current) => toggleTodo(current, id)),
      nodeRef: (node) => {
        rowNodes[slot] = node;
      },
    }));
  }
  const list = View({
    debugName: "TodoVirtualList",
    style: LIST_STYLE,
    children: rows,
  });

  const filterButtons = TODO_FILTERS.map((value) => FilterButton({
    value,
    selected: () => filter() === value,
    disabled: () => !layout().showActions,
    onPress: () => setFilter(value),
  }));
  const clear = ActionButton({
    label: () => `Clear ${counts().completed}`,
    disabled: () => !layout().showActions || counts().completed === 0,
    onPress: clearDoneAndRepair,
    debugName: "ClearCompleted",
  });
  const actions = View({
    debugName: "TodoActions",
    style: () => ({
      ...ACTIONS_STYLE,
      display: layout().showActions ? FLEX.visible : FLEX.hidden,
    }),
    children: [...filterButtons, clear],
  });
  const help = Text({
    value: () => layout().compact
      ? "Tab focus · Enter act · Esc quit"
      : "Tab/↑↓ focus · Enter toggle · x delete · 1–3 filter · / add · Esc quit",
    debugName: "TodoHelp",
    style: () => ({
      ...HELP_STYLE,
      display: layout().showHelp ? FLEX.visible : FLEX.hidden,
    }),
  });

  const card = View({
    debugName: "TodoCard",
    style: () => ({
      ...CARD_STYLE,
      width: layout().cardWidth,
      height: layout().cardHeight,
      paddingT: layout().padding,
      paddingR: layout().padding,
      paddingB: layout().padding,
      paddingL: layout().padding,
      gap: layout().gap,
    }),
    children: [header, input, listTitle, list, actions, help],
  });
  const root = View({
    debugName: "TodoApp",
    style: ROOT_STYLE,
    children: card,
  });

  onCleanup(pushFocusController(list, (direction) => {
    if (direction !== "up" && direction !== "down") return false;
    const slot = rowNodes.indexOf(getFocused() as NodeMirror);
    if (slot < 0) return false;
    const absolute = offset() + slot;
    const target = absolute + (direction === "down" ? 1 : -1);
    if (target < 0 || target >= filtered().length) return false;
    revealAndFocus(target);
    return true;
  }));

  onButtonPress(POCKET_BUTTON.SELECT, props.requestClose);

  const handle: TodoAppHandle = {
    handleInput,
    resize: (next) => {
      const focusedBefore = getFocused();
      const activeBefore = focusedTodo();
      const activeIndex = activeBefore === undefined
        ? -1
        : filtered().findIndex((todo) => todo.id === activeBefore.id);
      setViewport(next);
      if (capacity() === 0) {
        normalizeWindow();
        composer.focus();
        return;
      }
      if (activeIndex >= 0) {
        revealAndFocus(activeIndex);
        return;
      }
      normalizeWindow();
      if (
        !layout().showActions
        && focusedBefore !== input
        && rowNodes.indexOf(focusedBefore as NodeMirror) < 0
      ) {
        composer.focus();
      }
    },
    snapshot: () => ({
      state: state(),
      filter: filter(),
      offset: offset(),
      visible: visible(),
      focusedTodoId: focusedTodo()?.id,
    }),
    focusComposer: () => composer.focus(),
  };
  props.appRef?.(handle);
  composer.focus();
  return root;

  function submitDraft(value: string): void {
    const next = addTodo(state(), value);
    if (next === state()) return;
    setState(next);
    setDraft("");
    setFilterSignal("all");
    const last = next.todos.length - 1;
    setOffset(Math.max(0, last - capacity() + 1));
  }

  function setFilter(next: TodoFilter): void {
    setFilterSignal(next);
    setOffset(0);
    const first = rowNodes[0];
    if (
      first !== undefined
      && capacity() > 0
      && filterTodos(state().todos, next).length > 0
    ) {
      focusNode(first);
    } else {
      composer.focus();
    }
  }

  function clearDoneAndRepair(): void {
    const slot = rowNodes.indexOf(getFocused() as NodeMirror);
    const activeBefore = focusedTodo();
    const previous = state();
    const next = clearCompleted(previous);
    if (next === previous) return;
    setState(next);
    normalizeWindow();
    const nextVisible = visible();
    if (nextVisible.length === 0) {
      composer.focus();
      return;
    }
    if (activeBefore !== undefined) {
      const survivingIndex = filtered().findIndex((todo) => todo.id === activeBefore.id);
      if (survivingIndex >= 0) {
        revealAndFocus(survivingIndex);
        return;
      }
    }
    focusNode(rowNodes[clamp(slot, 0, nextVisible.length - 1)] ?? rowNodes[0] ?? null);
  }

  function mutateAndRepair(slot: number, mutate: (current: TodoState) => TodoState): void {
    const previous = state();
    const next = mutate(previous);
    if (next === previous) return;
    setState(next);
    normalizeWindow();
    const nextVisible = visible();
    if (nextVisible.length === 0) {
      composer.focus();
      return;
    }
    focusNode(rowNodes[Math.min(slot, nextVisible.length - 1)] ?? rowNodes[0] ?? null);
  }

  function focusedTodo(): Todo | undefined {
    const slot = rowNodes.indexOf(getFocused() as NodeMirror);
    return slot < 0 ? undefined : visible()[slot];
  }

  function handleInput(event: TuiInputEvent): boolean {
    const activeTodo = focusedTodo();
    if (event.kind === "key" && (event.key === "page-up" || event.key === "page-down")) {
      if (activeTodo === undefined) return false;
      const index = filtered().findIndex((todo) => todo.id === activeTodo.id);
      const delta = event.key === "page-down" ? capacity() : -capacity();
      revealAndFocus(clamp(index + delta, 0, Math.max(0, filtered().length - 1)));
      return true;
    }
    if (event.kind === "key" && event.key === "backspace" && activeTodo !== undefined) {
      const slot = rowNodes.indexOf(getFocused() as NodeMirror);
      mutateAndRepair(slot, (current) => removeTodo(current, activeTodo.id));
      return true;
    }
    if (event.kind !== "text" || getFocused() === input) return false;
    const shortcuts = [...event.text];
    if (shortcuts.length === 0 || shortcuts.some((value) => !isTodoShortcut(value))) {
      return false;
    }
    for (const shortcut of shortcuts) handleTodoShortcut(shortcut);
    return true;
  }

  function handleTodoShortcut(shortcut: string): void {
    if (shortcut === "x" || shortcut === "X") {
      const item = focusedTodo();
      if (item === undefined) return;
      const slot = rowNodes.indexOf(getFocused() as NodeMirror);
      mutateAndRepair(slot, (current) => removeTodo(current, item.id));
      return;
    }
    if (shortcut === "/") {
      composer.focus();
      return;
    }
    if (shortcut === "c" || shortcut === "C") {
      clearDoneAndRepair();
      return;
    }
    if (shortcut === "q" || shortcut === "Q") {
      props.requestClose();
      return;
    }
    setFilter(shortcut === "1" ? "all" : shortcut === "2" ? "open" : "done");
  }

  function revealAndFocus(index: number): void {
    const size = capacity();
    if (size <= 0) {
      normalizeWindow();
      composer.focus();
      return;
    }
    let nextOffset = offset();
    if (index < nextOffset) nextOffset = index;
    else if (index >= nextOffset + size) nextOffset = index - size + 1;
    nextOffset = clamp(nextOffset, 0, maxOffset(filtered().length, size));
    setOffset(nextOffset);
    focusNode(rowNodes[index - nextOffset] ?? null);
  }

  function normalizeWindow(): void {
    setOffset((current) => clamp(current, 0, maxOffset(filtered().length, capacity())));
  }
}

interface TodoRowProps {
  readonly slot: number;
  readonly item: () => Todo | undefined;
  readonly onToggle: (id: number) => void;
  readonly nodeRef: (node: NodeMirror) => void;
}

function TodoRow(props: TodoRowProps): NodeMirror {
  const [focused, setFocused] = createSignal(false);
  return Checkbox({
    checked: () => props.item()?.completed ?? false,
    label: () => props.item()?.title ?? "",
    disabled: () => props.item() === undefined,
    onChange: () => {
      const item = props.item();
      if (item !== undefined) props.onToggle(item.id);
    },
    onFocusChange: setFocused,
    nodeRef: props.nodeRef,
    debugName: `TodoRow${props.slot + 1}`,
    style: () => ({
      ...ROW_STYLE,
      display: props.item() === undefined ? FLEX.hidden : FLEX.visible,
      bgColor: focused() ? COLOR.blue : COLOR.carbon,
      borderColor: focused() ? COLOR.blue : COLOR.panel,
    }),
    labelStyle: () => ({
      textColor: focused()
        ? COLOR.carbon
        : props.item()?.completed
          ? COLOR.mint
          : COLOR.paper,
    }),
  });
}

interface ActionButtonProps {
  readonly label: string | (() => string);
  readonly onPress: () => void;
  readonly disabled?: () => boolean;
  readonly selected?: () => boolean;
  readonly debugName: string;
}

function ActionButton(props: ActionButtonProps): NodeMirror {
  const [focused, setFocused] = createSignal(false);
  return Button({
    label: props.label,
    onPress: props.onPress,
    disabled: props.disabled,
    onFocusChange: setFocused,
    debugName: props.debugName,
    style: () => ({
      ...ACTION_STYLE,
      bgColor: focused() ? COLOR.blue : props.selected?.() ? COLOR.panel : COLOR.carbon,
      borderColor: focused() || props.selected?.() ? COLOR.blue : COLOR.slate,
    }),
    labelStyle: () => ({
      textColor: focused() ? COLOR.carbon : props.disabled?.() ? COLOR.slate : COLOR.paper,
    }),
  });
}

function FilterButton(props: {
  readonly value: TodoFilter;
  readonly selected: () => boolean;
  readonly disabled: () => boolean;
  readonly onPress: () => void;
}): NodeMirror {
  return ActionButton({
    label: () => `${props.selected() ? "●" : "○"} ${capitalize(props.value)}`,
    selected: props.selected,
    disabled: props.disabled,
    onPress: props.onPress,
    debugName: `Filter${capitalize(props.value)}`,
  });
}

interface TodoLayout {
  readonly cardWidth: number;
  readonly cardHeight: number;
  readonly padding: number;
  readonly visibleRows: number;
  readonly gap: number;
  readonly headerHeight: number;
  readonly compact: boolean;
  readonly showHeader: boolean;
  readonly showMeter: boolean;
  readonly showListHeading: boolean;
  readonly showActions: boolean;
  readonly showHelp: boolean;
}

function todoLayout(viewport: TuiViewportSize): TodoLayout {
  const columns = Math.max(1, Math.floor(viewport.columns));
  const rows = Math.max(1, Math.floor(viewport.rows));
  const compact = columns < 54 || rows < 24;
  const padding = columns >= 34 && rows >= 14 ? 1 : 0;
  const cardWidth = Math.max(1, Math.min(72, columns - (columns >= 76 ? 4 : 0)));
  const cardHeight = Math.max(1, Math.min(34, rows));
  const gap = rows >= 14 ? 1 : 0;
  const showHeader = rows >= 6;
  const showMeter = rows >= 16;
  const showListHeading = rows >= 12;
  const showActions = rows >= 19 && columns >= 40;
  const showHelp = rows >= 22 && columns >= 54;
  const headerHeight = showHeader ? (showMeter ? 3 : 1) : 0;
  const fixedHeight = headerHeight
    + 3
    + (showListHeading ? 1 : 0)
    + (showActions ? 3 : 0)
    + (showHelp ? 1 : 0);
  const visibleBlocks = 2
    + (showHeader ? 1 : 0)
    + (showListHeading ? 1 : 0)
    + (showActions ? 1 : 0)
    + (showHelp ? 1 : 0);
  const innerHeight = Math.max(0, cardHeight - padding * 2);
  const listHeight = Math.max(0, innerHeight - fixedHeight - Math.max(0, visibleBlocks - 1) * gap);
  const visibleRows = clamp(Math.floor(listHeight / 3), 0, MAX_VISIBLE_ROWS);
  return {
    cardWidth,
    cardHeight,
    padding,
    visibleRows,
    gap,
    headerHeight,
    compact,
    showHeader,
    showMeter,
    showListHeading,
    showActions,
    showHelp,
  };
}

function listHeading(
  filter: TodoFilter,
  count: number,
  offset: number,
  capacity: number,
): string {
  const start = count === 0 ? 0 : Math.min(count, offset + 1);
  const end = Math.min(count, offset + capacity);
  return `${filter.toUpperCase()}  ${start}–${end} / ${count}`;
}

function progressMeter(completed: number, total: number): string {
  const cells = 10;
  const filled = total === 0 ? 0 : Math.round((completed / total) * cells);
  return `${"■".repeat(filled)}${"□".repeat(cells - filled)}  ${completed}/${total} done`;
}

function maxOffset(length: number, capacity: number): number {
  return Math.max(0, length - Math.max(1, capacity));
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function isTodoShortcut(value: string): boolean {
  return value === "x"
    || value === "X"
    || value === "c"
    || value === "C"
    || value === "q"
    || value === "Q"
    || value === "/"
    || value === "1"
    || value === "2"
    || value === "3";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function abgr(red: number, green: number, blue: number): number {
  return ((0xff << 24) | (blue << 16) | (green << 8) | red) >>> 0;
}

const ROOT_STYLE: PocketStyle = {
  width: -1,
  height: -1,
  flexDir: FLEX.column,
  justify: FLEX.center,
  align: FLEX.center,
  overflow: FLEX.clip,
  bgColor: COLOR.carbon,
};

const CARD_STYLE: PocketStyle = {
  flexDir: FLEX.column,
  gap: 1,
  overflow: FLEX.clip,
  bgColor: COLOR.carbon,
  borderColor: COLOR.slate,
  borderWidth: 1,
};

const HEADER_STYLE: PocketStyle = {
  width: -1,
  height: 3,
  flexDir: FLEX.column,
  gap: 1,
};

const TITLE_ROW_STYLE: PocketStyle = {
  width: -1,
  height: 1,
  flexDir: FLEX.row,
  justify: FLEX.between,
  align: FLEX.center,
};

const TITLE_STYLE: PocketStyle = { height: 1, textColor: COLOR.paper };
const COUNT_STYLE: PocketStyle = { height: 1, textColor: COLOR.slate, textAlign: FLEX.end };
const PROGRESS_STYLE: PocketStyle = { width: -1, height: 1, textColor: COLOR.blue };

const INPUT_STYLE: PocketStyle = {
  width: -1,
  height: 3,
  paddingT: 1,
  paddingR: 1,
  paddingB: 1,
  paddingL: 1,
  borderWidth: 1,
  overflow: FLEX.clip,
};

const INPUT_TEXT_STYLE: PocketStyle = { textColor: COLOR.paper };
const INPUT_PLACEHOLDER_STYLE: PocketStyle = { textColor: COLOR.slate };
const LIST_HEADING_STYLE: PocketStyle = { width: -1, height: 1, textColor: COLOR.slate };

const LIST_STYLE: PocketStyle = {
  width: -1,
  grow: 1,
  shrink: 1,
  flexDir: FLEX.column,
  overflow: FLEX.clip,
};

const ROW_STYLE: PocketStyle = {
  width: -1,
  height: 3,
  shrink: 0,
  paddingT: 1,
  paddingR: 1,
  paddingB: 1,
  paddingL: 1,
  flexDir: FLEX.row,
  align: FLEX.center,
  borderWidth: 1,
};

const ACTIONS_STYLE: PocketStyle = {
  width: -1,
  height: 3,
  shrink: 0,
  flexDir: FLEX.row,
  gap: 1,
};

const ACTION_STYLE: PocketStyle = {
  width: 12,
  height: 3,
  grow: 1,
  shrink: 1,
  paddingT: 1,
  paddingR: 1,
  paddingB: 1,
  paddingL: 1,
  flexDir: FLEX.row,
  align: FLEX.center,
  borderWidth: 1,
};

const HELP_STYLE: PocketStyle = {
  width: -1,
  height: 1,
  shrink: 0,
  textColor: COLOR.slate,
  textAlign: FLEX.center,
};
