//! The only module coupled to the evolving core/terminal crates.

use std::collections::{HashMap, HashSet};

use pocket_tui_core::{Axis, BoxNode, Insets, NodeId, Runtime, Size, TextNode};
use pocket_tui_terminal::{FdWriter, TerminalCapabilities, TerminalSession};

use crate::protocol::{Direction, Operation, Packet};

#[derive(Clone, Debug)]
enum NodeSpec {
    Box {
        direction: Direction,
        #[allow(dead_code)]
        border: bool,
        padding: u16,
    },
    Text(String),
}

#[derive(Clone, Debug)]
struct Binding {
    spec: NodeSpec,
    parent: Option<u64>,
    native: Option<NodeId>,
}

pub struct RuntimeAdapter {
    runtime: Runtime,
    bindings: HashMap<u64, Binding>,
    root: Option<u64>,
    session: Option<TerminalSession<FdWriter>>,
    dirty: bool,
    last_sequence: u64,
}

impl Default for RuntimeAdapter {
    fn default() -> Self {
        Self {
            runtime: Runtime::new(terminal_size()),
            bindings: HashMap::new(),
            root: None,
            session: None,
            dirty: false,
            last_sequence: 0,
        }
    }
}

impl RuntimeAdapter {
    /// Apply a whole packet to a cloned model, then publish it. Semantic errors
    /// therefore have the same all-or-nothing behavior as decode errors.
    pub fn apply(&mut self, packet: Packet<'_>) -> Result<u64, String> {
        if packet.sequence <= self.last_sequence {
            return Err(format!(
                "PTX sequence {} is not newer than {}",
                packet.sequence, self.last_sequence
            ));
        }

        if packet.operations.iter().all(is_text_mutation) {
            // Streaming text is the hot path. Validate every target first, then
            // mutate the single-owner runtime without cloning its framebuffer,
            // resource tables, scene, or accumulated strings.
            for operation in &packet.operations {
                let handle = match operation {
                    Operation::SetText { handle, .. } | Operation::AppendText { handle, .. } => {
                        *handle
                    }
                    _ => unreachable!("guarded by is_text_mutation"),
                };
                match &binding(&self.bindings, handle)?.spec {
                    NodeSpec::Text(_) => {}
                    NodeSpec::Box { .. } => return Err(format!("node {handle} is not Text")),
                }
            }
            for operation in packet.operations {
                apply_operation(
                    &mut self.runtime,
                    &mut self.bindings,
                    &mut self.root,
                    operation,
                )?;
            }
        } else {
            // Structural packets are comparatively rare in the MVP. Clone and
            // publish their compact model so invalid packets remain atomic.
            let mut runtime = self.runtime.clone();
            let mut bindings = self.bindings.clone();
            let mut root = self.root;
            for operation in packet.operations {
                apply_operation(&mut runtime, &mut bindings, &mut root, operation)?;
            }
            self.runtime = runtime;
            self.bindings = bindings;
            self.root = root;
        }
        self.last_sequence = packet.sequence;
        self.dirty = true;
        Ok(self.last_sequence)
    }

    pub fn start(&mut self) -> Result<(), String> {
        if self.session.is_some() {
            return Ok(());
        }
        let session = TerminalSession::open_stdio(TerminalCapabilities::conservative())
            .map_err(|error| format!("failed to open terminal session: {error}"))?;
        self.session = Some(session);
        self.dirty = true;
        self.flush()
    }

    pub fn flush(&mut self) -> Result<(), String> {
        let Some(session) = self.session.as_mut() else {
            return Ok(());
        };
        if self.dirty {
            let frame = self
                .runtime
                .render_frame()
                .map_err(|error| format!("failed to render native scene: {error}"))?;
            session
                .present(&frame)
                .map_err(|error| format!("failed to present terminal frame: {error}"))?;
            self.dirty = false;
        }
        session
            .flush_blocking()
            .map_err(|error| format!("failed to flush terminal frame: {error}"))
    }

    pub fn close(&mut self) -> Result<(), String> {
        let Some(mut session) = self.session.take() else {
            return Ok(());
        };
        if self.dirty {
            let frame = self
                .runtime
                .render_frame()
                .map_err(|error| format!("failed to render closing scene: {error}"))?;
            session
                .present(&frame)
                .map_err(|error| format!("failed to present closing frame: {error}"))?;
            self.dirty = false;
        }
        session
            .close_blocking()
            .map_err(|error| format!("failed to restore terminal: {error}"))
    }
}

fn is_text_mutation(operation: &Operation<'_>) -> bool {
    matches!(
        operation,
        Operation::SetText { .. } | Operation::AppendText { .. }
    )
}

impl Drop for RuntimeAdapter {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn apply_operation(
    runtime: &mut Runtime,
    bindings: &mut HashMap<u64, Binding>,
    root: &mut Option<u64>,
    operation: Operation<'_>,
) -> Result<(), String> {
    match operation {
        Operation::CreateBox {
            handle,
            direction,
            border,
            padding,
        } => insert_binding(
            bindings,
            handle,
            NodeSpec::Box {
                direction,
                border,
                padding,
            },
        ),
        Operation::CreateText { handle, text } => {
            insert_binding(bindings, handle, NodeSpec::Text(text.to_owned()))
        }
        Operation::AppendChild { parent, child } => {
            require_box(bindings, parent)?;
            if parent == child || is_descendant(bindings, child, parent) {
                return Err("AppendChild would create a scene cycle".to_owned());
            }
            let child_binding = binding_mut(bindings, child)?;
            if child_binding.parent.is_some() || child_binding.native.is_some() {
                return Err(format!("node {child} is already attached"));
            }
            child_binding.parent = Some(parent);
            materialize(runtime, bindings, child).map(|_| ())
        }
        Operation::SetRoot { handle } => {
            binding(bindings, handle)?;
            if bindings
                .get(&handle)
                .and_then(|value| value.parent)
                .is_some()
            {
                return Err("root node already has a parent".to_owned());
            }
            if let Some(previous) = *root {
                if previous != handle {
                    return Err("the MVP supports one immutable root".to_owned());
                }
            }
            *root = Some(handle);
            materialize(runtime, bindings, handle).map(|_| ())
        }
        Operation::SetText { handle, text } => {
            let native = set_pending_text(bindings, handle, text, false)?;
            if let Some(native) = native {
                runtime
                    .scene_mut()
                    .set_text(native, text)
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        }
        Operation::AppendText { handle, text } => {
            let native = set_pending_text(bindings, handle, text, true)?;
            if let Some(native) = native {
                runtime
                    .scene_mut()
                    .append_text(native, text)
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        }
        Operation::RemoveNode { handle } => {
            let binding = binding(bindings, handle)?;
            if let Some(native) = binding.native {
                runtime
                    .scene_mut()
                    .remove(native)
                    .map_err(|error| error.to_string())?;
            }
            let removed = descendants_including(bindings, handle);
            bindings.retain(|key, _| !removed.contains(key));
            if root.is_some_and(|value| removed.contains(&value)) {
                *root = None;
            }
            Ok(())
        }
    }
}

fn insert_binding(
    bindings: &mut HashMap<u64, Binding>,
    handle: u64,
    spec: NodeSpec,
) -> Result<(), String> {
    if handle == 0 || bindings.contains_key(&handle) {
        return Err(format!("node handle {handle} already exists or is zero"));
    }
    bindings.insert(
        handle,
        Binding {
            spec,
            parent: None,
            native: None,
        },
    );
    Ok(())
}

fn materialize(
    runtime: &mut Runtime,
    bindings: &mut HashMap<u64, Binding>,
    handle: u64,
) -> Result<NodeId, String> {
    let current = binding(bindings, handle)?;
    if let Some(native) = current.native {
        return Ok(native);
    }
    let parent = current.parent;
    let spec = current.spec.clone();
    let native_parent = parent
        .map(|parent| materialize(runtime, bindings, parent))
        .transpose()?;
    let native = match spec {
        NodeSpec::Box {
            direction, padding, ..
        } => runtime
            .scene_mut()
            .create_box(
                native_parent,
                BoxNode {
                    axis: match direction {
                        Direction::Column => Axis::Column,
                        Direction::Row => Axis::Row,
                    },
                    padding: Insets::all(padding),
                    ..BoxNode::default()
                },
            )
            .map_err(|error| error.to_string())?,
        NodeSpec::Text(text) => runtime
            .scene_mut()
            .create_text(native_parent, TextNode::new(text))
            .map_err(|error| error.to_string())?,
    };
    binding_mut(bindings, handle)?.native = Some(native);
    Ok(native)
}

fn set_pending_text(
    bindings: &mut HashMap<u64, Binding>,
    handle: u64,
    text: &str,
    append: bool,
) -> Result<Option<NodeId>, String> {
    let value = binding_mut(bindings, handle)?;
    let NodeSpec::Text(current) = &mut value.spec else {
        return Err(format!("node {handle} is not Text"));
    };
    if append {
        current.push_str(text);
    } else {
        current.clear();
        current.push_str(text);
    }
    Ok(value.native)
}

fn require_box(bindings: &HashMap<u64, Binding>, handle: u64) -> Result<(), String> {
    match &binding(bindings, handle)?.spec {
        NodeSpec::Box { .. } => Ok(()),
        NodeSpec::Text(_) => Err(format!("node {handle} is not Box")),
    }
}

fn binding(bindings: &HashMap<u64, Binding>, handle: u64) -> Result<&Binding, String> {
    bindings
        .get(&handle)
        .ok_or_else(|| format!("unknown node handle {handle}"))
}

fn binding_mut(bindings: &mut HashMap<u64, Binding>, handle: u64) -> Result<&mut Binding, String> {
    bindings
        .get_mut(&handle)
        .ok_or_else(|| format!("unknown node handle {handle}"))
}

fn is_descendant(bindings: &HashMap<u64, Binding>, ancestor: u64, candidate: u64) -> bool {
    let mut cursor = Some(candidate);
    while let Some(handle) = cursor {
        if handle == ancestor {
            return true;
        }
        cursor = bindings.get(&handle).and_then(|value| value.parent);
    }
    false
}

fn descendants_including(bindings: &HashMap<u64, Binding>, root: u64) -> HashSet<u64> {
    bindings
        .keys()
        .copied()
        .filter(|candidate| is_descendant(bindings, root, *candidate))
        .collect()
}

fn terminal_size() -> Size {
    let columns = env_dimension("COLUMNS", 80);
    let rows = env_dimension("LINES", 24);
    Size::new(columns, rows)
}

fn env_dimension(name: &str, fallback: u16) -> u16 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}
