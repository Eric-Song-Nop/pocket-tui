export type TodoFilter = "all" | "open" | "done";

export const TODO_FILTERS: readonly TodoFilter[] = Object.freeze([
  "all",
  "open",
  "done",
]);

export interface Todo {
  readonly id: number;
  readonly title: string;
  readonly completed: boolean;
}

export interface TodoState {
  readonly todos: readonly Todo[];
  /** The next monotonic identifier. Removed identifiers are never reused. */
  readonly nextId: number;
}

export interface TodoCounts {
  readonly total: number;
  readonly remaining: number;
  readonly completed: number;
}

/** Seed content keeps the example useful on its first frame. */
export const DEMO_TODOS: readonly Todo[] = freezeTodos([
  { id: 1, title: "Keep PocketJS state retained", completed: false },
  { id: 2, title: "Drive the view with Solid signals", completed: true },
  { id: 3, title: "Let Rust paint terminal damage", completed: false },
]);

/** Return a fresh deterministic state backed by immutable demo todos. */
export function createTodoState(): TodoState {
  return freezeState([...DEMO_TODOS], 4);
}

/** Add a trimmed todo, or reject blank input by preserving the current state. */
export function addTodo(state: TodoState, title: string): TodoState {
  const normalized = title.trim();
  if (normalized.length === 0) return state;

  const todo = freezeTodo({
    id: state.nextId,
    title: normalized,
    completed: false,
  });
  return freezeState([...state.todos, todo], state.nextId + 1);
}

/** Toggle one todo without replacing unaffected todo objects. */
export function toggleTodo(state: TodoState, id: number): TodoState {
  const index = state.todos.findIndex((todo) => todo.id === id);
  if (index < 0) return state;

  const todos = [...state.todos];
  const current = todos[index];
  if (current === undefined) return state;
  todos[index] = freezeTodo({ ...current, completed: !current.completed });
  return freezeState(todos, state.nextId);
}

/** Remove one todo while keeping the monotonic id counter unchanged. */
export function removeTodo(state: TodoState, id: number): TodoState {
  const todos = state.todos.filter((todo) => todo.id !== id);
  return todos.length === state.todos.length
    ? state
    : freezeState(todos, state.nextId);
}

/** Remove all completed todos, preserving open todo identities. */
export function clearCompleted(state: TodoState): TodoState {
  const todos = state.todos.filter((todo) => !todo.completed);
  return todos.length === state.todos.length
    ? state
    : freezeState(todos, state.nextId);
}

/** Select todos for the requested presentation filter. */
export function filterTodos(
  todos: readonly Todo[],
  filter: TodoFilter,
): readonly Todo[] {
  switch (filter) {
    case "all":
      return todos;
    case "open":
      return todos.filter((todo) => !todo.completed);
    case "done":
      return todos.filter((todo) => todo.completed);
  }
}

/** Derive the complete summary in one bounded pass. */
export function todoCounts(todos: readonly Todo[]): TodoCounts {
  let completed = 0;
  for (const todo of todos) {
    if (todo.completed) completed += 1;
  }
  return Object.freeze({
    total: todos.length,
    remaining: todos.length - completed,
    completed,
  });
}

function freezeTodo(todo: Todo): Todo {
  return Object.freeze(todo);
}

function freezeTodos(todos: Todo[]): readonly Todo[] {
  return Object.freeze(todos.map(freezeTodo));
}

function freezeState(todos: Todo[], nextId: number): TodoState {
  return Object.freeze({
    todos: Object.freeze(todos),
    nextId,
  });
}
