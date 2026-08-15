//! One-shot terminal input readiness notifications.
//!
//! The watcher deliberately never reads the input descriptor. It only reports
//! level-triggered readiness, leaving byte ownership and incremental parsing on
//! the terminal session's owner thread.

use std::io::{self, Read, Write};
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use pocket_tui_core::Size;

/// Why an armed input watcher fired.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InputReadyReason {
    /// The duplicated terminal input descriptor became readable.
    Readable,
    /// An ambiguous leading Escape reached its parser-owned deadline.
    EscapeDeadline,
    /// The fallback viewport-size probe heartbeat became due.
    ResizeHeartbeat,
    /// The input descriptor reported hangup or an I/O error.
    InputClosed,
}

/// Deadlines installed for one watcher arm.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct InputReadinessArm {
    /// Absolute deadline supplied by the owner of the Escape parser state.
    pub escape_deadline: Option<Instant>,
    /// Optional fallback interval for checking terminal viewport changes.
    pub resize_heartbeat: Option<Duration>,
    /// Latest viewport already confirmed by the runtime owner.
    pub confirmed_viewport: Option<Size>,
}

enum Command {
    Rearm(InputReadinessArm),
    Shutdown,
}

struct ActiveArm {
    escape_deadline: Option<Instant>,
    resize_deadline: Option<Instant>,
    resize_interval: Option<Duration>,
}

impl ActiveArm {
    fn new(arm: InputReadinessArm) -> Self {
        let now = Instant::now();
        Self {
            escape_deadline: arm.escape_deadline,
            resize_deadline: arm
                .resize_heartbeat
                .map(|interval| now.checked_add(interval).unwrap_or(now)),
            resize_interval: arm.resize_heartbeat,
        }
    }

    fn next_deadline(&self) -> Option<Instant> {
        match (self.escape_deadline, self.resize_deadline) {
            (Some(escape), Some(resize)) => Some(escape.min(resize)),
            (Some(deadline), None) | (None, Some(deadline)) => Some(deadline),
            (None, None) => None,
        }
    }

    fn refresh_resize_deadline(&mut self, now: Instant) {
        self.resize_deadline = self
            .resize_interval
            .map(|interval| now.checked_add(interval).unwrap_or(now));
    }
}

/// A long-lived, one-shot watcher for a borrowed terminal input descriptor.
///
/// Construction duplicates the input and optional resize descriptors, so
/// descriptor reuse cannot race the poll thread. Every call to [`Self::rearm`]
/// replaces any earlier arm. After a callback fires the watcher remains
/// disarmed until explicitly rearmed.
pub struct InputReadinessWatcher {
    commands: Sender<Command>,
    control_write: UnixStream,
    thread: Option<JoinHandle<io::Result<()>>>,
}

impl InputReadinessWatcher {
    /// Spawn the poll thread in a disarmed state.
    pub fn new(
        input_fd: RawFd,
        resize_fd: Option<RawFd>,
        confirmed_viewport: Size,
        callback: impl Fn(InputReadyReason) + Send + 'static,
    ) -> io::Result<Self> {
        let input = duplicate_fd(input_fd)?;
        let resize = resize_fd.map(duplicate_fd).transpose()?;
        let (control_read, control_write) = UnixStream::pair()?;
        control_read.set_nonblocking(true)?;
        control_write.set_nonblocking(true)?;
        let (commands, receiver) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("pocket-tui-input-ready".to_owned())
            .spawn(move || {
                poll_loop(
                    input,
                    resize,
                    confirmed_viewport,
                    control_read,
                    receiver,
                    callback,
                )
            })?;
        Ok(Self {
            commands,
            control_write,
            thread: Some(thread),
        })
    }

    /// Replace the current arm and wake the poll thread.
    pub fn rearm(&self, arm: InputReadinessArm) -> io::Result<()> {
        if arm
            .resize_heartbeat
            .is_some_and(|interval| interval.is_zero())
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "input readiness resize heartbeat must be greater than zero",
            ));
        }
        self.send(Command::Rearm(arm))
    }

    /// Stop the poll thread and wait until its callback can no longer run.
    pub fn shutdown(mut self) -> io::Result<()> {
        self.shutdown_inner()
    }

    fn send(&self, command: Command) -> io::Result<()> {
        self.commands
            .send(command)
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "input watcher stopped"))?;
        poke(&self.control_write)
    }

    fn shutdown_inner(&mut self) -> io::Result<()> {
        let Some(thread) = self.thread.take() else {
            return Ok(());
        };
        // A finished poll thread has already dropped its receiver/control end;
        // shutdown remains successful as long as joining that thread succeeds.
        let _ = self.send(Command::Shutdown);
        thread.join().map_err(|_| {
            io::Error::other("terminal input readiness thread panicked during shutdown")
        })?
    }
}

impl Drop for InputReadinessWatcher {
    fn drop(&mut self) {
        let _ = self.shutdown_inner();
    }
}

fn poll_loop(
    input: OwnedFd,
    resize: Option<OwnedFd>,
    mut viewport: Size,
    control: UnixStream,
    commands: Receiver<Command>,
    callback: impl Fn(InputReadyReason),
) -> io::Result<()> {
    let mut active = None;
    loop {
        if apply_commands(&commands, &mut active, &mut viewport) {
            return Ok(());
        }
        if let Some(reason) = take_due_reason(
            &mut active,
            resize.as_ref().map(AsRawFd::as_raw_fd),
            &mut viewport,
            Instant::now(),
        ) {
            callback(reason);
            continue;
        }

        let mut descriptors = [
            libc::pollfd {
                fd: control.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                // A negative descriptor is ignored by poll. This prevents a
                // persistent HUP from spinning while the watcher is disarmed.
                fd: active.as_ref().map_or(-1, |_| input.as_raw_fd()),
                events: libc::POLLIN | libc::POLLPRI,
                revents: 0,
            },
        ];
        let timeout = active
            .as_ref()
            .and_then(ActiveArm::next_deadline)
            .map_or(-1, poll_timeout_millis);

        let result = unsafe {
            // SAFETY: `descriptors` contains initialized pollfd values and is
            // exclusively borrowed for the duration of the call.
            libc::poll(
                descriptors.as_mut_ptr(),
                descriptors.len() as libc::nfds_t,
                timeout,
            )
        };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }

        let control_events = descriptors[0].revents;
        if control_events & libc::POLLIN != 0 {
            drain_control(&control)?;
            if apply_commands(&commands, &mut active, &mut viewport) {
                return Ok(());
            }
        }
        if control_events & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "input watcher control channel closed",
            ));
        }

        if active.is_none() {
            continue;
        }
        if let Some(reason) = take_due_reason(
            &mut active,
            resize.as_ref().map(AsRawFd::as_raw_fd),
            &mut viewport,
            Instant::now(),
        ) {
            callback(reason);
            continue;
        }

        let input_events = descriptors[1].revents;
        if input_events & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
            callback(InputReadyReason::InputClosed);
            return Ok(());
        }
        if input_events & (libc::POLLIN | libc::POLLPRI) != 0 {
            active = None;
            callback(InputReadyReason::Readable);
        }
    }
}

fn take_due_reason(
    active: &mut Option<ActiveArm>,
    resize_fd: Option<RawFd>,
    viewport: &mut Size,
    now: Instant,
) -> Option<InputReadyReason> {
    let arm = active.as_mut()?;
    if arm.escape_deadline.is_some_and(|deadline| deadline <= now) {
        *active = None;
        return Some(InputReadyReason::EscapeDeadline);
    }
    if arm.resize_deadline.is_none_or(|deadline| deadline > now) {
        return None;
    }

    let current = resize_fd.and_then(|fd| terminal_viewport(fd).ok());
    let changed = current.is_some_and(|current| current != *viewport);
    if let Some(current) = current {
        *viewport = current;
    }
    arm.refresh_resize_deadline(now);
    if changed {
        *active = None;
        Some(InputReadyReason::ResizeHeartbeat)
    } else {
        None
    }
}

fn apply_commands(
    commands: &Receiver<Command>,
    active: &mut Option<ActiveArm>,
    viewport: &mut Size,
) -> bool {
    loop {
        match commands.try_recv() {
            Ok(Command::Rearm(arm)) => {
                if let Some(confirmed) = arm.confirmed_viewport {
                    *viewport = confirmed;
                }
                *active = Some(ActiveArm::new(arm));
            }
            Ok(Command::Shutdown) | Err(TryRecvError::Disconnected) => return true,
            Err(TryRecvError::Empty) => return false,
        }
    }
}

fn duplicate_fd(fd: RawFd) -> io::Result<OwnedFd> {
    loop {
        let duplicated = unsafe {
            // SAFETY: `dup` only borrows `fd`; a successful return is a new,
            // independently owned descriptor.
            libc::dup(fd)
        };
        if duplicated >= 0 {
            let owned = unsafe {
                // SAFETY: `dup` returned a fresh descriptor owned by this call.
                OwnedFd::from_raw_fd(duplicated)
            };
            let flags = unsafe { libc::fcntl(owned.as_raw_fd(), libc::F_GETFD) };
            if flags < 0
                || unsafe {
                    libc::fcntl(owned.as_raw_fd(), libc::F_SETFD, flags | libc::FD_CLOEXEC)
                } < 0
            {
                return Err(io::Error::last_os_error());
            }
            return Ok(owned);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn terminal_viewport(fd: RawFd) -> io::Result<Size> {
    let mut size = MaybeUninit::<libc::winsize>::zeroed();
    let result = unsafe {
        // SAFETY: `size` points to writable winsize storage and ioctl only
        // borrows the duplicated terminal descriptor.
        libc::ioctl(fd, libc::TIOCGWINSZ, size.as_mut_ptr())
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    let size = unsafe {
        // SAFETY: a successful TIOCGWINSZ initializes the complete winsize.
        size.assume_init()
    };
    if size.ws_col == 0 || size.ws_row == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "terminal reported a zero-sized viewport",
        ));
    }
    Ok(Size::new(size.ws_col, size.ws_row))
}

fn poke(control: &UnixStream) -> io::Result<()> {
    loop {
        match (&*control).write(&[1]) {
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            // The byte is only a wake hint. A full socket is already readable,
            // while the authoritative command remains queued in `mpsc`.
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
            Err(error) => return Err(error),
        }
    }
}

fn drain_control(control: &UnixStream) -> io::Result<()> {
    let mut bytes = [0u8; 128];
    loop {
        match (&*control).read(&mut bytes) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "input watcher control channel closed",
                ));
            }
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
            Err(error) => return Err(error),
        }
    }
}

fn poll_timeout_millis(deadline: Instant) -> libc::c_int {
    let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
        return 0;
    };
    if remaining.is_zero() {
        return 0;
    }
    let nanos = remaining.as_nanos();
    let rounded_up = nanos.saturating_add(999_999) / 1_000_000;
    rounded_up.min(libc::c_int::MAX as u128) as libc::c_int
}

#[cfg(test)]
mod tests {
    use std::os::fd::AsRawFd;
    use std::sync::mpsc;

    use super::*;

    const WAIT: Duration = Duration::from_millis(500);
    const QUIET: Duration = Duration::from_millis(60);

    #[test]
    fn readiness_is_coalesced_until_explicit_rearm() {
        let (mut writer, mut reader) = UnixStream::pair().unwrap();
        reader.set_nonblocking(true).unwrap();
        let (ready_tx, ready_rx) = mpsc::channel();
        let watcher = InputReadinessWatcher::new(
            reader.as_raw_fd(),
            None,
            Size::new(80, 24),
            move |reason| {
                ready_tx.send(reason).unwrap();
            },
        )
        .unwrap();

        watcher.rearm(InputReadinessArm::default()).unwrap();
        writer.write_all(b"a").unwrap();
        assert_eq!(ready_rx.recv_timeout(WAIT), Ok(InputReadyReason::Readable));

        writer.write_all(b"b").unwrap();
        assert!(ready_rx.recv_timeout(QUIET).is_err());
        let mut bytes = [0u8; 8];
        while reader.read(&mut bytes).is_ok() {}

        watcher.rearm(InputReadinessArm::default()).unwrap();
        writer.write_all(b"c").unwrap();
        assert_eq!(ready_rx.recv_timeout(WAIT), Ok(InputReadyReason::Readable));
        watcher.shutdown().unwrap();
    }

    #[test]
    fn latest_rearm_replaces_an_earlier_deadline() {
        let (_writer, reader) = UnixStream::pair().unwrap();
        let (ready_tx, ready_rx) = mpsc::channel();
        let watcher = InputReadinessWatcher::new(
            reader.as_raw_fd(),
            None,
            Size::new(80, 24),
            move |reason| {
                ready_tx.send(reason).unwrap();
            },
        )
        .unwrap();

        watcher
            .rearm(InputReadinessArm {
                escape_deadline: Some(Instant::now() + Duration::from_millis(20)),
                resize_heartbeat: None,
                confirmed_viewport: None,
            })
            .unwrap();
        watcher
            .rearm(InputReadinessArm {
                escape_deadline: Some(Instant::now() + Duration::from_millis(180)),
                resize_heartbeat: None,
                confirmed_viewport: None,
            })
            .unwrap();
        assert!(ready_rx.recv_timeout(QUIET).is_err());
        assert_eq!(
            ready_rx.recv_timeout(WAIT),
            Ok(InputReadyReason::EscapeDeadline)
        );
        watcher.shutdown().unwrap();
    }

    #[test]
    fn escape_deadline_fires_without_descriptor_readiness() {
        let (_writer, reader) = UnixStream::pair().unwrap();
        let (ready_tx, ready_rx) = mpsc::channel();
        let watcher = InputReadinessWatcher::new(
            reader.as_raw_fd(),
            None,
            Size::new(80, 24),
            move |reason| {
                ready_tx.send(reason).unwrap();
            },
        )
        .unwrap();

        watcher
            .rearm(InputReadinessArm {
                escape_deadline: Some(Instant::now() + Duration::from_millis(20)),
                resize_heartbeat: Some(Duration::from_millis(200)),
                confirmed_viewport: None,
            })
            .unwrap();
        assert_eq!(
            ready_rx.recv_timeout(WAIT),
            Ok(InputReadyReason::EscapeDeadline)
        );

        watcher.shutdown().unwrap();
    }

    #[test]
    fn resize_heartbeat_only_notifies_when_the_viewport_changes() {
        let (_input_writer, input_reader) = UnixStream::pair().unwrap();
        let (_master, slave) = open_pty(24, 80);
        let (ready_tx, ready_rx) = mpsc::channel();
        let watcher = InputReadinessWatcher::new(
            input_reader.as_raw_fd(),
            Some(slave.as_raw_fd()),
            Size::new(80, 24),
            move |reason| {
                ready_tx.send(reason).unwrap();
            },
        )
        .unwrap();
        watcher
            .rearm(InputReadinessArm {
                escape_deadline: None,
                resize_heartbeat: Some(Duration::from_millis(15)),
                confirmed_viewport: None,
            })
            .unwrap();

        assert!(ready_rx.recv_timeout(QUIET).is_err());
        set_pty_viewport(slave.as_raw_fd(), 40, 120);
        assert_eq!(
            ready_rx.recv_timeout(WAIT),
            Ok(InputReadyReason::ResizeHeartbeat)
        );
        watcher.shutdown().unwrap();
    }

    #[test]
    fn registration_window_resize_is_compared_to_the_confirmed_baseline() {
        let (_input_writer, input_reader) = UnixStream::pair().unwrap();
        let (_master, resize) = open_pty(40, 120);
        let (ready_tx, ready_rx) = mpsc::channel();
        // The runtime confirmed 80x24 before construction, while the resize fd
        // already reports 120x40. Construction must not adopt the latter as a
        // fresh baseline and lose this registration-window change.
        let watcher = InputReadinessWatcher::new(
            input_reader.as_raw_fd(),
            Some(resize.as_raw_fd()),
            Size::new(80, 24),
            move |reason| {
                ready_tx.send(reason).unwrap();
            },
        )
        .unwrap();
        watcher
            .rearm(InputReadinessArm {
                escape_deadline: None,
                resize_heartbeat: Some(Duration::from_millis(15)),
                confirmed_viewport: None,
            })
            .unwrap();

        assert_eq!(
            ready_rx.recv_timeout(WAIT),
            Ok(InputReadyReason::ResizeHeartbeat)
        );
        watcher.shutdown().unwrap();
    }

    #[test]
    fn shutdown_interrupts_an_indefinite_poll_without_callback() {
        let (_writer, reader) = UnixStream::pair().unwrap();
        let (ready_tx, ready_rx) = mpsc::channel();
        let watcher = InputReadinessWatcher::new(
            reader.as_raw_fd(),
            None,
            Size::new(80, 24),
            move |reason| {
                ready_tx.send(reason).unwrap();
            },
        )
        .unwrap();
        watcher.rearm(InputReadinessArm::default()).unwrap();

        let started = Instant::now();
        watcher.shutdown().unwrap();
        assert!(started.elapsed() < WAIT);
        assert!(ready_rx.try_recv().is_err());
    }

    #[test]
    fn shutdown_is_clean_after_the_input_descriptor_hangs_up() {
        let (writer, reader) = UnixStream::pair().unwrap();
        let (ready_tx, ready_rx) = mpsc::channel();
        let watcher = InputReadinessWatcher::new(
            reader.as_raw_fd(),
            None,
            Size::new(80, 24),
            move |reason| {
                ready_tx.send(reason).unwrap();
            },
        )
        .unwrap();
        watcher.rearm(InputReadinessArm::default()).unwrap();

        drop(writer);
        assert_eq!(
            ready_rx.recv_timeout(WAIT),
            Ok(InputReadyReason::InputClosed)
        );
        watcher.shutdown().unwrap();
    }

    fn open_pty(rows: u16, columns: u16) -> (OwnedFd, OwnedFd) {
        let mut master = -1;
        let mut slave = -1;
        let mut size = libc::winsize {
            ws_row: rows,
            ws_col: columns,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let result = unsafe {
            // SAFETY: all output pointers refer to initialized writable storage;
            // the returned descriptors are immediately wrapped as OwnedFd.
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            )
        };
        assert_eq!(result, 0, "openpty failed: {}", io::Error::last_os_error());
        let master = unsafe { OwnedFd::from_raw_fd(master) };
        let slave = unsafe { OwnedFd::from_raw_fd(slave) };
        (master, slave)
    }

    fn set_pty_viewport(fd: RawFd, rows: u16, columns: u16) {
        let size = libc::winsize {
            ws_row: rows,
            ws_col: columns,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let result = unsafe {
            // SAFETY: `size` is a fully initialized winsize borrowed only for
            // this ioctl call, and `fd` is the live slave side of the test pty.
            libc::ioctl(fd, libc::TIOCSWINSZ, &size)
        };
        assert_eq!(
            result,
            0,
            "TIOCSWINSZ failed: {}",
            io::Error::last_os_error()
        );
    }
}
