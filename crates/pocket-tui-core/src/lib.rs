//! Terminal-independent scene, layout, and frame model for PocketTUI.
//!
//! The core deliberately contains no terminal protocol or JavaScript binding
//! code. Callers mutate a generational [`SceneDb`], then ask [`Runtime`] for a
//! self-contained [`FrameArtifact`] that a terminal backend or binding can
//! consume without borrowing the runtime.

mod cell;
mod dirty;
mod document;
mod geometry;
mod resources;
mod runtime;
mod scene;
mod screen;

pub use cell::{AuxId, Cell, CellError, GraphemeId, StyleId};
pub use dirty::{DirtyMask, DirtyReason, DirtyState};
pub use document::{
    Block, BlockId, BlockState, BlockSummary, DEFAULT_DOCUMENT_BYTE_BUDGET, Document, DocumentDb,
    DocumentError, DocumentId, DocumentStats, DocumentSummary, MaterializedLine,
};
pub use geometry::{Axis, Column, Insets, LayoutSpec, Length, Rect, Row, Size};
pub use resources::{
    Color, Grapheme, GraphemeStore, ResourceError, ResourceSnapshot, Style, StyleStore,
    TextAttributes,
};
pub use runtime::{FrameArtifact, FrameGeneration, Runtime, RuntimeError, RuntimeStats};
pub use scene::{BoxNode, Node, NodeId, NodeKind, SceneDb, SceneError, TextNode, TranscriptNode};
pub use screen::{
    DirtySpan, RowDamage, RowGeneration, RowSnapshot, Screen, ScreenError, ScreenRow,
    ScreenSnapshot,
};

/// Native runtime version exposed across the binding boundary.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
