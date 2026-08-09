# PocketTUI

PocketTUI is an architecture-first, terminal-native runtime for TypeScript and JavaScript applications.

The project is in active MVP development. The first milestone targets a runnable alternate-screen application backed by a single-owner Rust runtime, a small N-API boundary, semantic scene operations, incremental terminal output, and bounded memory.

## Why

Most high-level TUI stacks still make work scale with the component tree, transcript history, or full terminal grid. PocketTUI instead targets:

```text
work = semantic delta + materialized viewport + actual damage + emitted bytes
```

The long-term architecture separates active UI (`SceneDB`) from virtual history (`DocumentDB`) and treats the terminal as a remote stateful coprocessor through a dedicated Terminal Transition Engine.

## MVP principles

- JavaScript is the control plane; Rust owns runtime and terminal state.
- No per-frame JavaScript component-tree render.
- No ANSI strings as the core rendering IR.
- One in-flight terminal patch plus one replaceable latest visual generation.
- Ordered input and document operations are never silently dropped.
- Every queue, cache, arena, and resource store has a byte budget.
- Alternate screen is the primary v1 surface; main-screen and direct modes follow.

## Repository layout

```text
crates/pocket-tui-core       scene, document, layout, paint model
crates/pocket-tui-terminal   terminal state, transition planning, writer
crates/pocket-tui-napi       Node/Bun native binding
packages/core                public TypeScript API
docs/architecture.md         complete implementation design
```

## Development

Prerequisites: Rust 1.85+, Node.js 20+ or Bun 1.2+.

```bash
bun install
bun run check
```

The project deliberately starts with a small number of smoke and contract checks. The priority is a coherent, runnable MVP rather than a test-first implementation.

