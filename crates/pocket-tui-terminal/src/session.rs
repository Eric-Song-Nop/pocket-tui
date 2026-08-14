//! Transactional terminal session.

use std::io::{self, Write};
use std::os::fd::RawFd;
use std::sync::Arc;

use pocket_tui_core::Color;
use pocket_tui_core::FrameArtifact;
use thiserror::Error;

use crate::capability::TerminalCapabilities;
use crate::encoder::{
    EncodeError, encode_transition, normalize_effect_presentation, resolve_frame,
};
use crate::guard::TerminalGuard;
use crate::input::{InputError, InputEvent, TerminalInput};
use crate::state::{CursorState, EffectBusState, PhysicalState, ScreenModel};
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
    /// Input parsing or nonblocking descriptor setup failed.
    #[error(transparent)]
    Input(#[from] InputError),
    /// A frame older than the latest desired/confirmed generation was submitted.
    #[error("stale frame generation {submitted}; latest generation is {latest}")]
    StaleGeneration { submitted: u64, latest: u64 },
    /// The generic transport blocked; call `resume_write` when it is writable.
    #[error("terminal output is still pending")]
    OutputPending,
    /// The session was already closed.
    #[error("terminal session is closed")]
    Closed,
    /// The session was constructed without a terminal input descriptor.
    #[error("terminal input is not attached to this session")]
    InputUnavailable,
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
    input: Option<TerminalInput>,
    guard: Option<TerminalGuard>,
    confirmed: PhysicalState,
    desired: Option<Arc<ScreenModel>>,
    desired_cursor: CursorState,
    desired_effect_bus: EffectBusState,
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
            input: None,
            guard: None,
            confirmed: PhysicalState::empty(),
            desired: None,
            desired_cursor: CursorState::default(),
            desired_effect_bus: EffectBusState::default(),
            in_flight: None,
            closed: false,
        }
    }

    fn with_guard(
        writer: W,
        capabilities: TerminalCapabilities,
        input: TerminalInput,
        guard: TerminalGuard,
    ) -> Self {
        let mut session = Self::new(writer, capabilities);
        session.input = Some(input);
        session.guard = Some(guard);
        session
    }

    /// Submit a core frame and make as much write progress as the transport
    /// currently permits.
    pub fn present(&mut self, frame: &FrameArtifact) -> Result<SessionProgress, TerminalError> {
        self.present_with_cursor(frame, CursorState::default())
    }

    /// Submit a frame with an explicit final cursor anchor. Ghostty exposes
    /// this state to custom shaders, while ordinary terminals simply display
    /// the requested cursor.
    pub fn present_with_cursor(
        &mut self,
        frame: &FrameArtifact,
        cursor: CursorState,
    ) -> Result<SessionProgress, TerminalError> {
        self.present_with_effect_bus(frame, cursor, EffectBusState::default())
    }

    /// Submit a frame, cursor anchor, and optional post-processing state as one
    /// transactional terminal transition.
    pub fn present_with_effect_bus(
        &mut self,
        frame: &FrameArtifact,
        cursor: CursorState,
        effect_bus: EffectBusState,
    ) -> Result<SessionProgress, TerminalError> {
        self.ensure_open()?;
        let (cursor, effect_bus) =
            normalize_effect_presentation(cursor, effect_bus, self.capabilities);
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
        if let Some(guard) = self.guard.as_mut() {
            guard.note_cursor_override(cursor.color != Color::Default, cursor.visible);
            if effect_bus.enabled {
                guard.note_effect_bus_override();
            }
        }
        self.desired = Some(desired);
        self.desired_cursor = cursor;
        self.desired_effect_bus = effect_bus;
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
        self.restore_terminal()?;
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

    fn restore_terminal(&mut self) -> Result<(), TerminalError> {
        let input_result = self.input.as_mut().map_or(Ok(()), TerminalInput::restore);
        let guard_result = self.guard.as_mut().map_or(Ok(()), TerminalGuard::restore);
        input_result?;
        guard_result?;
        Ok(())
    }

    fn drive(&mut self) -> Result<SessionProgress, TerminalError> {
        loop {
            if self.in_flight.is_none() {
                let Some(desired) = self.desired.as_ref() else {
                    return Ok(self.progress());
                };
                if desired.generation < self.confirmed.generation()
                    || (desired.generation == self.confirmed.generation()
                        && self.desired_cursor == self.confirmed.cursor()
                        && self.desired_effect_bus == self.confirmed.effect_bus())
                {
                    return Ok(self.progress());
                }
                let transition = encode_transition(
                    &self.confirmed,
                    Arc::clone(desired),
                    self.desired_cursor,
                    self.desired_effect_bus,
                    self.capabilities,
                );
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
        let input = TerminalInput::stdio()?;
        Ok(Self::with_guard(
            FdWriter::new(libc::STDOUT_FILENO),
            capabilities,
            input,
            guard,
        ))
    }

    /// Drain currently available stdin bytes into typed events without waiting.
    pub fn read_available(&mut self) -> Result<Vec<InputEvent>, TerminalError> {
        self.ensure_open()?;
        self.input
            .as_mut()
            .ok_or(TerminalError::InputUnavailable)?
            .read_available()
            .map_err(Into::into)
    }

    /// Alias used by event loops to poll nonblocking terminal input.
    pub fn poll_input(&mut self) -> Result<Vec<InputEvent>, TerminalError> {
        self.read_available()
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
        self.restore_terminal()?;
        self.closed = true;
        Ok(())
    }

    /// Borrowed stdout file descriptor used for readiness registration.
    #[must_use]
    pub fn output_fd(&self) -> RawFd {
        self.writer.raw_fd()
    }

    /// Borrowed stdin descriptor used for readability registration.
    pub fn input_fd(&self) -> Result<RawFd, TerminalError> {
        self.input
            .as_ref()
            .map(TerminalInput::input_fd)
            .ok_or(TerminalError::InputUnavailable)
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
        assert!(output.ends_with(b"\x1b[0m\x1b[?25l\x1b[H"));
    }

    #[test]
    fn effect_bus_confirmation_waits_for_the_exact_partial_write_suffix() {
        let writer = ScriptedWriter::default();
        let state = Arc::clone(&writer.state);
        let mut session = TerminalSession::new(writer, TerminalCapabilities::ghostty());
        let mut runtime = Runtime::new(Size::new(1, 1));
        let frame = runtime.render_frame().unwrap();
        let effect_bus = EffectBusState {
            enabled: true,
            channels: [[3, 40, 0], [200, 90, 255], [128, 128, 70]],
            cursor_shade: true,
        };

        let blocked = session
            .present_with_effect_bus(&frame, CursorState::default(), effect_bus)
            .unwrap();
        assert!(blocked.in_flight);
        assert_eq!(
            session.confirmed_state().effect_bus(),
            EffectBusState::default()
        );

        state.lock().unwrap().blocked = false;
        let complete = session.resume_write().unwrap();
        assert!(complete.is_idle());
        assert_eq!(session.confirmed_state().effect_bus(), effect_bus);

        let output = state.lock().unwrap().bytes.clone();
        let palette = b"\x1b]4;240;#505458;241;#032800;242;#c85aff;243;#808046\x1b\\";
        assert!(output.windows(palette.len()).any(|bytes| bytes == palette));
        let cursor_color = b"\x1b]12;#2ab8db\x1b\\";
        assert!(
            output
                .windows(cursor_color.len())
                .any(|bytes| bytes == cursor_color)
        );
    }
}
