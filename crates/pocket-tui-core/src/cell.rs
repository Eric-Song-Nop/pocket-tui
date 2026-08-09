//! Pointer-free cells and compact resource identifiers.

use thiserror::Error;

/// Stable index into a frame's grapheme catalog. ID zero is a blank space.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
#[repr(transparent)]
pub struct GraphemeId(pub u32);

impl GraphemeId {
    pub const SPACE: Self = Self(0);
}

/// Stable index into a frame's style catalog. ID zero is the default style.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
#[repr(transparent)]
pub struct StyleId(pub u32);

impl StyleId {
    pub const DEFAULT: Self = Self(0);
}

/// Optional compact annotation (hit target, link, or image placement).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
#[repr(transparent)]
pub struct AuxId(pub u32);

const CONTINUATION: u32 = 1 << 31;
const PAYLOAD_MASK: u32 = u8::MAX as u32;

/// One pointer-free terminal cell.
///
/// A lead cell stores a non-zero display width in the low byte of `meta`.
/// Continuation cells store their distance back to the lead and set bit 31.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(C)]
pub struct Cell {
    grapheme: GraphemeId,
    style: StyleId,
    aux: AuxId,
    meta: u32,
}

const _: [(); 16] = [(); core::mem::size_of::<Cell>()];

impl Default for Cell {
    fn default() -> Self {
        Self::blank(StyleId::DEFAULT)
    }
}

impl Cell {
    /// A one-column blank with the requested style.
    pub const fn blank(style: StyleId) -> Self {
        Self {
            grapheme: GraphemeId::SPACE,
            style,
            aux: AuxId(0),
            meta: 1,
        }
    }

    /// Creates a grapheme lead cell.
    pub fn lead(
        grapheme: GraphemeId,
        style: StyleId,
        aux: AuxId,
        width: u8,
    ) -> Result<Self, CellError> {
        if width == 0 {
            return Err(CellError::ZeroWidthLead);
        }
        Ok(Self {
            grapheme,
            style,
            aux,
            meta: width as u32,
        })
    }

    /// Creates a continuation cell owned by `lead`.
    pub fn continuation(lead: Self, lead_offset: u8) -> Result<Self, CellError> {
        if lead.is_continuation() || lead_offset == 0 || lead_offset >= lead.display_width() {
            return Err(CellError::InvalidContinuation);
        }
        Ok(Self {
            grapheme: lead.grapheme,
            style: lead.style,
            aux: lead.aux,
            meta: CONTINUATION | lead_offset as u32,
        })
    }

    pub const fn grapheme(self) -> GraphemeId {
        self.grapheme
    }

    pub const fn style(self) -> StyleId {
        self.style
    }

    pub const fn aux(self) -> AuxId {
        self.aux
    }

    pub const fn is_continuation(self) -> bool {
        self.meta & CONTINUATION != 0
    }

    pub const fn is_lead(self) -> bool {
        !self.is_continuation()
    }

    /// Display width for a lead, or zero for a continuation.
    pub const fn display_width(self) -> u8 {
        if self.is_continuation() {
            0
        } else {
            (self.meta & PAYLOAD_MASK) as u8
        }
    }

    /// Distance back to the owning lead, or zero for a lead.
    pub const fn lead_offset(self) -> u8 {
        if self.is_continuation() {
            (self.meta & PAYLOAD_MASK) as u8
        } else {
            0
        }
    }
}

/// Invalid cell construction.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum CellError {
    #[error("a lead cell must occupy at least one column")]
    ZeroWidthLead,
    #[error("a continuation must point inside a lead grapheme")]
    InvalidContinuation,
}
