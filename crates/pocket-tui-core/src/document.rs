//! Bounded append-only documents for virtual transcripts.

use thiserror::Error;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

/// Default aggregate UTF-8 budget for all documents in a runtime.
pub const DEFAULT_DOCUMENT_BYTE_BUDGET: usize = 64 * 1024 * 1024;

macro_rules! generational_id {
    ($name:ident) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        #[repr(transparent)]
        pub struct $name(u64);

        impl $name {
            const fn new(index: u32, generation: u32) -> Self {
                Self(((generation as u64) << 32) | index as u64)
            }

            pub const fn from_raw(raw: u64) -> Option<Self> {
                if raw >> 32 == 0 {
                    None
                } else {
                    Some(Self(raw))
                }
            }

            pub const fn raw(self) -> u64 {
                self.0
            }
            pub const fn index(self) -> u32 {
                self.0 as u32
            }
            pub const fn generation(self) -> u32 {
                (self.0 >> 32) as u32
            }
        }
    };
}

generational_id!(DocumentId);
generational_id!(BlockId);

/// Lifecycle of a transcript block.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BlockState {
    Open,
    Sealed,
}

/// Per-block leaf weight ready to be aggregated by a later height index.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BlockSummary {
    pub utf8_bytes: usize,
    pub logical_lines: u32,
    pub estimated_rows: u32,
    pub line_height: u16,
}

/// Aggregate document weight; no Scene nodes are created for these blocks.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DocumentSummary {
    pub block_count: u32,
    pub sealed_blocks: u32,
    pub utf8_bytes: usize,
    pub estimated_rows: u64,
}

/// One document containing stable ordered block handles.
#[derive(Clone, Debug)]
pub struct Document {
    blocks: Vec<BlockId>,
    open_block: Option<BlockId>,
    summary: DocumentSummary,
}

impl Document {
    pub fn blocks(&self) -> &[BlockId] {
        &self.blocks
    }
    pub const fn open_block(&self) -> Option<BlockId> {
        self.open_block
    }
    pub const fn summary(&self) -> DocumentSummary {
        self.summary
    }
}

/// Stable UTF-8 owned by the native document store.
#[derive(Clone, Debug)]
pub struct Block {
    document: DocumentId,
    state: BlockState,
    text: String,
    line_starts: Vec<usize>,
    summary: BlockSummary,
}

impl Block {
    pub const fn document(&self) -> DocumentId {
        self.document
    }
    pub const fn state(&self) -> BlockState {
        self.state
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    pub const fn summary(&self) -> BlockSummary {
        self.summary
    }

    fn line(&self, index: usize) -> &str {
        let start = self.line_starts[index];
        let end = self
            .line_starts
            .get(index + 1)
            .copied()
            .map_or(self.text.len(), |next| next.saturating_sub(1));
        &self.text[start..end]
    }
}

#[derive(Clone, Debug)]
struct DocumentSlot {
    generation: u32,
    value: Document,
}

#[derive(Clone, Debug)]
struct BlockSlot {
    generation: u32,
    value: Block,
}

/// One visible logical line materialized from the newest document tail.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MaterializedLine {
    pub block: Option<BlockId>,
    pub text: String,
}

/// Aggregate storage counters.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DocumentStats {
    pub documents: usize,
    pub blocks: usize,
    pub open_blocks: usize,
    pub text_bytes: usize,
    pub hard_byte_budget: usize,
    pub estimated_rows: u64,
}

/// Generational, byte-bounded document database.
#[derive(Clone, Debug)]
pub struct DocumentDb {
    documents: Vec<DocumentSlot>,
    blocks: Vec<BlockSlot>,
    text_bytes: usize,
    hard_byte_budget: usize,
}

impl Default for DocumentDb {
    fn default() -> Self {
        Self::new(DEFAULT_DOCUMENT_BYTE_BUDGET)
    }
}

impl DocumentDb {
    pub fn new(hard_byte_budget: usize) -> Self {
        Self {
            documents: Vec::new(),
            blocks: Vec::new(),
            text_bytes: 0,
            hard_byte_budget,
        }
    }

    pub fn create_document(&mut self) -> Result<DocumentId, DocumentError> {
        let index = u32::try_from(self.documents.len()).map_err(|_| DocumentError::Capacity)?;
        let id = DocumentId::new(index, 1);
        self.documents.push(DocumentSlot {
            generation: 1,
            value: Document {
                blocks: Vec::new(),
                open_block: None,
                summary: DocumentSummary::default(),
            },
        });
        Ok(id)
    }

    pub fn open_block(&mut self, document: DocumentId) -> Result<BlockId, DocumentError> {
        if self.document(document)?.open_block.is_some() {
            return Err(DocumentError::OpenBlockExists(document));
        }
        let index = u32::try_from(self.blocks.len()).map_err(|_| DocumentError::Capacity)?;
        let id = BlockId::new(index, 1);
        self.blocks.push(BlockSlot {
            generation: 1,
            value: Block {
                document,
                state: BlockState::Open,
                text: String::new(),
                line_starts: vec![0],
                summary: BlockSummary {
                    logical_lines: 1,
                    estimated_rows: 1,
                    line_height: 1,
                    ..BlockSummary::default()
                },
            },
        });
        let value = self.document_mut(document)?;
        value.blocks.push(id);
        value.open_block = Some(id);
        value.summary.block_count = value.summary.block_count.saturating_add(1);
        value.summary.estimated_rows = value.summary.estimated_rows.saturating_add(1);
        Ok(id)
    }

    /// Appends only to the addressed open block. Other history is untouched.
    pub fn append_text(&mut self, block: BlockId, text: &str) -> Result<(), DocumentError> {
        if text.is_empty() {
            return Ok(());
        }
        let (document, state) = {
            let block = self.block(block)?;
            (block.document, block.state)
        };
        if state != BlockState::Open {
            return Err(DocumentError::BlockSealed(block));
        }
        let next_bytes =
            self.text_bytes
                .checked_add(text.len())
                .ok_or(DocumentError::BudgetExceeded {
                    used: self.text_bytes,
                    requested: text.len(),
                    limit: self.hard_byte_budget,
                })?;
        if next_bytes > self.hard_byte_budget {
            return Err(DocumentError::BudgetExceeded {
                used: self.text_bytes,
                requested: text.len(),
                limit: self.hard_byte_budget,
            });
        }
        let newline_count = text.bytes().filter(|byte| *byte == b'\n').count();
        let old_len;
        {
            let value = self.block_mut(block)?;
            value
                .text
                .try_reserve(text.len())
                .map_err(|_| DocumentError::Allocation)?;
            value
                .line_starts
                .try_reserve(newline_count)
                .map_err(|_| DocumentError::Allocation)?;
            old_len = value.text.len();
            for (offset, _) in text.match_indices('\n') {
                value.line_starts.push(old_len + offset + 1);
            }
            value.text.push_str(text);
            value.summary.utf8_bytes = value.text.len();
            value.summary.logical_lines = value.line_starts.len().min(u32::MAX as usize) as u32;
            value.summary.estimated_rows = value.summary.logical_lines;
        }
        self.text_bytes = next_bytes;
        let value = self.document_mut(document)?;
        value.summary.utf8_bytes = value.summary.utf8_bytes.saturating_add(text.len());
        value.summary.estimated_rows = value
            .summary
            .estimated_rows
            .saturating_add(newline_count as u64);
        Ok(())
    }

    pub fn seal_block(&mut self, block: BlockId) -> Result<(), DocumentError> {
        let document = self.block(block)?.document;
        if self.block(block)?.state == BlockState::Sealed {
            return Err(DocumentError::BlockSealed(block));
        }
        if self.document(document)?.open_block != Some(block) {
            return Err(DocumentError::NotDocumentOpenBlock(block));
        }
        self.block_mut(block)?.state = BlockState::Sealed;
        let value = self.document_mut(document)?;
        value.open_block = None;
        value.summary.sealed_blocks = value.summary.sealed_blocks.saturating_add(1);
        Ok(())
    }

    pub fn document(&self, id: DocumentId) -> Result<&Document, DocumentError> {
        let slot = self
            .documents
            .get(id.index() as usize)
            .ok_or(DocumentError::StaleDocument(id))?;
        if slot.generation != id.generation() {
            return Err(DocumentError::StaleDocument(id));
        }
        Ok(&slot.value)
    }

    pub fn block(&self, id: BlockId) -> Result<&Block, DocumentError> {
        let slot = self
            .blocks
            .get(id.index() as usize)
            .ok_or(DocumentError::StaleBlock(id))?;
        if slot.generation != id.generation() {
            return Err(DocumentError::StaleBlock(id));
        }
        Ok(&slot.value)
    }

    /// Walks block and line indexes backwards and stops after `max_lines`.
    pub fn materialize_tail(
        &self,
        document: DocumentId,
        width: u16,
        max_lines: u16,
        block_gap: u16,
    ) -> Result<Vec<MaterializedLine>, DocumentError> {
        if width == 0 || max_lines == 0 {
            return Ok(Vec::new());
        }
        let document = self.document(document)?;
        let mut reverse = Vec::with_capacity(max_lines as usize);
        for (block_index, block_id) in document.blocks.iter().copied().rev().enumerate() {
            let block = self.block(block_id)?;
            for line_index in (0..block.line_starts.len()).rev() {
                if reverse.len() == max_lines as usize {
                    break;
                }
                reverse.push(MaterializedLine {
                    block: Some(block_id),
                    text: tail_by_width(block.line(line_index), width),
                });
            }
            if reverse.len() == max_lines as usize {
                break;
            }
            if block_index + 1 < document.blocks.len() {
                for _ in 0..block_gap {
                    if reverse.len() == max_lines as usize {
                        break;
                    }
                    reverse.push(MaterializedLine {
                        block: None,
                        text: String::new(),
                    });
                }
            }
        }
        reverse.reverse();
        Ok(reverse)
    }

    pub fn stats(&self) -> DocumentStats {
        DocumentStats {
            documents: self.documents.len(),
            blocks: self.blocks.len(),
            open_blocks: self
                .documents
                .iter()
                .filter(|slot| slot.value.open_block.is_some())
                .count(),
            text_bytes: self.text_bytes,
            hard_byte_budget: self.hard_byte_budget,
            estimated_rows: self
                .documents
                .iter()
                .map(|slot| slot.value.summary.estimated_rows)
                .sum(),
        }
    }

    pub const fn text_bytes(&self) -> usize {
        self.text_bytes
    }
    pub const fn hard_byte_budget(&self) -> usize {
        self.hard_byte_budget
    }

    pub fn memory_bytes(&self) -> usize {
        self.blocks
            .iter()
            .map(|slot| {
                slot.value.text.capacity()
                    + slot.value.line_starts.capacity() * core::mem::size_of::<usize>()
            })
            .sum::<usize>()
            .saturating_add(
                self.documents
                    .iter()
                    .map(|slot| slot.value.blocks.capacity() * core::mem::size_of::<BlockId>())
                    .sum::<usize>(),
            )
            .saturating_add(self.blocks.capacity() * core::mem::size_of::<BlockSlot>())
            .saturating_add(self.documents.capacity() * core::mem::size_of::<DocumentSlot>())
    }

    fn document_mut(&mut self, id: DocumentId) -> Result<&mut Document, DocumentError> {
        let slot = self
            .documents
            .get_mut(id.index() as usize)
            .ok_or(DocumentError::StaleDocument(id))?;
        if slot.generation != id.generation() {
            return Err(DocumentError::StaleDocument(id));
        }
        Ok(&mut slot.value)
    }

    fn block_mut(&mut self, id: BlockId) -> Result<&mut Block, DocumentError> {
        let slot = self
            .blocks
            .get_mut(id.index() as usize)
            .ok_or(DocumentError::StaleBlock(id))?;
        if slot.generation != id.generation() {
            return Err(DocumentError::StaleBlock(id));
        }
        Ok(&mut slot.value)
    }
}

fn tail_by_width(line: &str, width: u16) -> String {
    let mut used = 0usize;
    let mut suffix = Vec::new();
    for grapheme in UnicodeSegmentation::graphemes(line, true).rev() {
        let grapheme_width = UnicodeWidthStr::width(grapheme).max(1);
        if used + grapheme_width > width as usize {
            break;
        }
        used += grapheme_width;
        suffix.push(grapheme);
    }
    suffix.into_iter().rev().collect()
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum DocumentError {
    #[error("stale or foreign document {0:?}")]
    StaleDocument(DocumentId),
    #[error("stale or foreign block {0:?}")]
    StaleBlock(BlockId),
    #[error("document {0:?} already has an open block")]
    OpenBlockExists(DocumentId),
    #[error("block {0:?} is sealed")]
    BlockSealed(BlockId),
    #[error("block {0:?} is not its document's open block")]
    NotDocumentOpenBlock(BlockId),
    #[error("document UTF-8 budget exceeded: used {used}, requested {requested}, limit {limit}")]
    BudgetExceeded {
        used: usize,
        requested: usize,
        limit: usize,
    },
    #[error("document database exhausted its 32-bit ID space")]
    Capacity,
    #[error("native allocation failed")]
    Allocation,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_history_is_stable_and_budget_rejection_is_atomic() {
        let mut db = DocumentDb::new(5);
        let document = db.create_document().unwrap();
        let block = db.open_block(document).unwrap();
        db.append_text(block, "hello").unwrap();
        assert!(matches!(
            db.append_text(block, "!"),
            Err(DocumentError::BudgetExceeded { .. })
        ));
        db.seal_block(block).unwrap();
        assert_eq!(db.block(block).unwrap().text(), "hello");
        assert_eq!(db.stats().text_bytes, 5);
    }
}
