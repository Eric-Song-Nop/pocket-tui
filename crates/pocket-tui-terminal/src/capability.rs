//! Conservative terminal capability profile used by the MVP encoder.

/// Color encodings the terminal transition encoder may emit.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ColorCapability {
    /// Do not emit foreground or background color escapes.
    None,
    /// Emit only the portable ANSI 16-color palette.
    #[default]
    Ansi16,
    /// Emit indexed 256-color escapes.
    Ansi256,
    /// Emit 24-bit RGB color escapes.
    TrueColor,
}

/// Capabilities that are safe to use while encoding a terminal transition.
///
/// `conservative()` intentionally excludes synchronized updates, hyperlinks,
/// terminal scrolling, and graphics. Those features require active probing or
/// a versioned terminal profile and are outside the MVP.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalCapabilities {
    /// Highest color representation the encoder may use.
    pub color: ColorCapability,
    /// Whether CSI `K` (erase to end of line) is available.
    pub erase_in_line: bool,
}

impl TerminalCapabilities {
    /// Portable VT-style features used for a newly opened interactive TTY.
    #[must_use]
    pub const fn conservative() -> Self {
        Self {
            color: ColorCapability::Ansi16,
            erase_in_line: true,
        }
    }
}

impl Default for TerminalCapabilities {
    fn default() -> Self {
        Self::conservative()
    }
}
