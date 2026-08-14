//! Physical terminal state tracked across output transactions.

use std::sync::Arc;

use pocket_tui_core::Color;

/// Steady DEC cursor presentation used by the terminal and shader anchor.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CursorShape {
    #[default]
    Block,
    Underline,
    Bar,
}

/// Cursor state predicted after the last completely written patch.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CursorState {
    /// Zero-based terminal row.
    pub row: u16,
    /// Zero-based terminal column.
    pub column: u16,
    /// Whether the cursor is visible.
    pub visible: bool,
    /// Requested steady cursor shape.
    pub shape: CursorShape,
    /// Desired cursor color; `Default` restores the terminal theme.
    pub color: Color,
}

/// Opaque state carried to an optional terminal post-processing shader.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct EffectBusState {
    /// Whether the profile signature and channels should be installed.
    pub enabled: bool,
    /// Three application-defined RGB-byte channels.
    pub channels: [[u8; 3]; 3],
    /// Alternates the nearly-identical cursor shade used as an event timestamp.
    pub cursor_shade: bool,
}

/// Terminal state that is safe to use as a diff baseline.
///
/// The private screen is shared with an in-flight target and replaced only
/// after all encoded bytes have been accepted by the output transport.
#[derive(Clone, Debug)]
pub struct PhysicalState {
    generation: u64,
    screen: Option<Arc<ScreenModel>>,
    cursor: CursorState,
    effect_bus: EffectBusState,
}

impl PhysicalState {
    pub(crate) fn empty() -> Self {
        Self {
            generation: 0,
            screen: None,
            cursor: CursorState {
                row: 0,
                column: 0,
                visible: false,
                shape: CursorShape::Block,
                color: Color::Default,
            },
            effect_bus: EffectBusState::default(),
        }
    }

    pub(crate) fn for_screen(
        screen: Arc<ScreenModel>,
        cursor: CursorState,
        effect_bus: EffectBusState,
    ) -> Self {
        Self {
            generation: screen.generation,
            screen: Some(screen),
            cursor,
            effect_bus,
        }
    }

    /// Last frame generation whose complete patch was accepted by the output
    /// stream. A short or blocked write never changes this number.
    #[must_use]
    pub const fn generation(&self) -> u64 {
        self.generation
    }

    /// Confirmed terminal dimensions, or `None` before the first full repaint.
    #[must_use]
    pub fn dimensions(&self) -> Option<(u16, u16)> {
        self.screen
            .as_ref()
            .map(|screen| (screen.columns, screen.rows.len() as u16))
    }

    /// Predicted cursor state after the confirmed patch.
    #[must_use]
    pub const fn cursor(&self) -> CursorState {
        self.cursor
    }

    /// Confirmed effect-bus state after the last complete transition.
    #[must_use]
    pub const fn effect_bus(&self) -> EffectBusState {
        self.effect_bus
    }

    pub(crate) fn screen(&self) -> Option<&ScreenModel> {
        self.screen.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ScreenModel {
    pub(crate) generation: u64,
    pub(crate) columns: u16,
    pub(crate) rows: Vec<Vec<PaintCell>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PaintCell {
    pub(crate) text: Arc<str>,
    pub(crate) width: u8,
    pub(crate) lead_offset: u8,
    pub(crate) style: PaintStyle,
}

impl PaintCell {
    pub(crate) fn is_default_blank(&self) -> bool {
        self.width == 1 && self.text.as_ref() == " " && self.style == PaintStyle::default()
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct PaintStyle {
    pub(crate) foreground: PaintColor,
    pub(crate) background: PaintColor,
    pub(crate) bold: bool,
    pub(crate) dim: bool,
    pub(crate) italic: bool,
    pub(crate) underline: bool,
    pub(crate) blink: bool,
    pub(crate) inverse: bool,
    pub(crate) hidden: bool,
    pub(crate) strikethrough: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum PaintColor {
    #[default]
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}
