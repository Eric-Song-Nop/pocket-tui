//! Persistent row snapshots and precise dirty spans.

use std::sync::Arc;

use thiserror::Error;

use crate::{AuxId, Cell, CellError, Column, GraphemeId, Row, Size, StyleId};

/// Monotonic generation for one screen row.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(transparent)]
pub struct RowGeneration(pub u64);

/// A half-open dirty column range.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct DirtySpan {
    pub start: Column,
    pub end: Column,
}

impl DirtySpan {
    pub const fn new(start: u16, end: u16) -> Self {
        Self {
            start: Column(start),
            end: Column(end),
        }
    }

    pub const fn is_empty(self) -> bool {
        self.start.0 >= self.end.0
    }

    fn union(self, other: Self) -> Self {
        Self::new(self.start.0.min(other.start.0), self.end.0.max(other.end.0))
    }
}

/// Changed portion of one row in a frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct RowDamage {
    pub row: Row,
    pub span: DirtySpan,
    pub generation: RowGeneration,
}

/// Mutable screen row whose cell allocation is copied only while snapshots exist.
#[derive(Clone, Debug)]
pub struct ScreenRow {
    cells: Arc<Vec<Cell>>,
    fill: Cell,
    generation: RowGeneration,
    dirty: Option<DirtySpan>,
}

impl ScreenRow {
    pub fn new(width: u16, fill: Cell) -> Self {
        Self {
            cells: Arc::new(vec![fill; width as usize]),
            fill,
            generation: RowGeneration(1),
            dirty: Some(DirtySpan::new(0, width)),
        }
    }

    pub fn cells(&self) -> &[Cell] {
        &self.cells
    }

    pub const fn generation(&self) -> RowGeneration {
        self.generation
    }

    pub const fn dirty_span(&self) -> Option<DirtySpan> {
        self.dirty
    }

    /// Writes one grapheme and repairs every old lead/continuation it overlaps.
    pub fn write_grapheme(
        &mut self,
        column: Column,
        grapheme: GraphemeId,
        style: StyleId,
        aux: AuxId,
        width: u8,
    ) -> Result<(), ScreenError> {
        let start = column.0 as usize;
        let end = start
            .checked_add(width as usize)
            .ok_or(ScreenError::OutOfBounds)?;
        if width == 0 || end > self.cells.len() {
            return Err(ScreenError::OutOfBounds);
        }

        let mut affected_start = start;
        let mut affected_end = end;
        let cells = Arc::make_mut(&mut self.cells);
        for index in start..end {
            let old = cells[index];
            let lead_index = if old.is_continuation() {
                index.saturating_sub(old.lead_offset() as usize)
            } else {
                index
            };
            let old_width = cells
                .get(lead_index)
                .map(|cell| cell.display_width().max(1) as usize)
                .unwrap_or(1);
            affected_start = affected_start.min(lead_index);
            affected_end = affected_end.max((lead_index + old_width).min(cells.len()));
        }

        cells[affected_start..affected_end].fill(self.fill);
        let lead = Cell::lead(grapheme, style, aux, width)?;
        cells[start] = lead;
        for offset in 1..width {
            cells[start + offset as usize] = Cell::continuation(lead, offset)?;
        }
        self.mark_dirty(affected_start, affected_end);
        Ok(())
    }

    pub(crate) fn replace_cells(&mut self, cells: Vec<Cell>) -> Option<DirtySpan> {
        if self.cells.as_slice() == cells.as_slice() {
            self.dirty = None;
            return None;
        }
        let old = self.cells.as_slice();
        let common = old.len().min(cells.len());
        let start = (0..common)
            .find(|&index| old[index] != cells[index])
            .unwrap_or(common);
        let mut end = common;
        while end > start && old[end - 1] == cells[end - 1] {
            end -= 1;
        }
        if old.len() != cells.len() {
            end = old.len().max(cells.len());
        }
        self.cells = Arc::new(cells);
        self.generation.0 = self.generation.0.wrapping_add(1).max(1);
        let span = DirtySpan::new(start as u16, end as u16);
        self.dirty = Some(span);
        Some(span)
    }

    pub(crate) fn fill_span(&mut self, start: usize, end: usize, fill: Cell) {
        let end = end.min(self.cells.len());
        if start >= end {
            return;
        }
        let cells = Arc::make_mut(&mut self.cells);
        let mut affected_start = start;
        let mut affected_end = end;
        for index in start..end {
            let old = cells[index];
            let lead_index = if old.is_continuation() {
                index.saturating_sub(old.lead_offset() as usize)
            } else {
                index
            };
            let width = cells
                .get(lead_index)
                .map(|cell| cell.display_width().max(1) as usize)
                .unwrap_or(1);
            affected_start = affected_start.min(lead_index);
            affected_end = affected_end.max((lead_index + width).min(cells.len()));
        }
        cells[affected_start..affected_end].fill(fill);
        self.mark_dirty(affected_start, affected_end);
    }

    pub(crate) fn into_cells(self) -> Vec<Cell> {
        Arc::try_unwrap(self.cells).unwrap_or_else(|cells| cells.as_ref().clone())
    }

    fn mark_dirty(&mut self, start: usize, end: usize) {
        self.generation.0 = self.generation.0.wrapping_add(1).max(1);
        let span = DirtySpan::new(start as u16, end as u16);
        self.dirty = Some(self.dirty.map_or(span, |old| old.union(span)));
    }

    fn snapshot(&self) -> RowSnapshot {
        RowSnapshot {
            cells: self.cells.clone(),
            generation: self.generation,
        }
    }
}

/// Immutable, cheaply cloned row view.
#[derive(Clone, Debug)]
pub struct RowSnapshot {
    cells: Arc<Vec<Cell>>,
    generation: RowGeneration,
}

impl RowSnapshot {
    pub fn cells(&self) -> &[Cell] {
        &self.cells
    }

    pub const fn generation(&self) -> RowGeneration {
        self.generation
    }
}

/// Immutable screen view carried by a frame artifact.
#[derive(Clone, Debug)]
pub struct ScreenSnapshot {
    size: Size,
    rows: Arc<Vec<RowSnapshot>>,
}

impl ScreenSnapshot {
    pub const fn size(&self) -> Size {
        self.size
    }

    pub fn row(&self, row: Row) -> Option<&RowSnapshot> {
        self.rows.get(row.0 as usize)
    }

    pub fn rows(&self) -> &[RowSnapshot] {
        &self.rows
    }
}

/// Mutable persistent screen model.
#[derive(Clone, Debug)]
pub struct Screen {
    size: Size,
    rows: Vec<ScreenRow>,
    fill: Cell,
}

impl Screen {
    pub fn new(size: Size, fill: Cell) -> Self {
        Self {
            size,
            rows: (0..size.rows)
                .map(|_| ScreenRow::new(size.columns, fill))
                .collect(),
            fill,
        }
    }

    pub const fn size(&self) -> Size {
        self.size
    }

    pub fn row(&self, row: Row) -> Option<&ScreenRow> {
        self.rows.get(row.0 as usize)
    }

    pub fn row_mut(&mut self, row: Row) -> Option<&mut ScreenRow> {
        self.rows.get_mut(row.0 as usize)
    }

    /// Replaces desired rows, preserving allocations/generations for equal rows.
    pub fn commit(
        &mut self,
        size: Size,
        rows: Vec<Vec<Cell>>,
    ) -> Result<Vec<RowDamage>, ScreenError> {
        if rows.len() != size.rows as usize
            || rows.iter().any(|row| row.len() != size.columns as usize)
        {
            return Err(ScreenError::InvalidDimensions);
        }

        let resized = self.size != size;
        if resized {
            self.size = size;
            self.rows = rows
                .into_iter()
                .map(|cells| ScreenRow {
                    cells: Arc::new(cells),
                    fill: self.fill,
                    generation: RowGeneration(1),
                    dirty: Some(DirtySpan::new(0, size.columns)),
                })
                .collect();
            return Ok(self
                .rows
                .iter()
                .enumerate()
                .map(|(row, value)| RowDamage {
                    row: Row(row as u16),
                    span: DirtySpan::new(0, size.columns),
                    generation: value.generation,
                })
                .collect());
        }

        let mut damage = Vec::new();
        for (index, (screen_row, cells)) in self.rows.iter_mut().zip(rows).enumerate() {
            if let Some(span) = screen_row.replace_cells(cells) {
                damage.push(RowDamage {
                    row: Row(index as u16),
                    span,
                    generation: screen_row.generation,
                });
            }
        }
        Ok(damage)
    }

    pub fn snapshot(&self) -> ScreenSnapshot {
        ScreenSnapshot {
            size: self.size,
            rows: Arc::new(self.rows.iter().map(ScreenRow::snapshot).collect()),
        }
    }

    pub(crate) fn memory_bytes(&self) -> usize {
        self.rows.capacity() * core::mem::size_of::<ScreenRow>()
            + self
                .rows
                .iter()
                .map(|row| row.cells.len() * core::mem::size_of::<Cell>())
                .sum::<usize>()
    }
}

/// Screen mutation failure.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum ScreenError {
    #[error("cell coordinate or grapheme extends beyond the row")]
    OutOfBounds,
    #[error("screen row dimensions do not match the screen size")]
    InvalidDimensions,
    #[error(transparent)]
    Cell(#[from] CellError),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overwriting_continuation_clears_the_entire_old_grapheme() {
        let mut row = ScreenRow::new(4, Cell::default());
        row.write_grapheme(Column(0), GraphemeId(1), StyleId::DEFAULT, AuxId(0), 2)
            .unwrap();
        row.write_grapheme(Column(1), GraphemeId(2), StyleId::DEFAULT, AuxId(0), 1)
            .unwrap();

        assert_eq!(row.cells()[0], Cell::default());
        assert_eq!(row.cells()[1].grapheme(), GraphemeId(2));
        assert!(!row.cells()[1].is_continuation());
    }
}
