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

/// Optional terminal-specific transport for post-processing shader state.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum EffectBusCapability {
    #[default]
    None,
    /// Ghostty 1.3 palette uniforms backed by reserved OSC 4 slots 240-243.
    GhosttyPaletteV1,
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
    /// Negotiated post-processing state transport.
    pub effect_bus: EffectBusCapability,
}

impl TerminalCapabilities {
    /// Portable VT-style features used for a newly opened interactive TTY.
    #[must_use]
    pub const fn conservative() -> Self {
        Self {
            color: ColorCapability::Ansi16,
            erase_in_line: true,
            effect_bus: EffectBusCapability::None,
        }
    }

    /// Widely supported 24-bit color profile for modern interactive terminals.
    /// This remains an explicit profile rather than a claim of active probing.
    #[must_use]
    pub const fn rich() -> Self {
        Self {
            color: ColorCapability::TrueColor,
            erase_in_line: true,
            effect_bus: EffectBusCapability::None,
        }
    }

    /// Ghostty 1.3 profile with true color and the reserved palette effect bus.
    #[must_use]
    pub const fn ghostty() -> Self {
        Self {
            color: ColorCapability::TrueColor,
            erase_in_line: true,
            effect_bus: EffectBusCapability::GhosttyPaletteV1,
        }
    }
}

impl Default for TerminalCapabilities {
    fn default() -> Self {
        Self::conservative()
    }
}
