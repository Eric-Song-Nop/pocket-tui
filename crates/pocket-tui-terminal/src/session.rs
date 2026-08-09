//! Transactional terminal session.

use std::io::{self, Write};
use std::os::fd::RawFd;
use std::sync::Arc;

use pocket_tui_core::FrameArtifact;
use thiserror::Error;

use crate::capability::TerminalCapabilities;
use crate::encoder::{EncodeError, encode_transition, resolve_frame};
use crate::guard::TerminalGuard;
use crate::state::{PhysicalState, ScreenModel};
use crate::transport::FdWriter;

/// Failure while opening, encoding, writing, or closing a terminal session.
#[derive(Debug, Error)]
pub enum TerminalError {
    /// The output transport failed.
    #[error("terminal I/O failed: {0}")]
    Io(#[from] io::Error),
    /// A core frame violated a terminal paint invariant.
    #[error(transparent)]
    Encode(#[from] EncodeError),
    /// A frame older than the latest desired/confirmed generation was submitted.
    #[error("stale frame generation {submitted}; latest generation is {latest}")]
    StaleGeneration { submitted: u64, latest: u64 },
    /// The generic transport blocked; call `resume_write` when it is writable.
    #[error("terminal output is still pending")]
    OutputPending,
    /// The session was already closed.
    #[error("terminal session is closed")]
    Closed,
}

/// Observable progress of the desired/in-flight/confirmed state machine.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SessionProgress {
    /// Last generation whose entire patch was accepted by the writer.
    pub confirmed_generation: u64,
    /// Most recently submitted desired generation.
    pub desired_generation: Option<u64>,
    /// Whether an encoded patch still has an unwritten suffix.
    pub in_flight: bool,
    /// Bytes remaining in the current immutable patch.
    pub pending_bytes: usize,
}

impl SessionProgress {
    /// True when the latest desired generation is confirmed and no suffix is
    /// waiting for output readiness.
    #[must_use]
    pub fn is_idle(self) -> bool {
        !self.in_flight
            && self
                .desired_generation
                .is_none_or(|desired| desired <= self.confirmed_generation)
    }
}

struct InFlight {
    bytes: Vec<u8>,
    offset: usize,
    predicted: PhysicalState,
}

/// An alternate-screen session with transactional terminal output.
///
/// Intermediate desired frames replace one another while a patch is blocked,
/// but the immutable in-flight suffix is always completed first. This keeps the
/// confirmed state a valid baseline for the next row diff.
pub struct TerminalSession<W: Write> {
    writer: W,
    capabilities: TerminalCapabilities,
    guard: Option<TerminalGuard>,
    confirmed: PhysicalState,
    desired: Option<Arc<ScreenModel>>,
    in_flight: Option<InFlight>,
    closed: bool,
}

impl<W: Write> TerminalSession<W> {
    /// Create a session over an already configured output transport.
    ///
    /// This constructor does not change tty modes. Use [`TerminalSession::open_stdio`]
    /// for the runnable stdin/stdout alternate-screen path.
    #[must_use]
    pub fn new(writer: W, capabilities: TerminalCapabilities) -> Self {
        Self {
            writer,
            capabilities,
            guard: None,
            confirmed: PhysicalState::empty(),
            desired: None,
            in_flight: None,
            closed: false,
        }
    }

    fn with_guard(writer: W, capabilities: TerminalCapabilities, guard: TerminalGuard) -> Self {
        let mut session = Self::new(writer, capabilities);
        session.guard = Some(guard);
        session
    }

    /// Submit a core frame and make as much write progress as the transport
    /// currently permits.
    pub fn present(&mut self, frame: &FrameArtifact) -> Result<SessionProgress, TerminalError> {
        self.ensure_open()?;
        let desired = Arc::new(resolve_frame(frame)?);
        let latest = self
            .desired
            .as_ref()
            .map_or(self.confirmed.generation(), |screen| screen.generation)
            .max(self.confirmed.generation());
        if desired.generation < latest {
            return Err(TerminalError::StaleGeneration {
                submitted: desired.generation,
                latest,
            });
        }
        self.desired = Some(desired);
        self.drive()
    }

    /// Continue the exact unwritten suffix and then, if needed, plan directly
    /// from its committed target to the newest desired generation.
    pub fn resume_write(&mut self) -> Result<SessionProgress, TerminalError> {
        self.ensure_open()?;
        self.drive()
    }

    /// Progress pending terminal bytes and flush the underlying writer once the
    /// latest generation is confirmed.
    pub fn flush(&mut self) -> Result<SessionProgress, TerminalError> {
        self.ensure_open()?;
        let progress = self.drive()?;
        if progress.is_idle() {
            self.writer.flush()?;
        }
        Ok(progress)
    }

    /// Restore the terminal after all output has been accepted. If the writer
    /// is nonblocking, wait for readiness and call `resume_write` first.
    pub fn close(&mut self) -> Result<(), TerminalError> {
        if self.closed {
            return Ok(());
        }
        let progress = self.flush()?;
        if !progress.is_idle() {
            return Err(TerminalError::OutputPending);
        }
        if let Some(guard) = &mut self.guard {
            guard.restore()?;
        }
        self.closed = true;
        Ok(())
    }

    /// The last state whose complete patch was accepted by the output writer.
    #[must_use]
    pub const fn confirmed_state(&self) -> &PhysicalState {
        &self.confirmed
    }

    /// Current writer progress without performing I/O.
    #[must_use]
    pub fn progress(&self) -> SessionProgress {
        let desired_generation = self.desired.as_ref().map(|screen| screen.generation);
        let (in_flight, pending_bytes) = self.in_flight.as_ref().map_or((false, 0), |patch| {
            (true, patch.bytes.len().saturating_sub(patch.offset))
        });
        SessionProgress {
            confirmed_generation: self.confirmed.generation(),
            desired_generation,
            in_flight,
            pending_bytes,
        }
    }

    fn ensure_open(&self) -> Result<(), TerminalError> {
        if self.closed {
            Err(TerminalError::Closed)
        } else {
            Ok(())
        }
    }

    fn drive(&mut self) -> Result<SessionProgress, TerminalError> {
        loop {
            if self.in_flight.is_none() {
                let Some(desired) = self.desired.as_ref() else {
                    return Ok(self.progress());
                };
                if desired.generation <= self.confirmed.generation() {
                    return Ok(self.progress());
                }
                let transition =
                    encode_transition(&self.confirmed, Arc::clone(desired), self.capabilities);
                self.in_flight = Some(InFlight {
                    bytes: transition.bytes,
                    offset: 0,
                    predicted: transition.predicted,
                });
            }

            let patch = self.in_flight.as_mut().expect("patch was created above");
            while patch.offset < patch.bytes.len() {
                match self.writer.write(&patch.bytes[patch.offset..]) {
                    Ok(0) => {
                        return Err(io::Error::new(
                            io::ErrorKind::WriteZero,
                            "terminal writer returned zero",
                        )
                        .into());
                    }
                    Ok(written) => patch.offset += written,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        return Ok(self.progress());
                    }
                    Err(error) => return Err(error.into()),
                }
            }

            let completed = self.in_flight.take().expect("completed patch exists");
            self.confirmed = completed.predicted;
        }
    }
}

impl TerminalSession<FdWriter> {
    /// Enter raw mode and the alternate screen on stdin/stdout.
    pub fn open_stdio(capabilities: TerminalCapabilities) -> Result<Self, TerminalError> {
        let guard = TerminalGuard::stdio()?;
        Ok(Self::with_guard(
            FdWriter::new(libc::STDOUT_FILENO),
            capabilities,
            guard,
        ))
    }

    /// Wait for stdout readiness until the latest desired frame is confirmed.
    pub fn flush_blocking(&mut self) -> Result<(), TerminalError> {
        loop {
            let progress = self.flush()?;
            if progress.is_idle() {
                return Ok(());
            }
            poll_writable(self.writer.raw_fd())?;
        }
    }

    /// Flush all output and restore stdin/stdout terminal state.
    pub fn close_blocking(&mut self) -> Result<(), TerminalError> {
        if self.closed {
            return Ok(());
        }
        self.flush_blocking()?;
        if let Some(guard) = &mut self.guard {
            guard.restore()?;
        }
        self.closed = true;
        Ok(())
    }

    /// Borrowed stdout file descriptor used for readiness registration.
    #[must_use]
    pub fn output_fd(&self) -> RawFd {
        self.writer.raw_fd()
    }
}

fn poll_writable(fd: RawFd) -> io::Result<()> {
    let mut descriptor = libc::pollfd {
        fd,
        events: libc::POLLOUT,
        revents: 0,
    };
    loop {
        // SAFETY: `descriptor` points at one initialized pollfd.
        let result = unsafe { libc::poll(&mut descriptor, 1, -1) };
        if result > 0 {
            return Ok(());
        }
        if result == 0 {
            continue;
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use pocket_tui_core::{Runtime, Size};

    use super::*;

    #[derive(Clone, Default)]
    struct ScriptedWriter {
        state: Arc<Mutex<WriterState>>,
    }

    #[derive(Default)]
    struct WriterState {
        bytes: Vec<u8>,
        first_short_write: bool,
        blocked: bool,
    }

    impl Write for ScriptedWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let mut state = self.state.lock().unwrap();
            if state.blocked {
                return Err(io::Error::from(io::ErrorKind::WouldBlock));
            }
            if !state.first_short_write {
                state.first_short_write = true;
                let written = bytes.len().min(3);
                state.bytes.extend_from_slice(&bytes[..written]);
                state.blocked = true;
                return Ok(written);
            }
            state.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn confirmed_generation_waits_for_the_exact_suffix() {
        let writer = ScriptedWriter::default();
        let state = Arc::clone(&writer.state);
        let mut session = TerminalSession::new(writer, TerminalCapabilities::conservative());
        let mut runtime = Runtime::new(Size::new(1, 1));
        let frame = runtime.render_frame().unwrap();

        let blocked = session.present(&frame).unwrap();
        assert!(blocked.in_flight);
        assert_eq!(blocked.confirmed_generation, 0);
        let prefix = state.lock().unwrap().bytes.clone();
        assert_eq!(prefix.len(), 3);

        state.lock().unwrap().blocked = false;
        let complete = session.resume_write().unwrap();
        assert!(complete.is_idle());
        assert_eq!(complete.confirmed_generation, frame.generation.0);

        let output = state.lock().unwrap().bytes.clone();
        assert_eq!(&output[..3], prefix.as_slice());
        assert!(output.ends_with(b"\x1b[0m\x1b[H"));
    }
}
