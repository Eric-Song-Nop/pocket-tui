//! Unix terminal lifecycle guard.

use std::io;
use std::os::fd::RawFd;

const ENTER_ALTERNATE_SCREEN: &[u8] = b"\x1b[?1049h\x1b[?25l\x1b[0m";
const LEAVE_ALTERNATE_SCREEN: &[u8] = b"\x1b[0m\x1b[?25h\x1b[?1049l";

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

        let output_result = write_all_fd(self.output_fd, LEAVE_ALTERNATE_SCREEN);
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
