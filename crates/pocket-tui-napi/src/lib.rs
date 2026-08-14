mod protocol;
mod runtime_adapter;

use std::sync::Mutex;

use napi::bindgen_prelude::Uint8Array;
use napi::{Error, Result, Status};
use napi_derive::napi;
use pocket_tui_core::Size;
use pocket_tui_terminal::{InputEvent, KeyCode, KeyModifiers};

use runtime_adapter::{MemoryStatsSnapshot, RuntimeAdapter};

/// Native-owned memory and retained-history counters. Number-valued fields use
/// JavaScript doubles because these are telemetry rather than opaque IDs.
#[napi(object)]
pub struct NativeMemoryStats {
    pub scene_nodes: f64,
    pub documents: f64,
    pub blocks: f64,
    pub open_blocks: f64,
    pub sealed_blocks: f64,
    pub document_text_bytes: f64,
    pub document_budget_bytes: f64,
    pub estimated_document_rows: f64,
    pub estimated_native_bytes: f64,
    pub terminal_pending_bytes: f64,
}

/// Minimal tagged input record kept deliberately stable across the N-API ABI.
#[napi(object)]
pub struct NativeInputEvent {
    pub kind: String,
    pub text: Option<String>,
    pub key: Option<String>,
    pub ctrl: Option<bool>,
    pub alt: Option<bool>,
    pub shift: Option<bool>,
    pub columns: Option<u32>,
    pub rows: Option<u32>,
}

/// Current terminal viewport dimensions in character cells.
#[napi(object)]
pub struct NativeViewportSize {
    pub columns: u32,
    pub rows: u32,
}

#[napi]
pub fn native_version() -> &'static str {
    pocket_tui_core::VERSION
}

/// A single native PocketTUI session owned by JavaScript.
#[napi]
pub struct NativeTui {
    runtime: Mutex<RuntimeAdapter>,
}

#[napi]
impl NativeTui {
    #[allow(clippy::new_without_default)]
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            runtime: Mutex::new(RuntimeAdapter::default()),
        }
    }

    /// Decode and atomically apply one PTX1 packet. The accepted sequence is
    /// returned as a decimal string so no JavaScript number precision is lost.
    #[napi]
    pub fn submit(&self, packet: Uint8Array) -> Result<String> {
        let decoded = protocol::decode(packet.as_ref()).map_err(invalid_arg)?;
        self.with_runtime(|runtime| runtime.apply(decoded))
            .map(|sequence| sequence.to_string())
    }

    #[napi]
    pub fn start(&self) -> Result<()> {
        self.with_runtime(RuntimeAdapter::start)
    }

    #[napi]
    pub fn flush(&self) -> Result<()> {
        self.with_runtime(RuntimeAdapter::flush)
    }

    /// Drain terminal input without blocking the JavaScript event loop.
    #[napi]
    pub fn poll_input(&self) -> Result<Vec<NativeInputEvent>> {
        self.with_runtime(RuntimeAdapter::poll_input)
            .map(|events| events.into_iter().map(NativeInputEvent::from).collect())
    }

    /// Read the latest viewport dimensions directly from the attached tty.
    #[napi]
    pub fn viewport_size(&self) -> Result<NativeViewportSize> {
        self.with_runtime(RuntimeAdapter::viewport_size)
            .map(Into::into)
    }

    #[napi]
    pub fn memory_stats(&self) -> Result<NativeMemoryStats> {
        self.with_runtime(|runtime| Ok(runtime.memory_stats()))
            .map(Into::into)
    }

    #[napi]
    pub fn close(&self) -> Result<()> {
        self.with_runtime(RuntimeAdapter::close)
    }
}

impl NativeTui {
    fn with_runtime<T>(
        &self,
        operation: impl FnOnce(&mut RuntimeAdapter) -> std::result::Result<T, String>,
    ) -> Result<T> {
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "native runtime lock poisoned"))?;
        operation(&mut runtime).map_err(|message| Error::new(Status::GenericFailure, message))
    }
}

fn invalid_arg(error: impl std::fmt::Display) -> Error {
    Error::new(Status::InvalidArg, error.to_string())
}

impl From<MemoryStatsSnapshot> for NativeMemoryStats {
    fn from(stats: MemoryStatsSnapshot) -> Self {
        Self {
            scene_nodes: stats.scene_nodes as f64,
            documents: stats.documents as f64,
            blocks: stats.blocks as f64,
            open_blocks: stats.open_blocks as f64,
            sealed_blocks: stats.sealed_blocks as f64,
            document_text_bytes: stats.document_text_bytes as f64,
            document_budget_bytes: stats.document_budget_bytes as f64,
            estimated_document_rows: stats.estimated_document_rows as f64,
            estimated_native_bytes: stats.estimated_native_bytes as f64,
            terminal_pending_bytes: stats.terminal_pending_bytes as f64,
        }
    }
}

impl From<Size> for NativeViewportSize {
    fn from(size: Size) -> Self {
        Self {
            columns: size.columns.into(),
            rows: size.rows.into(),
        }
    }
}

impl From<InputEvent> for NativeInputEvent {
    fn from(event: InputEvent) -> Self {
        match event {
            InputEvent::Text(text) => Self::text("text", text),
            InputEvent::Key(event) => Self {
                kind: "key".to_owned(),
                text: None,
                key: Some(key_name(event.code)),
                ctrl: Some(event.modifiers.contains(KeyModifiers::CTRL)),
                alt: Some(false),
                shift: Some(false),
                columns: None,
                rows: None,
            },
            InputEvent::PasteStart => Self::tag("paste-start"),
            InputEvent::PasteChunk(text) => Self::text("paste-chunk", text),
            InputEvent::PasteEnd => Self::tag("paste-end"),
            InputEvent::Resize { columns, rows } => Self {
                kind: "resize".to_owned(),
                text: None,
                key: None,
                ctrl: None,
                alt: None,
                shift: None,
                columns: Some(columns.into()),
                rows: Some(rows.into()),
            },
        }
    }
}

impl NativeInputEvent {
    fn tag(kind: &str) -> Self {
        Self {
            kind: kind.to_owned(),
            text: None,
            key: None,
            ctrl: None,
            alt: None,
            shift: None,
            columns: None,
            rows: None,
        }
    }

    fn text(kind: &str, text: String) -> Self {
        Self {
            kind: kind.to_owned(),
            text: Some(text),
            ..Self::tag(kind)
        }
    }
}

fn key_name(code: KeyCode) -> String {
    match code {
        KeyCode::Char(character) => character.to_string(),
        KeyCode::Enter => "enter".to_owned(),
        KeyCode::Backspace => "backspace".to_owned(),
        KeyCode::Escape => "escape".to_owned(),
        KeyCode::ArrowUp => "arrow-up".to_owned(),
        KeyCode::ArrowDown => "arrow-down".to_owned(),
        KeyCode::ArrowLeft => "arrow-left".to_owned(),
        KeyCode::ArrowRight => "arrow-right".to_owned(),
        KeyCode::UnknownEscape => "unknown-escape".to_owned(),
    }
}
