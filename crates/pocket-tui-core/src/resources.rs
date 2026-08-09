//! Append-only grapheme/style catalogs used by pointer-free cells.

use std::{collections::HashMap, sync::Arc};

use bitflags::bitflags;
use thiserror::Error;
use unicode_width::UnicodeWidthStr;

use crate::{GraphemeId, StyleId};

/// A terminal color independent of any specific output protocol.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Color {
    #[default]
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

bitflags! {
    /// Common SGR-like text attributes.
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
    pub struct TextAttributes: u16 {
        const BOLD = 1 << 0;
        const DIM = 1 << 1;
        const ITALIC = 1 << 2;
        const UNDERLINE = 1 << 3;
        const BLINK = 1 << 4;
        const REVERSE = 1 << 5;
        const HIDDEN = 1 << 6;
        const STRIKE = 1 << 7;
    }
}

/// Canonical visual style interned by [`StyleStore`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Style {
    pub foreground: Color,
    pub background: Color,
    pub attributes: TextAttributes,
}

/// Immutable grapheme record referenced by a [`crate::Cell`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grapheme {
    text: Arc<str>,
    width: u8,
}

impl Grapheme {
    /// UTF-8 extended grapheme cluster.
    pub fn as_str(&self) -> &str {
        &self.text
    }

    /// Normalized terminal width (always at least one).
    pub const fn width(&self) -> u8 {
        self.width
    }
}

/// Append-only, deduplicating grapheme catalog.
#[derive(Clone, Debug)]
pub struct GraphemeStore {
    entries: Vec<Grapheme>,
    by_text: HashMap<Arc<str>, GraphemeId>,
}

impl Default for GraphemeStore {
    fn default() -> Self {
        let space: Arc<str> = Arc::from(" ");
        let mut by_text = HashMap::new();
        by_text.insert(space.clone(), GraphemeId::SPACE);
        Self {
            entries: vec![Grapheme {
                text: space,
                width: 1,
            }],
            by_text,
        }
    }
}

impl GraphemeStore {
    /// Interns one already-segmented extended grapheme cluster.
    pub fn intern(&mut self, text: &str) -> Result<GraphemeId, ResourceError> {
        if text.is_empty() {
            return Err(ResourceError::EmptyGrapheme);
        }
        if let Some(id) = self.by_text.get(text) {
            return Ok(*id);
        }

        // A standalone combining cluster has width zero. Giving it one cell is
        // deterministic and preserves the lead/continuation invariant.
        let width = UnicodeWidthStr::width(text).max(1);
        let width = u8::try_from(width).map_err(|_| ResourceError::GraphemeTooWide(width))?;
        let raw_id = u32::try_from(self.entries.len()).map_err(|_| ResourceError::CatalogFull)?;
        let id = GraphemeId(raw_id);
        let text: Arc<str> = Arc::from(text);
        self.entries.push(Grapheme {
            text: text.clone(),
            width,
        });
        self.by_text.insert(text, id);
        Ok(id)
    }

    /// Resolves a grapheme ID.
    pub fn get(&self, id: GraphemeId) -> Option<&Grapheme> {
        self.entries.get(id.0 as usize)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub(crate) fn memory_bytes(&self) -> usize {
        self.entries.capacity() * core::mem::size_of::<Grapheme>()
            + self
                .entries
                .iter()
                .map(|entry| entry.text.len())
                .sum::<usize>()
    }
}

/// Append-only, deduplicating style catalog.
#[derive(Clone, Debug)]
pub struct StyleStore {
    entries: Vec<Style>,
    by_style: HashMap<Style, StyleId>,
}

impl Default for StyleStore {
    fn default() -> Self {
        let style = Style::default();
        let mut by_style = HashMap::new();
        by_style.insert(style, StyleId::DEFAULT);
        Self {
            entries: vec![style],
            by_style,
        }
    }
}

impl StyleStore {
    /// Interns and returns a compact style ID.
    pub fn intern(&mut self, style: Style) -> Result<StyleId, ResourceError> {
        if let Some(id) = self.by_style.get(&style) {
            return Ok(*id);
        }
        let raw_id = u32::try_from(self.entries.len()).map_err(|_| ResourceError::CatalogFull)?;
        let id = StyleId(raw_id);
        self.entries.push(style);
        self.by_style.insert(style, id);
        Ok(id)
    }

    /// Resolves a style ID.
    pub fn get(&self, id: StyleId) -> Option<&Style> {
        self.entries.get(id.0 as usize)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub(crate) fn memory_bytes(&self) -> usize {
        self.entries.capacity() * core::mem::size_of::<Style>()
    }
}

/// Immutable resource catalogs attached to a frame artifact.
#[derive(Clone, Debug)]
pub struct ResourceSnapshot {
    graphemes: Arc<[Grapheme]>,
    styles: Arc<[Style]>,
}

impl ResourceSnapshot {
    pub(crate) fn new(graphemes: &GraphemeStore, styles: &StyleStore) -> Self {
        Self {
            graphemes: Arc::from(graphemes.entries.clone()),
            styles: Arc::from(styles.entries.clone()),
        }
    }

    /// Resolves a grapheme ID to UTF-8 and cached width.
    pub fn grapheme(&self, id: GraphemeId) -> Option<&Grapheme> {
        self.graphemes.get(id.0 as usize)
    }

    /// Resolves a style ID.
    pub fn style(&self, id: StyleId) -> Option<&Style> {
        self.styles.get(id.0 as usize)
    }

    /// All graphemes in ID order.
    pub fn graphemes(&self) -> &[Grapheme] {
        &self.graphemes
    }

    /// All styles in ID order.
    pub fn styles(&self) -> &[Style] {
        &self.styles
    }
}

/// Resource catalog failure.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum ResourceError {
    #[error("an empty string is not a grapheme")]
    EmptyGrapheme,
    #[error("grapheme width {0} exceeds the cell representation")]
    GraphemeTooWide(usize),
    #[error("resource catalog exhausted its 32-bit ID space")]
    CatalogFull,
}
