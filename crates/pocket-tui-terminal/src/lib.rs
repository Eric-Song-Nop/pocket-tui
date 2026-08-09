//! Alternate-screen terminal session, transition encoding, and output transport.
//!
//! The MVP deliberately keeps the terminal profile conservative.  It models the
//! desired, in-flight, and confirmed screens separately so a partial write can
//! never become the baseline for a later diff.

mod capability;
mod encoder;
mod guard;
mod input;
mod session;
mod state;
mod transport;

pub use capability::{ColorCapability, TerminalCapabilities};
pub use encoder::EncodeError;
pub use guard::TerminalGuard;
pub use input::{
    InputError, InputEvent, InputLimits, InputParser, KeyCode, KeyEvent, KeyModifiers,
    TerminalInput,
};
pub use session::{SessionProgress, TerminalError, TerminalSession};
pub use state::{CursorState, PhysicalState};
pub use transport::FdWriter;

pub use pocket_tui_core::VERSION;
