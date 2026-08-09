//! Output transports used by terminal sessions.

use std::io::{self, Write};
use std::os::fd::RawFd;

/// A non-owning [`Write`] adapter for a Unix file descriptor.
#[derive(Clone, Copy, Debug)]
pub struct FdWriter {
    fd: RawFd,
}

impl FdWriter {
    /// Wrap a borrowed output descriptor. Dropping the writer does not close it.
    #[must_use]
    pub const fn new(fd: RawFd) -> Self {
        Self { fd }
    }

    /// The borrowed raw descriptor.
    #[must_use]
    pub const fn raw_fd(self) -> RawFd {
        self.fd
    }
}

impl Write for FdWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        // SAFETY: `buffer` is readable for its length and this adapter borrows a
        // descriptor the caller promises is open for output.
        let result = unsafe { libc::write(self.fd, buffer.as_ptr().cast(), buffer.len()) };
        if result < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(result as usize)
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
