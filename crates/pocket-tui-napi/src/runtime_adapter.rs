//! The only module coupled to the evolving core/terminal crates.

use std::collections::{HashMap, HashSet};
use std::os::fd::RawFd;
use std::time::Instant;

use pocket_tui_core::{
    Axis, BlockId, BoxNode, CanvasNode, CanvasRun as CoreCanvasRun, Color, DocumentId, Insets,
    LayoutSpec, NodeId, Runtime, Size, StyleId, TextAttributes, TextNode, TranscriptNode,
};
use pocket_tui_terminal::{
    CursorShape as TerminalCursorShape, CursorState, EffectBusState, FdWriter, InputEvent,
    TerminalCapabilities, TerminalSession,
};

use crate::protocol::{
    CanvasRun, ColorSpec, CursorShape, Direction, EffectBusProfile, Operation, Packet,
};

const DEFAULT_VIEWPORT: Size = Size::new(80, 24);
const MAX_VIEWPORT_CELLS: u64 = 1_000_000;

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
    Canvas {
        width: u16,
        height: u16,
        runs: Vec<CoreCanvasRun>,
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

#[derive(Clone, Copy, Debug)]
pub struct InputReadinessState {
    pub input_fd: RawFd,
    pub resize_fd: Option<RawFd>,
    pub viewport: Size,
    pub escape_deadline: Option<Instant>,
}

pub struct RuntimeAdapter {
    runtime: Runtime,
    bindings: HashMap<u64, Binding>,
    documents: HashMap<u64, DocumentId>,
    blocks: HashMap<u64, BlockBinding>,
    root: Option<u64>,
    session: Option<TerminalSession<FdWriter>>,
    cursor: CursorState,
    effect_bus: EffectBusState,
    pending_resize: Option<Size>,
    resize_fd: Option<RawFd>,
    dirty: bool,
    last_sequence: u64,
}

impl Default for RuntimeAdapter {
    fn default() -> Self {
        let (reported, resize_fd) = terminal_size();
        let initial_size = if viewport_area(reported) <= MAX_VIEWPORT_CELLS {
            reported
        } else {
            DEFAULT_VIEWPORT
        };
        Self {
            runtime: Runtime::new(initial_size),
            bindings: HashMap::new(),
            documents: HashMap::new(),
            blocks: HashMap::new(),
            root: None,
            session: None,
            cursor: CursorState::default(),
            effect_bus: EffectBusState::default(),
            pending_resize: None,
            resize_fd,
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
                    (&mut self.cursor, &mut self.effect_bus),
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
            let mut cursor = self.cursor;
            let mut effect_bus = self.effect_bus;
            for operation in packet.operations {
                apply_operation(
                    &mut runtime,
                    &mut bindings,
                    &mut documents,
                    &mut blocks,
                    &mut root,
                    (&mut cursor, &mut effect_bus),
                    operation,
                )?;
            }
            self.runtime = runtime;
            self.bindings = bindings;
            self.documents = documents;
            self.blocks = blocks;
            self.root = root;
            self.cursor = cursor;
            self.effect_bus = effect_bus;
        }
        self.last_sequence = packet.sequence;
        self.dirty = true;
        Ok(self.last_sequence)
    }

    pub fn start(&mut self) -> Result<(), String> {
        if self.session.is_some() {
            return Ok(());
        }
        self.refresh_terminal_size()?;
        let capabilities = if std::env::var_os("POCKET_TUI_GHOSTTY_EFFECTS").as_deref()
            == Some(std::ffi::OsStr::new("1"))
        {
            TerminalCapabilities::ghostty()
        } else {
            TerminalCapabilities::conservative()
        };
        let session = TerminalSession::open_stdio(capabilities)
            .map_err(|error| format!("failed to open terminal session: {error}"))?;
        self.session = Some(session);
        self.dirty = true;
        self.flush()
    }

    pub fn flush(&mut self) -> Result<(), String> {
        self.refresh_terminal_size()?;
        let Some(session) = self.session.as_mut() else {
            return Ok(());
        };
        if self.dirty {
            let frame = self
                .runtime
                .render_frame()
                .map_err(|error| format!("failed to render native scene: {error}"))?;
            session
                .present_with_effect_bus(&frame, self.cursor, self.effect_bus)
                .map_err(|error| format!("failed to present terminal frame: {error}"))?;
            self.dirty = false;
        }
        session
            .flush_blocking()
            .map_err(|error| format!("failed to flush terminal frame: {error}"))
    }

    /// Drain every typed stdin event currently available and synthesize one
    /// latest-value resize event when the tty dimensions have changed.
    pub fn poll_input(&mut self) -> Result<Vec<InputEvent>, String> {
        let mut events = if let Some(session) = self.session.as_mut() {
            session
                .poll_input()
                .map_err(|error| format!("failed to poll terminal input: {error}"))?
        } else {
            Vec::new()
        };

        for event in &events {
            if let InputEvent::Resize { columns, rows } = *event {
                self.pending_resize = None;
                self.apply_viewport_size(Size::new(columns, rows), false)?;
            }
        }

        self.refresh_terminal_size()?;
        if let Some(size) = self.pending_resize.take()
            && !events.iter().any(|event| {
                matches!(
                    event,
                    InputEvent::Resize { columns, rows }
                        if *columns == size.columns && *rows == size.rows
                )
            })
        {
            events.push(InputEvent::Resize {
                columns: size.columns,
                rows: size.rows,
            });
        }
        Ok(events)
    }

    /// Snapshot the descriptors and parser/model state used to arm readiness.
    pub fn input_readiness_state(&self) -> Result<Option<InputReadinessState>, String> {
        let Some(session) = self.session.as_ref() else {
            return Ok(None);
        };
        let input_fd = session
            .input_fd()
            .map_err(|error| format!("failed to access terminal input descriptor: {error}"))?;
        let escape_deadline = session
            .input_escape_deadline()
            .map_err(|error| format!("failed to access terminal input deadline: {error}"))?;
        Ok(Some(InputReadinessState {
            input_fd,
            resize_fd: self.resize_fd,
            viewport: self.runtime.size(),
            escape_deadline,
        }))
    }

    /// Return the current terminal viewport, refreshing it from the tty first.
    pub fn viewport_size(&mut self) -> Result<Size, String> {
        self.refresh_terminal_size()?;
        Ok(self.runtime.size())
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
                .present_with_effect_bus(&frame, self.cursor, self.effect_bus)
                .map_err(|error| format!("failed to present closing frame: {error}"))?;
            self.dirty = false;
        }
        session
            .close_blocking()
            .map_err(|error| format!("failed to restore terminal: {error}"))
    }

    fn refresh_terminal_size(&mut self) -> Result<(), String> {
        let (size, resize_fd) = terminal_size();
        self.apply_viewport_size(size, true)?;
        self.resize_fd = resize_fd;
        Ok(())
    }

    fn apply_viewport_size(&mut self, size: Size, notify: bool) -> Result<(), String> {
        let cells = viewport_area(size);
        if cells > MAX_VIEWPORT_CELLS {
            return Err(format!(
                "terminal viewport {}x{} contains {cells} cells; the safety limit is {MAX_VIEWPORT_CELLS}",
                size.columns, size.rows
            ));
        }
        if size == self.runtime.size() {
            return Ok(());
        }
        self.runtime.resize(size);
        self.dirty = true;
        if notify {
            self.pending_resize = Some(size);
        }
        Ok(())
    }
}

fn viewport_area(size: Size) -> u64 {
    u64::from(size.columns) * u64::from(size.rows)
}

fn is_hot_mutation(operation: &Operation<'_>) -> bool {
    matches!(
        operation,
        Operation::SetText { .. }
            | Operation::AppendText { .. }
            | Operation::OpenBlock { .. }
            | Operation::AppendBlockText { .. }
            | Operation::SealBlock { .. }
            | Operation::SetCanvasFrame { .. }
            | Operation::SetCursor { .. }
            | Operation::SetEffectBus { .. }
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
            Operation::SetCanvasFrame {
                handle,
                width,
                height,
                runs,
            } => {
                if !matches!(&binding(bindings, *handle)?.spec, NodeSpec::Canvas { .. }) {
                    return Err(format!("node {handle} is not Canvas"));
                }
                validate_canvas_frame(*width, *height, runs)?;
            }
            Operation::SetCursor { .. } => {}
            Operation::SetEffectBus { .. } => {}
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
    presentation: (&mut CursorState, &mut EffectBusState),
    operation: Operation<'_>,
) -> Result<(), String> {
    let (cursor, effect_bus) = presentation;
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
        Operation::CreateCanvas { handle } => insert_binding(
            bindings,
            documents,
            blocks,
            handle,
            NodeSpec::Canvas {
                width: 1,
                height: 1,
                runs: Vec::new(),
            },
        ),
        Operation::SetCanvasFrame {
            handle,
            width,
            height,
            runs,
        } => {
            let runs = convert_canvas_runs(width, height, &runs)?;
            let value = binding_mut(bindings, handle)?;
            let NodeSpec::Canvas {
                width: current_width,
                height: current_height,
                runs: current_runs,
            } = &mut value.spec
            else {
                return Err(format!("node {handle} is not Canvas"));
            };
            *current_width = width;
            *current_height = height;
            current_runs.clone_from(&runs);
            let native = value.native;
            if let Some(native) = native {
                runtime
                    .scene_mut()
                    .set_canvas_frame(native, width, height, runs)
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        }
        Operation::SetCursor {
            row,
            column,
            visible,
            shape,
            color,
        } => {
            *cursor = CursorState {
                row,
                column,
                visible,
                shape: match shape {
                    CursorShape::Block => TerminalCursorShape::Block,
                    CursorShape::Underline => TerminalCursorShape::Underline,
                    CursorShape::Bar => TerminalCursorShape::Bar,
                },
                color: convert_color(color),
            };
            Ok(())
        }
        Operation::SetEffectBus {
            profile,
            enabled,
            trigger,
            channels,
        } => {
            if profile != EffectBusProfile::GhosttyPaletteV1 {
                return Err("unsupported effect bus profile".to_owned());
            }
            if enabled {
                effect_bus.enabled = true;
                effect_bus.channels = channels;
                if trigger {
                    effect_bus.cursor_shade = !effect_bus.cursor_shade;
                }
            } else {
                *effect_bus = EffectBusState::default();
            }
            Ok(())
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
        NodeSpec::Canvas {
            width,
            height,
            runs,
        } => runtime
            .scene_mut()
            .create_canvas(
                native_parent,
                CanvasNode {
                    width,
                    height,
                    runs,
                    ..CanvasNode::default()
                },
            )
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
        NodeSpec::Text(_) | NodeSpec::Transcript { .. } | NodeSpec::Canvas { .. } => {
            Err(format!("node {handle} is not Box"))
        }
    }
}

fn validate_canvas_frame(width: u16, height: u16, runs: &[CanvasRun<'_>]) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("canvas dimensions must be non-zero".to_owned());
    }
    for (index, run) in runs.iter().enumerate() {
        if run.row >= height || run.column >= width {
            return Err(format!("canvas run {index} starts outside the frame"));
        }
        if run.text.is_empty() {
            return Err(format!("canvas run {index} is empty"));
        }
        if run.text.contains(['\r', '\n']) {
            return Err(format!("canvas run {index} contains a line break"));
        }
        if run.attributes & !TextAttributes::all().bits() != 0 {
            return Err(format!("canvas run {index} uses unknown style attributes"));
        }
    }
    Ok(())
}

fn convert_canvas_runs(
    width: u16,
    height: u16,
    runs: &[CanvasRun<'_>],
) -> Result<Vec<CoreCanvasRun>, String> {
    validate_canvas_frame(width, height, runs)?;
    Ok(runs
        .iter()
        .map(|run| CoreCanvasRun {
            row: run.row,
            column: run.column,
            text: run.text.to_owned(),
            foreground: convert_color(run.foreground),
            background: convert_color(run.background),
            attributes: TextAttributes::from_bits_retain(run.attributes),
        })
        .collect())
}

fn convert_color(color: ColorSpec) -> Color {
    match color {
        ColorSpec::Default => Color::Default,
        ColorSpec::Indexed(index) => Color::Indexed(index),
        ColorSpec::Rgb(red, green, blue) => Color::Rgb(red, green, blue),
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

fn terminal_size() -> (Size, Option<RawFd>) {
    choose_terminal_size_source(
        ioctl_terminal_size(libc::STDOUT_FILENO),
        ioctl_terminal_size(libc::STDIN_FILENO),
        env_dimension("COLUMNS"),
        env_dimension("LINES"),
    )
}

fn ioctl_terminal_size(fd: libc::c_int) -> Option<Size> {
    // SAFETY: `size` points to writable storage and TIOCGWINSZ only reads the
    // borrowed file descriptor while filling that fixed-size structure.
    let mut size = unsafe { std::mem::zeroed::<libc::winsize>() };
    let result = unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut size) };
    if result == 0 && size.ws_col > 0 && size.ws_row > 0 {
        Some(Size::new(size.ws_col, size.ws_row))
    } else {
        None
    }
}

fn env_dimension(name: &str) -> Option<u16> {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value > 0)
}

fn choose_terminal_size_source(
    stdout: Option<Size>,
    stdin: Option<Size>,
    env_columns: Option<u16>,
    env_rows: Option<u16>,
) -> (Size, Option<RawFd>) {
    if let Some(size) = stdout {
        return (size, Some(libc::STDOUT_FILENO));
    }
    if let Some(size) = stdin {
        return (size, Some(libc::STDIN_FILENO));
    }
    (
        Size::new(
            env_columns.unwrap_or(DEFAULT_VIEWPORT.columns),
            env_rows.unwrap_or(DEFAULT_VIEWPORT.rows),
        ),
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_size_prefers_stdout_then_stdin_then_environment() {
        let stdout = Size::new(132, 43);
        let stdin = Size::new(100, 30);

        assert_eq!(
            choose_terminal_size_source(Some(stdout), Some(stdin), Some(90), Some(28)),
            (stdout, Some(libc::STDOUT_FILENO))
        );
        assert_eq!(
            choose_terminal_size_source(None, Some(stdin), Some(90), Some(28)),
            (stdin, Some(libc::STDIN_FILENO))
        );
        assert_eq!(
            choose_terminal_size_source(None, None, Some(90), Some(28)),
            (Size::new(90, 28), None)
        );
        assert_eq!(
            choose_terminal_size_source(None, None, None, None),
            (Size::new(80, 24), None)
        );
    }

    #[test]
    fn resize_notifications_keep_only_the_latest_viewport() {
        let mut adapter = RuntimeAdapter::default();
        adapter.runtime = Runtime::new(Size::new(80, 24));
        adapter.dirty = false;
        adapter.pending_resize = None;

        adapter
            .apply_viewport_size(Size::new(100, 30), true)
            .unwrap();
        adapter
            .apply_viewport_size(Size::new(120, 40), true)
            .unwrap();

        assert_eq!(adapter.runtime.size(), Size::new(120, 40));
        assert_eq!(adapter.pending_resize, Some(Size::new(120, 40)));
        assert!(adapter.dirty);
    }

    #[test]
    fn oversized_viewport_is_rejected_without_mutating_runtime_state() {
        let mut adapter = RuntimeAdapter::default();
        adapter.runtime = Runtime::new(Size::new(80, 24));
        adapter.dirty = false;
        adapter.pending_resize = None;

        let error = adapter
            .apply_viewport_size(Size::new(u16::MAX, u16::MAX), true)
            .unwrap_err();

        assert!(error.contains("safety limit"));
        assert_eq!(adapter.runtime.size(), Size::new(80, 24));
        assert!(!adapter.dirty);
        assert_eq!(adapter.pending_resize, None);
    }

    #[test]
    fn hot_packet_does_not_publish_effect_state_before_full_validation() {
        let mut adapter = RuntimeAdapter::default();
        let channels = [[3, 40, 0], [200, 90, 255], [128, 128, 70]];
        let invalid = Packet {
            flags: 0,
            sequence: 1,
            operations: vec![
                Operation::SetEffectBus {
                    profile: EffectBusProfile::GhosttyPaletteV1,
                    enabled: true,
                    trigger: true,
                    channels,
                },
                Operation::SetText {
                    handle: 99,
                    text: "missing",
                },
            ],
        };

        assert!(adapter.apply(invalid).unwrap_err().contains("unknown node"));
        assert_eq!(adapter.effect_bus, EffectBusState::default());
        assert_eq!(adapter.last_sequence, 0);
        assert!(!adapter.dirty);

        adapter
            .apply(Packet {
                flags: 0,
                sequence: 1,
                operations: vec![Operation::SetEffectBus {
                    profile: EffectBusProfile::GhosttyPaletteV1,
                    enabled: true,
                    trigger: true,
                    channels,
                }],
            })
            .unwrap();
        assert_eq!(
            adapter.effect_bus,
            EffectBusState {
                enabled: true,
                channels,
                cursor_shade: true,
            }
        );
    }
}
