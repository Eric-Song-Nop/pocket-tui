mod protocol;
mod runtime_adapter;

use std::sync::Mutex;
use std::time::Duration;

use napi::bindgen_prelude::{Function, Uint8Array};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::{Error, Result, Status};
use napi_derive::napi;
use pocket_tui_core::Size;
use pocket_tui_terminal::{
    InputEvent, InputReadinessArm, InputReadinessWatcher, KeyCode, KeyModifiers,
};

use runtime_adapter::{InputReadinessState, MemoryStatsSnapshot, RuntimeAdapter};

const RESIZE_HEARTBEAT: Duration = Duration::from_millis(250);

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
    input_ready: Mutex<Option<InputReadinessWatcher>>,
}

#[napi]
impl NativeTui {
    #[allow(clippy::new_without_default)]
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            runtime: Mutex::new(RuntimeAdapter::default()),
            input_ready: Mutex::new(None),
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
        let (events, readiness) = self.with_runtime(|runtime| {
            let events = runtime.poll_input()?;
            let readiness = runtime.input_readiness_state()?;
            Ok((events, readiness))
        })?;
        self.rearm_input_ready(readiness)?;
        Ok(events.into_iter().map(NativeInputEvent::from).collect())
    }

    /// Register a long-lived, one-shot terminal input readiness callback.
    /// Every `poll_input` call automatically rearms it after draining input.
    #[napi]
    pub fn on_input_ready(&self, callback: Function<'_, (), ()>) -> Result<()> {
        let threadsafe = callback
            .build_threadsafe_function::<()>()
            .max_queue_size::<1>()
            .build()?;
        let readiness = self
            .with_runtime(|runtime| runtime.input_readiness_state())?
            .ok_or_else(|| {
                Error::new(
                    Status::GenericFailure,
                    "start the native terminal session before registering input readiness",
                )
            })?;

        self.stop_input_ready()?;
        let watcher = InputReadinessWatcher::new(
            readiness.input_fd,
            readiness.resize_fd,
            readiness.viewport,
            move |_| {
                let _ = threadsafe.call((), ThreadsafeFunctionCallMode::NonBlocking);
            },
        )
        .map_err(readiness_error)?;
        watcher
            .rearm(InputReadinessArm {
                escape_deadline: readiness.escape_deadline,
                resize_heartbeat: Some(RESIZE_HEARTBEAT),
                confirmed_viewport: Some(readiness.viewport),
            })
            .map_err(readiness_error)?;
        let mut slot = self
            .input_ready
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "input readiness lock poisoned"))?;
        *slot = Some(watcher);
        Ok(())
    }

    /// Stop input readiness delivery and join its native poll thread.
    #[napi]
    pub fn clear_input_ready(&self) -> Result<()> {
        self.stop_input_ready()
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
        let readiness_result = self.stop_input_ready();
        let runtime_result = self.with_runtime(RuntimeAdapter::close);
        readiness_result?;
        runtime_result
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

    fn rearm_input_ready(&self, readiness: Option<InputReadinessState>) -> Result<()> {
        let slot = self
            .input_ready
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "input readiness lock poisoned"))?;
        if let (Some(watcher), Some(readiness)) = (slot.as_ref(), readiness) {
            watcher
                .rearm(InputReadinessArm {
                    escape_deadline: readiness.escape_deadline,
                    resize_heartbeat: Some(RESIZE_HEARTBEAT),
                    confirmed_viewport: Some(readiness.viewport),
                })
                .map_err(readiness_error)?;
        }
        Ok(())
    }

    fn stop_input_ready(&self) -> Result<()> {
        let watcher = {
            let mut slot = self
                .input_ready
                .lock()
                .map_err(|_| Error::new(Status::GenericFailure, "input readiness lock poisoned"))?;
            slot.take()
        };
        watcher
            .map(InputReadinessWatcher::shutdown)
            .transpose()
            .map(|_| ())
            .map_err(readiness_error)
    }
}

impl Drop for NativeTui {
    fn drop(&mut self) {
        let slot = match self.input_ready.get_mut() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(watcher) = slot.take() {
            let _ = watcher.shutdown();
        }
        // RuntimeAdapter drops after this body, so tty restore cannot race the
        // poll thread or a borrowed input descriptor.
    }
}

fn invalid_arg(error: impl std::fmt::Display) -> Error {
    Error::new(Status::InvalidArg, error.to_string())
}

fn readiness_error(error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, error.to_string())
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
