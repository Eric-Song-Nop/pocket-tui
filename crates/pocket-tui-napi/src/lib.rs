mod protocol;
mod runtime_adapter;

use std::sync::Mutex;

use napi::bindgen_prelude::Uint8Array;
use napi::{Error, Result, Status};
use napi_derive::napi;

use runtime_adapter::RuntimeAdapter;

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
