//! Unix terminal lifecycle guard.

use std::io;
use std::os::fd::RawFd;

const ENTER_ALTERNATE_SCREEN: &[u8] = b"\x1b[?1049h\x1b[?2004h\x1b[?25l\x1b[0m";
const RESET_CURSOR_COLOR: &[u8] = b"\x1b]112\x1b\\";
const RESET_EFFECT_BUS: &[u8] = b"\x1b]104;240;241;242;243\x1b\\";
const RESET_CURSOR_SHAPE: &[u8] = b"\x1b[0 q";
const LEAVE_ALTERNATE_SCREEN: &[u8] = b"\x1b[?2004l\x1b[?25h\x1b[?1049l";

/// Restores Unix terminal modes, cursor visibility, and the main screen on drop.
///
/// The guard borrows file descriptors; it never closes them. `TerminalSession`
/// uses stdin and stdout by default, but tests and embedders may provide other
/// TTY descriptors.
#[derive(Debug)]
pub struct TerminalGuard {
    input_fd: RawFd,
    output_fd: RawFd,
    original_termios: libc::termios,
    cursor_color_overridden: bool,
    cursor_shape_overridden: bool,
    effect_bus_overridden: bool,
    active: bool,
}

impl TerminalGuard {
    /// Put `input_fd` in raw mode, enter the alternate screen on `output_fd`,
    /// hide the cursor, and return a restoration guard.
    pub fn enter(input_fd: RawFd, output_fd: RawFd) -> io::Result<Self> {
        ensure_tty(input_fd, "terminal input")?;
        ensure_tty(output_fd, "terminal output")?;

        let mut original = std::mem::MaybeUninit::<libc::termios>::uninit();
        // SAFETY: `original` points at writable storage and `input_fd` is valid
        // for the duration of this call. A successful tcgetattr initializes it.
        if unsafe { libc::tcgetattr(input_fd, original.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: tcgetattr returned success above.
        let original = unsafe { original.assume_init() };
        let mut raw = original;
        // SAFETY: `raw` is an initialized termios value.
        unsafe { libc::cfmakeraw(&mut raw) };
        raw.c_cc[libc::VMIN] = 1;
        raw.c_cc[libc::VTIME] = 0;

        // SAFETY: both the fd and termios pointer are valid for this call.
        if unsafe { libc::tcsetattr(input_fd, libc::TCSAFLUSH, &raw) } != 0 {
            return Err(io::Error::last_os_error());
        }

        if let Err(error) = write_all_fd(output_fd, ENTER_ALTERNATE_SCREEN) {
            // The write may have stopped after enabling one or more modes.
            // Always attempt the same restoration sequence used by an owned
            // guard before returning the original causal error.
            let _ = write_all_fd(output_fd, &restoration_bytes(false, false, false));
            // SAFETY: best-effort rollback using the saved, initialized state.
            unsafe {
                libc::tcsetattr(input_fd, libc::TCSAFLUSH, &original);
            }
            return Err(error);
        }

        Ok(Self {
            input_fd,
            output_fd,
            original_termios: original,
            cursor_color_overridden: false,
            cursor_shape_overridden: false,
            effect_bus_overridden: false,
            active: true,
        })
    }

    /// Enter raw alternate-screen mode using stdin and stdout.
    pub fn stdio() -> io::Result<Self> {
        Self::enter(libc::STDIN_FILENO, libc::STDOUT_FILENO)
    }

    /// Restore the terminal now. Calling this more than once is harmless.
    pub fn restore(&mut self) -> io::Result<()> {
        if !self.active {
            return Ok(());
        }

        let output_result = write_all_fd(
            self.output_fd,
            &restoration_bytes(
                self.cursor_color_overridden,
                self.cursor_shape_overridden,
                self.effect_bus_overridden,
            ),
        );
        // SAFETY: the descriptor is borrowed and the saved termios remains
        // initialized for the lifetime of this guard.
        let termios_result = unsafe {
            if libc::tcsetattr(self.input_fd, libc::TCSAFLUSH, &self.original_termios) == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        };
        self.active = false;

        output_result.and(termios_result)
    }

    /// Whether this guard still owns the raw alternate-screen session.
    #[must_use]
    pub const fn is_active(&self) -> bool {
        self.active
    }

    /// Record cursor state that must be reset if the process exits early.
    pub fn note_cursor_override(&mut self, color: bool, shape: bool) {
        self.cursor_color_overridden |= color;
        self.cursor_shape_overridden |= shape;
    }

    /// Record that the four reserved effect-bus palette slots need cleanup.
    pub fn note_effect_bus_override(&mut self) {
        self.effect_bus_overridden = true;
        self.cursor_color_overridden = true;
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

fn ensure_tty(fd: RawFd, description: &str) -> io::Result<()> {
    // SAFETY: isatty only inspects the borrowed descriptor.
    if unsafe { libc::isatty(fd) } == 1 {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::NotConnected,
            format!("{description} is not a TTY"),
        ))
    }
}

fn write_all_fd(fd: RawFd, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        // SAFETY: the slice is valid for `bytes.len()` and the borrowed fd is
        // expected to be writable by the caller.
        let written = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        if written > 0 {
            bytes = &bytes[written as usize..];
            continue;
        }
        if written == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "terminal write returned zero",
            ));
        }

        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            continue;
        }
        return Err(error);
    }
    Ok(())
}

fn restoration_bytes(reset_color: bool, reset_shape: bool, reset_effect_bus: bool) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(80);
    bytes.extend_from_slice(b"\x1b[0m");
    if reset_effect_bus {
        bytes.extend_from_slice(RESET_EFFECT_BUS);
    }
    if reset_color {
        bytes.extend_from_slice(RESET_CURSOR_COLOR);
    }
    if reset_shape {
        bytes.extend_from_slice(RESET_CURSOR_SHAPE);
    }
    bytes.extend_from_slice(LEAVE_ALTERNATE_SCREEN);
    bytes
}

#[cfg(test)]
mod tests {
    use super::{ENTER_ALTERNATE_SCREEN, restoration_bytes};

    #[test]
    fn terminal_mode_sequences_pair_bracketed_paste_enable_and_disable() {
        assert_eq!(
            ENTER_ALTERNATE_SCREEN,
            b"\x1b[?1049h\x1b[?2004h\x1b[?25l\x1b[0m"
        );
        assert_eq!(
            restoration_bytes(false, false, false),
            b"\x1b[0m\x1b[?2004l\x1b[?25h\x1b[?1049l"
        );
    }

    #[test]
    fn cursor_resets_are_emitted_only_after_an_override() {
        assert_eq!(
            restoration_bytes(false, false, false),
            b"\x1b[0m\x1b[?2004l\x1b[?25h\x1b[?1049l"
        );
        assert_eq!(
            restoration_bytes(true, true, false),
            b"\x1b[0m\x1b]112\x1b\\\x1b[0 q\x1b[?2004l\x1b[?25h\x1b[?1049l"
        );
        assert_eq!(
            restoration_bytes(true, true, true),
            b"\x1b[0m\x1b]104;240;241;242;243\x1b\\\x1b]112\x1b\\\x1b[0 q\x1b[?2004l\x1b[?25h\x1b[?1049l"
        );
    }
}
