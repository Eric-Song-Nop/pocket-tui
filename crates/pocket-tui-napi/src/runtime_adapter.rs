//! The only module coupled to the evolving core/terminal crates.

use std::collections::{HashMap, HashSet};

use pocket_tui_core::{
    Axis, BlockId, BoxNode, DocumentId, Insets, LayoutSpec, NodeId, Runtime, Size, StyleId,
    TextNode, TranscriptNode,
};
use pocket_tui_terminal::{FdWriter, InputEvent, TerminalCapabilities, TerminalSession};

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
    Transcript {
        document: u64,
    },
}

#[derive(Clone, Debug)]
struct Binding {
    spec: NodeSpec,
    parent: Option<u64>,
    native: Option<NodeId>,
}

#[derive(Clone, Copy, Debug)]
struct BlockBinding {
    native: BlockId,
    sealed: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct MemoryStatsSnapshot {
    pub scene_nodes: usize,
    pub documents: usize,
    pub blocks: usize,
    pub open_blocks: usize,
    pub sealed_blocks: usize,
    pub document_text_bytes: usize,
    pub document_budget_bytes: usize,
    pub estimated_document_rows: u64,
    pub estimated_native_bytes: usize,
    pub terminal_pending_bytes: usize,
}

pub struct RuntimeAdapter {
    runtime: Runtime,
    bindings: HashMap<u64, Binding>,
    documents: HashMap<u64, DocumentId>,
    blocks: HashMap<u64, BlockBinding>,
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
            documents: HashMap::new(),
            blocks: HashMap::new(),
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

        if packet.operations.iter().all(is_hot_mutation) {
            // Streaming text/document operations are the hot path. Validate
            // their ordered state transition first, then apply without cloning
            // the framebuffer, scene, or accumulated DocumentDB text.
            validate_hot_operations(
                &self.runtime,
                &self.bindings,
                &self.documents,
                &self.blocks,
                &packet.operations,
            )?;
            for operation in packet.operations {
                apply_operation(
                    &mut self.runtime,
                    &mut self.bindings,
                    &mut self.documents,
                    &mut self.blocks,
                    &mut self.root,
                    operation,
                )?;
            }
        } else {
            // Structural packets are comparatively rare in the MVP. Clone and
            // publish their compact model so invalid packets remain atomic.
            let mut runtime = self.runtime.clone();
            let mut bindings = self.bindings.clone();
            let mut documents = self.documents.clone();
            let mut blocks = self.blocks.clone();
            let mut root = self.root;
            for operation in packet.operations {
                apply_operation(
                    &mut runtime,
                    &mut bindings,
                    &mut documents,
                    &mut blocks,
                    &mut root,
                    operation,
                )?;
            }
            self.runtime = runtime;
            self.bindings = bindings;
            self.documents = documents;
            self.blocks = blocks;
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

    /// Drain every typed stdin event currently available. The terminal layer
    /// keeps stdin nonblocking, so this is safe to call once per JS event-loop
    /// turn. A future resize producer can use the same event path.
    pub fn poll_input(&mut self) -> Result<Vec<InputEvent>, String> {
        let Some(session) = self.session.as_mut() else {
            return Ok(Vec::new());
        };
        let events = session
            .poll_input()
            .map_err(|error| format!("failed to poll terminal input: {error}"))?;
        for event in &events {
            if let InputEvent::Resize { columns, rows } = *event {
                self.runtime.resize(Size::new(columns, rows));
                self.dirty = true;
            }
        }
        Ok(events)
    }

    #[must_use]
    pub fn memory_stats(&self) -> MemoryStatsSnapshot {
        let stats = self.runtime.stats();
        MemoryStatsSnapshot {
            scene_nodes: self
                .bindings
                .values()
                .filter(|binding| binding.native.is_some())
                .count(),
            documents: stats.documents,
            blocks: stats.blocks,
            open_blocks: stats.open_blocks,
            sealed_blocks: stats.blocks.saturating_sub(stats.open_blocks),
            document_text_bytes: stats.document_text_bytes,
            document_budget_bytes: stats.document_budget_bytes,
            estimated_document_rows: stats.estimated_document_rows,
            estimated_native_bytes: stats.estimated_native_bytes,
            terminal_pending_bytes: self
                .session
                .as_ref()
                .map_or(0, |session| session.progress().pending_bytes),
        }
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

fn is_hot_mutation(operation: &Operation<'_>) -> bool {
    matches!(
        operation,
        Operation::SetText { .. }
            | Operation::AppendText { .. }
            | Operation::OpenBlock { .. }
            | Operation::AppendBlockText { .. }
            | Operation::SealBlock { .. }
    )
}

fn validate_hot_operations(
    runtime: &Runtime,
    bindings: &HashMap<u64, Binding>,
    documents: &HashMap<u64, DocumentId>,
    blocks: &HashMap<u64, BlockBinding>,
    operations: &[Operation<'_>],
) -> Result<(), String> {
    let native_documents: HashMap<DocumentId, u64> = documents
        .iter()
        .map(|(handle, document)| (*document, *handle))
        .collect();
    let mut open_documents = HashSet::new();
    for (handle, document) in documents {
        if runtime
            .documents()
            .document(*document)
            .map_err(|error| error.to_string())?
            .open_block()
            .is_some()
        {
            open_documents.insert(*handle);
        }
    }

    let mut block_states: HashMap<u64, bool> = HashMap::with_capacity(blocks.len());
    let mut block_documents: HashMap<u64, u64> = HashMap::with_capacity(blocks.len());
    for (handle, binding) in blocks {
        let document = runtime
            .documents()
            .block(binding.native)
            .map_err(|error| error.to_string())?
            .document();
        let document_handle = *native_documents
            .get(&document)
            .ok_or_else(|| format!("block {handle} belongs to an unknown transcript"))?;
        block_states.insert(*handle, binding.sealed);
        block_documents.insert(*handle, document_handle);
    }

    let stats = runtime.stats();
    let mut appended_bytes = 0usize;
    for operation in operations {
        match operation {
            Operation::SetText { handle, .. } | Operation::AppendText { handle, .. } => {
                if !matches!(&binding(bindings, *handle)?.spec, NodeSpec::Text(_)) {
                    return Err(format!("node {handle} is not Text"));
                }
            }
            Operation::OpenBlock { transcript, block } => {
                if *block == 0
                    || bindings.contains_key(block)
                    || documents.contains_key(block)
                    || block_states.contains_key(block)
                {
                    return Err(format!("block handle {block} already exists or is zero"));
                }
                if !documents.contains_key(transcript) {
                    return Err(format!("unknown transcript handle {transcript}"));
                }
                if !open_documents.insert(*transcript) {
                    return Err(format!("transcript {transcript} already has an open block"));
                }
                block_states.insert(*block, false);
                block_documents.insert(*block, *transcript);
            }
            Operation::AppendBlockText { block, text } => {
                let sealed = block_states
                    .get(block)
                    .ok_or_else(|| format!("unknown block handle {block}"))?;
                if *sealed {
                    return Err(format!("block {block} is sealed"));
                }
                appended_bytes = appended_bytes
                    .checked_add(text.len())
                    .ok_or_else(|| "document UTF-8 byte count overflow".to_owned())?;
                let next_bytes = stats
                    .document_text_bytes
                    .checked_add(appended_bytes)
                    .ok_or_else(|| "document UTF-8 byte count overflow".to_owned())?;
                if next_bytes > stats.document_budget_bytes {
                    return Err(format!(
                        "document UTF-8 budget exceeded: used {}, requested {}, limit {}",
                        stats.document_text_bytes, appended_bytes, stats.document_budget_bytes
                    ));
                }
            }
            Operation::SealBlock { block } => {
                let sealed = block_states
                    .get_mut(block)
                    .ok_or_else(|| format!("unknown block handle {block}"))?;
                if *sealed {
                    return Err(format!("block {block} is already sealed"));
                }
                *sealed = true;
                let document = block_documents
                    .get(block)
                    .ok_or_else(|| format!("block {block} belongs to an unknown transcript"))?;
                open_documents.remove(document);
            }
            _ => unreachable!("guarded by is_hot_mutation"),
        }
    }
    Ok(())
}

impl Drop for RuntimeAdapter {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn apply_operation(
    runtime: &mut Runtime,
    bindings: &mut HashMap<u64, Binding>,
    documents: &mut HashMap<u64, DocumentId>,
    blocks: &mut HashMap<u64, BlockBinding>,
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
            documents,
            blocks,
            handle,
            NodeSpec::Box {
                direction,
                border,
                padding,
            },
        ),
        Operation::CreateText { handle, text } => insert_binding(
            bindings,
            documents,
            blocks,
            handle,
            NodeSpec::Text(text.to_owned()),
        ),
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
            materialize(runtime, bindings, documents, child).map(|_| ())
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
            materialize(runtime, bindings, documents, handle).map(|_| ())
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
        Operation::CreateTranscript { handle } => {
            if handle == 0
                || documents.contains_key(&handle)
                || bindings.contains_key(&handle)
                || blocks.contains_key(&handle)
            {
                return Err(format!(
                    "transcript handle {handle} already exists or is zero"
                ));
            }
            let native = runtime
                .create_document()
                .map_err(|error| error.to_string())?;
            documents.insert(handle, native);
            Ok(())
        }
        Operation::OpenBlock { transcript, block } => {
            if block == 0
                || documents.contains_key(&block)
                || bindings.contains_key(&block)
                || blocks.contains_key(&block)
            {
                return Err(format!("block handle {block} already exists or is zero"));
            }
            let document = *documents
                .get(&transcript)
                .ok_or_else(|| format!("unknown transcript handle {transcript}"))?;
            let native = runtime
                .open_block(document)
                .map_err(|error| error.to_string())?;
            blocks.insert(
                block,
                BlockBinding {
                    native,
                    sealed: false,
                },
            );
            Ok(())
        }
        Operation::AppendBlockText { block, text } => {
            let binding = blocks
                .get(&block)
                .ok_or_else(|| format!("unknown block handle {block}"))?;
            if binding.sealed {
                return Err(format!("block {block} is sealed"));
            }
            runtime
                .append_block_text(binding.native, text)
                .map_err(|error| error.to_string())
        }
        Operation::SealBlock { block } => {
            let binding = blocks
                .get_mut(&block)
                .ok_or_else(|| format!("unknown block handle {block}"))?;
            if binding.sealed {
                return Err(format!("block {block} is already sealed"));
            }
            runtime
                .seal_block(binding.native)
                .map_err(|error| error.to_string())?;
            binding.sealed = true;
            Ok(())
        }
        Operation::CreateVirtualTranscript { handle, transcript } => {
            documents
                .get(&transcript)
                .ok_or_else(|| format!("unknown transcript handle {transcript}"))?;
            insert_binding(
                bindings,
                documents,
                blocks,
                handle,
                NodeSpec::Transcript {
                    document: transcript,
                },
            )
        }
    }
}

fn insert_binding(
    bindings: &mut HashMap<u64, Binding>,
    documents: &HashMap<u64, DocumentId>,
    blocks: &HashMap<u64, BlockBinding>,
    handle: u64,
    spec: NodeSpec,
) -> Result<(), String> {
    if handle == 0
        || bindings.contains_key(&handle)
        || documents.contains_key(&handle)
        || blocks.contains_key(&handle)
    {
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
    documents: &HashMap<u64, DocumentId>,
    handle: u64,
) -> Result<NodeId, String> {
    let current = binding(bindings, handle)?;
    if let Some(native) = current.native {
        return Ok(native);
    }
    let parent = current.parent;
    let spec = current.spec.clone();
    let native_parent = parent
        .map(|parent| materialize(runtime, bindings, documents, parent))
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
        NodeSpec::Transcript { document } => {
            let document = *documents
                .get(&document)
                .ok_or_else(|| format!("unknown transcript document {document}"))?;
            let mut transcript = TranscriptNode::new(document);
            transcript.style = StyleId::DEFAULT;
            transcript.layout = LayoutSpec::FILL;
            runtime
                .create_transcript(native_parent, transcript)
                .map_err(|error| error.to_string())?
        }
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
        NodeSpec::Text(_) | NodeSpec::Transcript { .. } => Err(format!("node {handle} is not Box")),
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
