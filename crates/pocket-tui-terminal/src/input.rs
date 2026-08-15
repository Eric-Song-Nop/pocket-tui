//! Bounded incremental decoding of the MVP terminal input protocol.

use std::io;
use std::os::fd::RawFd;
use std::time::{Duration, Instant};

use thiserror::Error;

const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";
const ESCAPE_TIMEOUT: Duration = Duration::from_millis(25);

/// Modifier keys attached to a key event.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct KeyModifiers(u8);

impl KeyModifiers {
    pub const NONE: Self = Self(0);
    pub const CTRL: Self = Self(1 << 0);
    pub const SHIFT: Self = Self(1 << 1);

    #[must_use]
    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }
}

/// Keys decoded by the conservative MVP parser.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KeyCode {
    Char(char),
    Tab,
    Enter,
    Backspace,
    Delete,
    Escape,
    Home,
    End,
    PageUp,
    PageDown,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    /// A complete escape sequence not yet modeled by the typed MVP parser.
    UnknownEscape,
}

const KEY_SEQUENCES: &[(&[u8], KeyCode, KeyModifiers)] = &[
    (b"\x1b[A", KeyCode::ArrowUp, KeyModifiers::NONE),
    (b"\x1b[B", KeyCode::ArrowDown, KeyModifiers::NONE),
    (b"\x1b[C", KeyCode::ArrowRight, KeyModifiers::NONE),
    (b"\x1b[D", KeyCode::ArrowLeft, KeyModifiers::NONE),
    (b"\x1bOA", KeyCode::ArrowUp, KeyModifiers::NONE),
    (b"\x1bOB", KeyCode::ArrowDown, KeyModifiers::NONE),
    (b"\x1bOC", KeyCode::ArrowRight, KeyModifiers::NONE),
    (b"\x1bOD", KeyCode::ArrowLeft, KeyModifiers::NONE),
    (b"\x1b[H", KeyCode::Home, KeyModifiers::NONE),
    (b"\x1bOH", KeyCode::Home, KeyModifiers::NONE),
    (b"\x1b[1~", KeyCode::Home, KeyModifiers::NONE),
    (b"\x1b[7~", KeyCode::Home, KeyModifiers::NONE),
    (b"\x1b[F", KeyCode::End, KeyModifiers::NONE),
    (b"\x1bOF", KeyCode::End, KeyModifiers::NONE),
    (b"\x1b[4~", KeyCode::End, KeyModifiers::NONE),
    (b"\x1b[8~", KeyCode::End, KeyModifiers::NONE),
    (b"\x1b[3~", KeyCode::Delete, KeyModifiers::NONE),
    (b"\x1b[5~", KeyCode::PageUp, KeyModifiers::NONE),
    (b"\x1b[6~", KeyCode::PageDown, KeyModifiers::NONE),
    (b"\x1b[Z", KeyCode::Tab, KeyModifiers::SHIFT),
];

/// One decoded key occurrence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct KeyEvent {
    pub code: KeyCode,
    pub modifiers: KeyModifiers,
}

/// Typed terminal input delivered to the runtime.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InputEvent {
    Text(String),
    Key(KeyEvent),
    PasteStart,
    PasteChunk(String),
    PasteEnd,
    /// Shape used by the event loop when SIGWINCH supplies new dimensions.
    Resize {
        columns: u16,
        rows: u16,
    },
}

/// Hard memory limits for incremental decoding.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InputLimits {
    /// Maximum undecoded bytes retained between calls.
    pub max_buffer_bytes: usize,
    /// Maximum UTF-8 payload in one paste event.
    pub paste_chunk_bytes: usize,
}

impl Default for InputLimits {
    fn default() -> Self {
        Self {
            max_buffer_bytes: 64 * 1024,
            paste_chunk_bytes: 16 * 1024,
        }
    }
}

/// Input decoding or file-descriptor failure.
#[derive(Debug, Error)]
pub enum InputError {
    #[error("terminal input I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("input limits must allow at least eight pending bytes and four paste bytes")]
    InvalidLimits,
    #[error("terminal input retained more than {limit} undecodable bytes")]
    BufferLimitExceeded { limit: usize },
}

/// Incremental, bounded parser for text, basic keys, and bracketed paste.
#[derive(Debug, Default)]
pub struct InputParser {
    limits: InputLimits,
    buffer: Vec<u8>,
    in_paste: bool,
}

impl InputParser {
    pub fn with_limits(limits: InputLimits) -> Result<Self, InputError> {
        if limits.max_buffer_bytes < 8 || limits.paste_chunk_bytes < 4 {
            return Err(InputError::InvalidLimits);
        }
        Ok(Self {
            limits,
            buffer: Vec::new(),
            in_paste: false,
        })
    }

    /// Decode all complete events in `bytes`, retaining incomplete UTF-8 or
    /// escape prefixes for the next call.
    pub fn feed(&mut self, mut bytes: &[u8]) -> Result<Vec<InputEvent>, InputError> {
        let mut events = Vec::new();
        while !bytes.is_empty() {
            if self.buffer.len() == self.limits.max_buffer_bytes {
                let before = self.buffer.len();
                self.parse_available(&mut events);
                if self.buffer.len() == before {
                    return Err(InputError::BufferLimitExceeded {
                        limit: self.limits.max_buffer_bytes,
                    });
                }
            }
            let room = self.limits.max_buffer_bytes - self.buffer.len();
            let take = room.min(bytes.len());
            self.buffer.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            self.parse_available(&mut events);
        }
        Ok(events)
    }

    /// Emit a standalone Escape after the caller's ambiguity timeout.
    pub fn flush_escape(&mut self) -> Vec<InputEvent> {
        let mut events = Vec::new();
        if !self.in_paste && self.buffer.first() == Some(&0x1b) {
            self.buffer.remove(0);
            events.push(key(KeyCode::Escape, KeyModifiers::NONE));
            self.parse_available(&mut events);
        }
        events
    }

    #[must_use]
    pub fn has_incomplete_escape(&self) -> bool {
        !self.in_paste && self.buffer.first() == Some(&0x1b)
    }

    #[must_use]
    pub fn pending_bytes(&self) -> usize {
        self.buffer.len()
    }

    fn parse_available(&mut self, events: &mut Vec<InputEvent>) {
        loop {
            if self.in_paste {
                if !self.parse_paste(events) {
                    return;
                }
                continue;
            }
            let Some(&first) = self.buffer.first() else {
                return;
            };
            match first {
                0x1b => {
                    if !self.parse_escape(events) {
                        return;
                    }
                }
                b'\r' | b'\n' => {
                    let consume =
                        usize::from(first == b'\r' && self.buffer.get(1).copied() == Some(b'\n'))
                            + 1;
                    self.buffer.drain(..consume);
                    events.push(key(KeyCode::Enter, KeyModifiers::NONE));
                }
                b'\t' => {
                    self.buffer.remove(0);
                    events.push(key(KeyCode::Tab, KeyModifiers::NONE));
                }
                0x08 | 0x7f => {
                    self.buffer.remove(0);
                    events.push(key(KeyCode::Backspace, KeyModifiers::NONE));
                }
                0x00..=0x1f => {
                    self.buffer.remove(0);
                    events.push(key(
                        KeyCode::Char(control_character(first)),
                        KeyModifiers::CTRL,
                    ));
                }
                _ => {
                    let end = self
                        .buffer
                        .iter()
                        .position(|byte| *byte < 0x20 || *byte == 0x7f)
                        .unwrap_or(self.buffer.len());
                    let complete = complete_utf8_prefix_len(&self.buffer[..end]);
                    if complete == 0 {
                        return;
                    }
                    let text = String::from_utf8_lossy(&self.buffer[..complete]).into_owned();
                    self.buffer.drain(..complete);
                    push_text(events, text);
                }
            }
        }
    }

    fn parse_escape(&mut self, events: &mut Vec<InputEvent>) -> bool {
        for &(sequence, code, modifiers) in KEY_SEQUENCES {
            if self.buffer.starts_with(sequence) {
                self.buffer.drain(..sequence.len());
                events.push(key(code, modifiers));
                return true;
            }
        }
        if self.buffer.starts_with(PASTE_START) {
            self.buffer.drain(..PASTE_START.len());
            self.in_paste = true;
            events.push(InputEvent::PasteStart);
            return true;
        }

        if KEY_SEQUENCES
            .iter()
            .any(|(sequence, _, _)| sequence.starts_with(&self.buffer))
            || PASTE_START.starts_with(&self.buffer)
        {
            return false;
        }

        // Consume complete CSI/SS3 sequences that this conservative parser
        // does not model yet. Treating their ESC prefix as a standalone Escape
        // would make modified arrows and function keys trigger app-level quit.
        if self.buffer.starts_with(b"\x1b[") || self.buffer.starts_with(b"\x1bO") {
            if let Some(end) = self.buffer[2..]
                .iter()
                .position(|byte| (0x40..=0x7e).contains(byte))
            {
                self.buffer.drain(..end + 3);
                events.push(key(KeyCode::UnknownEscape, KeyModifiers::NONE));
                return true;
            }
            return false;
        }

        // ESC followed immediately by a complete printable scalar is an Alt
        // chord in the conventional terminal protocol, not a standalone Escape
        // followed by text. Consume it as one currently-unmodeled sequence so
        // applications do not interpret Alt+W as quit and then move.
        if self.buffer.len() > 1 {
            let scalar_length = complete_utf8_scalar_len(&self.buffer[1..]);
            if scalar_length == 0 {
                return false;
            }
            self.buffer.drain(..scalar_length + 1);
            events.push(key(KeyCode::UnknownEscape, KeyModifiers::NONE));
            return true;
        }

        self.buffer.remove(0);
        events.push(key(KeyCode::Escape, KeyModifiers::NONE));
        true
    }

    fn parse_paste(&mut self, events: &mut Vec<InputEvent>) -> bool {
        if let Some(end) = find_subslice(&self.buffer, PASTE_END) {
            let payload = self.buffer[..end].to_vec();
            self.buffer.drain(..end + PASTE_END.len());
            emit_paste_chunks(events, &payload, self.limits.paste_chunk_bytes);
            events.push(InputEvent::PasteEnd);
            self.in_paste = false;
            return true;
        }

        let marker_prefix = longest_marker_prefix_suffix(&self.buffer, PASTE_END);
        let safe = self.buffer.len() - marker_prefix;
        let complete = complete_utf8_prefix_len(&self.buffer[..safe]);
        if complete == 0 {
            return false;
        }
        let payload: Vec<u8> = self.buffer.drain(..complete).collect();
        emit_paste_chunks(events, &payload, self.limits.paste_chunk_bytes);
        false
    }
}

/// Non-owning nonblocking reader for a terminal input descriptor.
#[derive(Debug)]
pub struct TerminalInput {
    fd: RawFd,
    original_flags: libc::c_int,
    parser: InputParser,
    escape_since: Option<Instant>,
    active: bool,
}

impl TerminalInput {
    pub fn open(fd: RawFd) -> Result<Self, InputError> {
        Self::with_limits(fd, InputLimits::default())
    }

    pub fn stdio() -> Result<Self, InputError> {
        Self::open(libc::STDIN_FILENO)
    }

    pub fn with_limits(fd: RawFd, limits: InputLimits) -> Result<Self, InputError> {
        let parser = InputParser::with_limits(limits)?;
        // SAFETY: fcntl only inspects or updates flags on the borrowed fd.
        let original_flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if original_flags < 0 {
            return Err(io::Error::last_os_error().into());
        }
        if unsafe { libc::fcntl(fd, libc::F_SETFL, original_flags | libc::O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error().into());
        }
        Ok(Self {
            fd,
            original_flags,
            parser,
            escape_since: None,
            active: true,
        })
    }

    /// Read until `EAGAIN` and return every complete typed event. This method
    /// cannot block because `open` installs `O_NONBLOCK`.
    pub fn read_available(&mut self) -> Result<Vec<InputEvent>, InputError> {
        self.read_available_at(Instant::now())
    }

    fn read_available_at(&mut self, now: Instant) -> Result<Vec<InputEvent>, InputError> {
        let mut events = Vec::new();
        // Preserve the ambiguity contract even if the owner thread was delayed:
        // bytes that arrived after an expired standalone Escape must not be
        // retroactively combined with it into a CSI or Alt sequence.
        if self
            .escape_since
            .is_some_and(|since| now.saturating_duration_since(since) >= ESCAPE_TIMEOUT)
        {
            events.extend(self.parser.flush_escape());
            self.escape_since = None;
        }

        let mut buffer = [0u8; 8192];
        loop {
            // SAFETY: `buffer` is valid writable storage and this object keeps
            // the borrowed descriptor active until restore/drop.
            let read = unsafe { libc::read(self.fd, buffer.as_mut_ptr().cast(), buffer.len()) };
            if read > 0 {
                events.extend(self.parser.feed(&buffer[..read as usize])?);
                continue;
            }
            if read == 0 {
                break;
            }
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            if error.kind() == io::ErrorKind::WouldBlock {
                break;
            }
            return Err(error.into());
        }

        if self.parser.has_incomplete_escape() {
            self.escape_since.get_or_insert(now);
        } else {
            self.escape_since = None;
        }
        Ok(events)
    }

    /// Absolute time at which an ambiguous leading Escape should be flushed.
    #[must_use]
    pub fn escape_deadline(&self) -> Option<Instant> {
        self.escape_since
            .and_then(|since| since.checked_add(ESCAPE_TIMEOUT))
    }

    #[must_use]
    pub const fn input_fd(&self) -> RawFd {
        self.fd
    }

    pub fn restore(&mut self) -> io::Result<()> {
        if !self.active {
            return Ok(());
        }
        // SAFETY: restores the flags captured from this borrowed fd.
        if unsafe { libc::fcntl(self.fd, libc::F_SETFL, self.original_flags) } < 0 {
            return Err(io::Error::last_os_error());
        }
        self.active = false;
        Ok(())
    }
}

impl Drop for TerminalInput {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

fn key(code: KeyCode, modifiers: KeyModifiers) -> InputEvent {
    InputEvent::Key(KeyEvent { code, modifiers })
}

fn control_character(byte: u8) -> char {
    match byte {
        0 => ' ',
        1..=26 => char::from(b'a' + byte - 1),
        28 => '\\',
        29 => ']',
        30 => '^',
        31 => '_',
        _ => char::REPLACEMENT_CHARACTER,
    }
}

fn push_text(events: &mut Vec<InputEvent>, text: String) {
    if text.is_empty() {
        return;
    }
    if let Some(InputEvent::Text(previous)) = events.last_mut() {
        previous.push_str(&text);
    } else {
        events.push(InputEvent::Text(text));
    }
}

fn complete_utf8_prefix_len(bytes: &[u8]) -> usize {
    let mut index = 0;
    while index < bytes.len() {
        let width = match bytes[index] {
            0x00..=0x7f => 1,
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => 1,
        };
        if index + width > bytes.len() {
            break;
        }
        if width > 1 && std::str::from_utf8(&bytes[index..index + width]).is_err() {
            index += 1;
        } else {
            index += width;
        }
    }
    index
}

fn complete_utf8_scalar_len(bytes: &[u8]) -> usize {
    let Some(&first) = bytes.first() else {
        return 0;
    };
    let width = match first {
        0x20..=0x7e => 1,
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => 1,
    };
    if bytes.len() < width {
        return 0;
    }
    if width > 1 && std::str::from_utf8(&bytes[..width]).is_err() {
        1
    } else {
        width
    }
}

fn emit_paste_chunks(events: &mut Vec<InputEvent>, bytes: &[u8], limit: usize) {
    let mut remaining = bytes;
    while !remaining.is_empty() {
        let mut end = remaining.len().min(limit);
        while end > 0 && std::str::from_utf8(&remaining[..end]).is_err() {
            end -= 1;
        }
        if end == 0 {
            end = complete_utf8_prefix_len(remaining)
                .max(1)
                .min(remaining.len());
        }
        events.push(InputEvent::PasteChunk(
            String::from_utf8_lossy(&remaining[..end]).into_owned(),
        ));
        remaining = &remaining[end..];
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn longest_marker_prefix_suffix(bytes: &[u8], marker: &[u8]) -> usize {
    (1..marker.len())
        .rev()
        .find(|length| bytes.ends_with(&marker[..*length]))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;

    use super::*;

    #[test]
    fn preserves_split_utf8_and_escape_sequences() {
        let mut parser = InputParser::default();
        assert!(parser.feed(&[0xe7, 0x95]).unwrap().is_empty());

        let events = parser.feed(&[0x8c, 0x1b, b'[']).unwrap();
        assert_eq!(events, vec![InputEvent::Text("界".into())]);
        let events = parser.feed(b"A\r\x7f\x03").unwrap();
        assert_eq!(
            events,
            vec![
                key(KeyCode::ArrowUp, KeyModifiers::NONE),
                key(KeyCode::Enter, KeyModifiers::NONE),
                key(KeyCode::Backspace, KeyModifiers::NONE),
                key(KeyCode::Char('c'), KeyModifiers::CTRL),
            ]
        );
    }

    #[test]
    fn modified_arrow_is_not_misreported_as_standalone_escape() {
        let mut parser = InputParser::default();
        assert_eq!(
            parser.feed(b"\x1b[1;2A").unwrap(),
            vec![key(KeyCode::UnknownEscape, KeyModifiers::NONE)]
        );
    }

    #[test]
    fn decodes_common_navigation_editing_and_focus_sequences_across_boundaries() {
        let cases: &[(&[u8], KeyCode, KeyModifiers)] = &[
            (b"\t", KeyCode::Tab, KeyModifiers::NONE),
            (b"\x1b[Z", KeyCode::Tab, KeyModifiers::SHIFT),
            (b"\x1b[H", KeyCode::Home, KeyModifiers::NONE),
            (b"\x1bOH", KeyCode::Home, KeyModifiers::NONE),
            (b"\x1b[1~", KeyCode::Home, KeyModifiers::NONE),
            (b"\x1b[7~", KeyCode::Home, KeyModifiers::NONE),
            (b"\x1b[F", KeyCode::End, KeyModifiers::NONE),
            (b"\x1bOF", KeyCode::End, KeyModifiers::NONE),
            (b"\x1b[4~", KeyCode::End, KeyModifiers::NONE),
            (b"\x1b[8~", KeyCode::End, KeyModifiers::NONE),
            (b"\x1b[3~", KeyCode::Delete, KeyModifiers::NONE),
            (b"\x1b[5~", KeyCode::PageUp, KeyModifiers::NONE),
            (b"\x1b[6~", KeyCode::PageDown, KeyModifiers::NONE),
            (b"\x1bOA", KeyCode::ArrowUp, KeyModifiers::NONE),
            (b"\x1bOB", KeyCode::ArrowDown, KeyModifiers::NONE),
            (b"\x1bOC", KeyCode::ArrowRight, KeyModifiers::NONE),
            (b"\x1bOD", KeyCode::ArrowLeft, KeyModifiers::NONE),
        ];

        for &(sequence, code, modifiers) in cases {
            let mut parser = InputParser::default();
            let mut events = Vec::new();
            for byte in sequence {
                events.extend(parser.feed(&[*byte]).unwrap());
            }
            assert_eq!(
                events,
                vec![key(code, modifiers)],
                "failed to decode {sequence:?}"
            );
            assert_eq!(parser.pending_bytes(), 0);
        }
    }

    #[test]
    fn alt_printable_is_one_unknown_sequence_not_escape_plus_text() {
        let mut parser = InputParser::default();
        assert_eq!(
            parser.feed(b"\x1bw").unwrap(),
            vec![key(KeyCode::UnknownEscape, KeyModifiers::NONE)]
        );

        let mut split = InputParser::default();
        assert!(split.feed(b"\x1b\xc3").unwrap().is_empty());
        assert_eq!(
            split.feed(b"\xa9").unwrap(),
            vec![key(KeyCode::UnknownEscape, KeyModifiers::NONE)]
        );
    }

    #[test]
    fn streams_bracketed_paste_across_boundaries() {
        let mut parser = InputParser::with_limits(InputLimits {
            max_buffer_bytes: 16,
            paste_chunk_bytes: 4,
        })
        .unwrap();
        assert_eq!(parser.feed(b"\x1b[20").unwrap(), Vec::new());
        assert_eq!(
            parser.feed(b"0~hello\xe4\xb8").unwrap(),
            vec![
                InputEvent::PasteStart,
                InputEvent::PasteChunk("hell".into()),
                InputEvent::PasteChunk("o".into()),
            ]
        );
        assert_eq!(
            parser.feed(b"\x96\x1b[201~").unwrap(),
            vec![InputEvent::PasteChunk("世".into()), InputEvent::PasteEnd,]
        );
    }

    #[test]
    fn overdue_escape_is_flushed_before_newly_available_bytes_are_read() {
        let (mut writer, reader) = UnixStream::pair().unwrap();
        let mut input = TerminalInput::open(reader.as_raw_fd()).unwrap();
        let started = Instant::now();

        writer.write_all(b"\x1b").unwrap();
        assert!(input.read_available_at(started).unwrap().is_empty());
        let deadline = input.escape_deadline().unwrap();

        writer.write_all(b"[A").unwrap();
        assert_eq!(
            input.read_available_at(deadline).unwrap(),
            vec![
                key(KeyCode::Escape, KeyModifiers::NONE),
                InputEvent::Text("[A".into()),
            ]
        );
    }
}
