// @ts-nocheck -- Bun supplies the bun:test module at test runtime.
import { describe, expect, test } from "bun:test";

import {
  DEMO_TODOS,
  TODO_FILTERS,
  addTodo,
  clearCompleted,
  createTodoState,
  filterTodos,
  removeTodo,
  todoCounts,
  toggleTodo,
} from "./todo-model.js";

describe("todo model", () => {
  test("starts with deterministic immutable demo content and derived counts", () => {
    const first = createTodoState();
    const second = createTodoState();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.todos).not.toBe(second.todos);
    expect(first.todos).toEqual(DEMO_TODOS);
    expect(first.todos.length).toBeGreaterThanOrEqual(3);
    expect(todoCounts(first.todos)).toEqual({
      total: 3,
      remaining: 2,
      completed: 1,
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.todos)).toBe(true);
    expect(first.todos.every(Object.isFrozen)).toBe(true);
  });

  test("trims additions, rejects blank titles, and never reuses an id", () => {
    const initial = createTodoState();
    const blank = addTodo(initial, " \n\t ");
    const added = addTodo(initial, "  Review retained tree  ");

    expect(blank).toBe(initial);
    expect(added).not.toBe(initial);
    expect(added.todos.slice(0, -1)).toEqual(initial.todos);
    expect(added.todos.at(-1)).toEqual({
      id: initial.nextId,
      title: "Review retained tree",
      completed: false,
    });
    expect(added.nextId).toBe(initial.nextId + 1);
    expect(initial.todos).toHaveLength(3);

    const removed = removeTodo(added, initial.nextId);
    const addedAgain = addTodo(removed, "Keep ids monotonic");
    expect(addedAgain.todos.at(-1)?.id).toBe(initial.nextId + 1);
  });

  test("toggles the target while retaining stable ids and unaffected objects", () => {
    const initial = createTodoState();
    const target = initial.todos[0];
    const unaffected = initial.todos[1];
    if (target === undefined || unaffected === undefined) {
      throw new Error("demo todos are missing");
    }

    const toggled = toggleTodo(initial, target.id);

    expect(toggled).not.toBe(initial);
    expect(toggled.todos[0]).not.toBe(target);
    expect(toggled.todos[0]).toEqual({ ...target, completed: !target.completed });
    expect(toggled.todos[0]?.id).toBe(target.id);
    expect(toggled.todos[1]).toBe(unaffected);
    expect(initial.todos[0]).toBe(target);
    expect(toggleTodo(initial, Number.MAX_SAFE_INTEGER)).toBe(initial);
  });

  test("removes a todo immutably and preserves the id counter", () => {
    const initial = createTodoState();
    const removedId = initial.todos[1]?.id;
    if (removedId === undefined) throw new Error("demo todos are missing");

    const result = removeTodo(initial, removedId);

    expect(result).not.toBe(initial);
    expect(result.todos.map((todo) => todo.id)).not.toContain(removedId);
    expect(result.nextId).toBe(initial.nextId);
    expect(initial.todos.some((todo) => todo.id === removedId)).toBe(true);
    expect(removeTodo(initial, Number.MAX_SAFE_INTEGER)).toBe(initial);
  });

  test("filters all, open, and done without changing todo identities", () => {
    const state = createTodoState();

    expect(TODO_FILTERS).toEqual(["all", "open", "done"]);
    expect(filterTodos(state.todos, "all")).toBe(state.todos);
    expect(filterTodos(state.todos, "open").every((todo) => !todo.completed)).toBe(true);
    expect(filterTodos(state.todos, "done").every((todo) => todo.completed)).toBe(true);
    expect(filterTodos(state.todos, "open")[0]).toBe(state.todos[0]);
    expect(filterTodos(state.todos, "done")[0]).toBe(state.todos[1]);
  });

  test("clears completed todos and derives updated totals", () => {
    const initial = createTodoState();
    const firstOpen = initial.todos.find((todo) => !todo.completed);
    const cleared = clearCompleted(initial);

    expect(cleared).not.toBe(initial);
    expect(cleared.todos.every((todo) => !todo.completed)).toBe(true);
    expect(cleared.todos.find((todo) => todo.id === firstOpen?.id)).toBe(firstOpen);
    expect(cleared.nextId).toBe(initial.nextId);
    expect(todoCounts(cleared.todos)).toEqual({
      total: 2,
      remaining: 2,
      completed: 0,
    });
    expect(clearCompleted(cleared)).toBe(cleared);
    expect(initial.todos.some((todo) => todo.completed)).toBe(true);
  });
});
