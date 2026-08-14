//! Runtime orchestration from scene mutations to immutable frame artifacts.

use thiserror::Error;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::{
    AuxId, BlockId, BoxNode, Cell, DirtyMask, DirtyReason, DocumentDb, DocumentError, DocumentId,
    DocumentStats, GraphemeStore, LayoutSpec, Length, NodeId, NodeKind, Rect, ResourceError,
    ResourceSnapshot, RowDamage, SceneDb, SceneError, Screen, ScreenError, ScreenRow,
    ScreenSnapshot, Size, Style, StyleId, StyleStore, TranscriptNode,
};

/// Monotonic native frame generation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(transparent)]
pub struct FrameGeneration(pub u64);

/// Self-contained output of one runtime render.
#[derive(Clone, Debug)]
pub struct FrameArtifact {
    pub generation: FrameGeneration,
    pub screen: ScreenSnapshot,
    pub dirty: DirtyMask,
    pub dirty_rows: Vec<RowDamage>,
    pub resources: ResourceSnapshot,
}

/// Runtime and document memory counters exposed to bindings.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RuntimeStats {
    pub documents: usize,
    pub blocks: usize,
    pub open_blocks: usize,
    pub document_text_bytes: usize,
    pub document_budget_bytes: usize,
    pub estimated_document_rows: u64,
    pub estimated_native_bytes: usize,
}

impl FrameArtifact {
    /// True when no terminal cell changed.
    pub fn is_empty(&self) -> bool {
        self.dirty_rows.is_empty()
    }
}

/// Single-owner terminal-independent runtime.
#[derive(Clone, Debug)]
pub struct Runtime {
    scene: SceneDb,
    documents: DocumentDb,
    graphemes: GraphemeStore,
    styles: StyleStore,
    screen: Screen,
    size: Size,
    size_dirty: bool,
    frame_generation: FrameGeneration,
}

impl Runtime {
    /// Creates an empty runtime for a terminal viewport.
    pub fn new(size: Size) -> Self {
        Self {
            scene: SceneDb::default(),
            documents: DocumentDb::default(),
            graphemes: GraphemeStore::default(),
            styles: StyleStore::default(),
            // Begin dimensionless so the first commit is an explicit full
            // damage transition even when the desired cells are all blank.
            screen: Screen::new(Size::default(), Cell::default()),
            size,
            size_dirty: true,
            frame_generation: FrameGeneration(0),
        }
    }

    /// Creates a runtime with an explicit aggregate document UTF-8 cap.
    pub fn with_document_budget(size: Size, hard_byte_budget: usize) -> Self {
        let mut runtime = Self::new(size);
        runtime.documents = DocumentDb::new(hard_byte_budget);
        runtime
    }

    pub const fn size(&self) -> Size {
        self.size
    }

    /// Schedules a full layout and paint at the new integer viewport size.
    pub fn resize(&mut self, size: Size) {
        if self.size != size {
            self.size = size;
            self.size_dirty = true;
        }
    }

    pub const fn scene(&self) -> &SceneDb {
        &self.scene
    }

    pub fn scene_mut(&mut self) -> &mut SceneDb {
        &mut self.scene
    }

    pub const fn documents(&self) -> &DocumentDb {
        &self.documents
    }

    pub fn create_document(&mut self) -> Result<DocumentId, RuntimeError> {
        Ok(self.documents.create_document()?)
    }

    pub fn open_block(&mut self, document: DocumentId) -> Result<BlockId, RuntimeError> {
        Ok(self.documents.open_block(document)?)
    }

    pub fn append_block_text(&mut self, block: BlockId, text: &str) -> Result<(), RuntimeError> {
        let document = self.documents.block(block)?.document();
        self.documents.append_text(block, text)?;
        self.scene
            .mark_document(document, DirtyReason::DocumentAppended)?;
        Ok(())
    }

    pub fn seal_block(&mut self, block: BlockId) -> Result<(), RuntimeError> {
        let document = self.documents.block(block)?.document();
        self.documents.seal_block(block)?;
        self.scene
            .mark_document(document, DirtyReason::DocumentSealed)?;
        Ok(())
    }

    pub fn create_transcript(
        &mut self,
        parent: Option<NodeId>,
        node: TranscriptNode,
    ) -> Result<NodeId, RuntimeError> {
        self.documents.document(node.document)?;
        if !node.follow_tail {
            return Err(RuntimeError::UnsupportedTranscriptMode);
        }
        Ok(self.scene.create_transcript(parent, node)?)
    }

    pub fn stats(&self) -> RuntimeStats {
        let DocumentStats {
            documents,
            blocks,
            open_blocks,
            text_bytes,
            hard_byte_budget,
            estimated_rows,
        } = self.documents.stats();
        RuntimeStats {
            documents,
            blocks,
            open_blocks,
            document_text_bytes: text_bytes,
            document_budget_bytes: hard_byte_budget,
            estimated_document_rows: estimated_rows,
            estimated_native_bytes: self.memory_bytes(),
        }
    }

    /// Conservative bytes retained by core-owned stores and the current grid.
    pub fn memory_bytes(&self) -> usize {
        self.documents
            .memory_bytes()
            .saturating_add(self.scene.memory_bytes())
            .saturating_add(self.screen.memory_bytes())
            .saturating_add(self.graphemes.memory_bytes())
            .saturating_add(self.styles.memory_bytes())
    }

    pub const fn graphemes(&self) -> &GraphemeStore {
        &self.graphemes
    }

    pub const fn styles(&self) -> &StyleStore {
        &self.styles
    }

    /// Interns a canonical style for later assignment to scene nodes.
    pub fn intern_style(&mut self, style: Style) -> Result<StyleId, RuntimeError> {
        Ok(self.styles.intern(style)?)
    }

    /// Runs deterministic integer layout and produces a persistent screen snapshot.
    pub fn render_frame(&mut self) -> Result<FrameArtifact, RuntimeError> {
        let mut dirty = self.scene.dirty_mask();
        if self.size_dirty {
            dirty |= DirtyMask::ALL;
        }

        let roots = self.scene.roots().to_vec();
        for root in roots.iter().copied() {
            if self.scene.node(root)?.is_active() {
                self.layout_node(root, Rect::from_size(self.size))?;
            }
        }

        let mut rows: Vec<ScreenRow> = (0..self.size.rows)
            .map(|_| ScreenRow::new(self.size.columns, Cell::default()))
            .collect();
        for root in roots {
            self.paint_node(root, &mut rows)?;
        }
        let rows = rows.into_iter().map(ScreenRow::into_cells).collect();
        let dirty_rows = self.screen.commit(self.size, rows)?;

        self.frame_generation.0 = self.frame_generation.0.wrapping_add(1).max(1);
        self.scene.clear_dirty();
        self.size_dirty = false;
        Ok(FrameArtifact {
            generation: self.frame_generation,
            screen: self.screen.snapshot(),
            dirty,
            dirty_rows,
            resources: ResourceSnapshot::new(&self.graphemes, &self.styles),
        })
    }

    fn measure_node(&self, id: NodeId, available: Size) -> Result<Size, SceneError> {
        let node = self.scene.node(id)?;
        if !node.is_active() {
            return Ok(Size::default());
        }
        let natural = match node.kind() {
            NodeKind::Text(text) => measure_text(&text.text, available, text.wrap),
            NodeKind::Transcript(transcript) => {
                apply_layout(transcript.layout, available, available)
            }
            NodeKind::Canvas(canvas) => apply_layout(
                canvas.layout,
                Size::new(canvas.width, canvas.height),
                available,
            ),
            NodeKind::Box(box_node) => {
                let inner = Size::new(
                    available.columns.saturating_sub(
                        box_node.padding.left.saturating_add(box_node.padding.right),
                    ),
                    available.rows.saturating_sub(
                        box_node.padding.top.saturating_add(box_node.padding.bottom),
                    ),
                );
                let mut main = 0u16;
                let mut cross = 0u16;
                let mut count = 0u16;
                for child in node.children().iter().copied() {
                    if !self.scene.node(child)?.is_active() {
                        continue;
                    }
                    let measured = self.measure_node(child, inner)?;
                    let (child_main, child_cross) = match box_node.axis {
                        crate::Axis::Row => (measured.columns, measured.rows),
                        crate::Axis::Column => (measured.rows, measured.columns),
                    };
                    main = main.saturating_add(child_main);
                    cross = cross.max(child_cross);
                    count = count.saturating_add(1);
                }
                main = main.saturating_add(box_node.gap.saturating_mul(count.saturating_sub(1)));
                match box_node.axis {
                    crate::Axis::Row => Size::new(
                        main.saturating_add(
                            box_node.padding.left.saturating_add(box_node.padding.right),
                        ),
                        cross.saturating_add(
                            box_node.padding.top.saturating_add(box_node.padding.bottom),
                        ),
                    ),
                    crate::Axis::Column => Size::new(
                        cross.saturating_add(
                            box_node.padding.left.saturating_add(box_node.padding.right),
                        ),
                        main.saturating_add(
                            box_node.padding.top.saturating_add(box_node.padding.bottom),
                        ),
                    ),
                }
            }
        };
        Ok(apply_layout(node.layout(), natural, available))
    }

    fn layout_node(&mut self, id: NodeId, rect: Rect) -> Result<(), RuntimeError> {
        let node = self.scene.node(id)?.clone();
        self.scene.set_rect(id, rect)?;
        if !node.is_active() {
            return Ok(());
        }
        let NodeKind::Box(box_node) = node.kind() else {
            return Ok(());
        };
        let inner = rect.inset(box_node.padding);
        let children: Vec<NodeId> = node
            .children()
            .iter()
            .copied()
            .filter(|child| self.scene.node(*child).is_ok_and(|node| node.is_active()))
            .collect();
        if children.is_empty() {
            return Ok(());
        }

        let gap_total = box_node
            .gap
            .saturating_mul((children.len() as u16).saturating_sub(1));
        let (available_main, available_cross) = match box_node.axis {
            crate::Axis::Row => (inner.width.saturating_sub(gap_total), inner.height),
            crate::Axis::Column => (inner.height.saturating_sub(gap_total), inner.width),
        };
        let mut measured = Vec::with_capacity(children.len());
        let mut requests = Vec::with_capacity(children.len());
        let mut fixed_total = 0u32;
        let mut fill_weight = 0u32;
        for child in children.iter().copied() {
            let size = self.measure_node(child, Size::new(inner.width, inner.height))?;
            let layout = self.scene.node(child)?.layout();
            let (main_length, measured_main) = match box_node.axis {
                crate::Axis::Row => (layout.width, size.columns),
                crate::Axis::Column => (layout.height, size.rows),
            };
            let request = match main_length {
                Length::Auto => measured_main,
                Length::Cells(value) => value,
                Length::Fill(_) => 0,
            };
            fixed_total = fixed_total.saturating_add(request as u32);
            fill_weight = fill_weight.saturating_add(main_length.weight() as u32);
            measured.push(size);
            requests.push((main_length, request));
        }

        let fixed_overflow = fixed_total > available_main as u32;
        let fixed_used = if fixed_overflow {
            available_main
        } else {
            fixed_total as u16
        };
        let fill_space = available_main.saturating_sub(fixed_used);
        let mut fill_remainder = fill_space;
        let mut remaining_fill_weight = fill_weight;
        let mut fixed_remainder = available_main;
        let mut remaining_fixed_weight = fixed_total;
        let mut cursor = 0u16;
        for (index, child) in children.into_iter().enumerate() {
            let (main_length, request) = requests[index];
            let main = match main_length {
                Length::Fill(_) if fill_weight > 0 => {
                    let weight = main_length.weight() as u32;
                    let share = if remaining_fill_weight == weight {
                        fill_remainder
                    } else {
                        ((fill_remainder as u32 * weight) / remaining_fill_weight) as u16
                    };
                    fill_remainder = fill_remainder.saturating_sub(share);
                    remaining_fill_weight = remaining_fill_weight.saturating_sub(weight);
                    share
                }
                Length::Fill(_) => 0,
                _ if fixed_overflow => {
                    let weight = request as u32;
                    let share = if remaining_fixed_weight == weight {
                        fixed_remainder
                    } else {
                        ((fixed_remainder as u32 * weight) / remaining_fixed_weight) as u16
                    };
                    fixed_remainder = fixed_remainder.saturating_sub(share);
                    remaining_fixed_weight = remaining_fixed_weight.saturating_sub(weight);
                    share
                }
                _ => request,
            };
            let layout = self.scene.node(child)?.layout();
            let cross_length = match box_node.axis {
                crate::Axis::Row => layout.height,
                crate::Axis::Column => layout.width,
            };
            let measured_cross = match box_node.axis {
                crate::Axis::Row => measured[index].rows,
                crate::Axis::Column => measured[index].columns,
            };
            let cross = resolve_cross(cross_length, measured_cross, available_cross);
            let child_rect = match box_node.axis {
                crate::Axis::Row => Rect::new(
                    inner.column.0.saturating_add(cursor),
                    inner.row.0,
                    main,
                    cross,
                ),
                crate::Axis::Column => Rect::new(
                    inner.column.0,
                    inner.row.0.saturating_add(cursor),
                    cross,
                    main,
                ),
            };
            self.layout_node(child, child_rect)?;
            cursor = cursor.saturating_add(main).saturating_add(box_node.gap);
        }
        Ok(())
    }

    fn paint_node(&mut self, id: NodeId, rows: &mut [ScreenRow]) -> Result<(), RuntimeError> {
        let node = self.scene.node(id)?.clone();
        if !node.is_active() {
            return Ok(());
        }
        match node.kind() {
            NodeKind::Box(box_node) => {
                paint_box(node.rect(), box_node, rows, self.size);
                for child in node.children().iter().copied() {
                    self.paint_node(child, rows)?;
                }
            }
            NodeKind::Text(text) => {
                paint_text(node.rect(), text, rows, self.size, &mut self.graphemes)?;
            }
            NodeKind::Transcript(transcript) => {
                let lines = self.documents.materialize_tail(
                    transcript.document,
                    node.rect().width,
                    node.rect().height,
                    transcript.block_gap,
                )?;
                let top = node.rect().bottom().saturating_sub(lines.len() as u16);
                for (offset, line) in lines.into_iter().enumerate() {
                    let text = crate::TextNode {
                        text: line.text,
                        style: transcript.style,
                        layout: LayoutSpec::default(),
                        wrap: false,
                    };
                    paint_text(
                        Rect::new(
                            node.rect().column.0,
                            top + offset as u16,
                            node.rect().width,
                            1,
                        ),
                        &text,
                        rows,
                        self.size,
                        &mut self.graphemes,
                    )?;
                }
            }
            NodeKind::Canvas(canvas) => {
                for run in &canvas.runs {
                    if run.row >= canvas.height || run.row >= node.rect().height {
                        continue;
                    }
                    if run.column >= canvas.width || run.column >= node.rect().width {
                        continue;
                    }
                    let style = self.intern_style(Style {
                        foreground: run.foreground,
                        background: run.background,
                        attributes: run.attributes,
                    })?;
                    let text = crate::TextNode {
                        text: run.text.clone(),
                        style,
                        layout: LayoutSpec::default(),
                        wrap: false,
                    };
                    let relative_row = run.row;
                    let relative_column = run.column;
                    paint_text(
                        Rect::new(
                            node.rect().column.0.saturating_add(relative_column),
                            node.rect().row.0.saturating_add(relative_row),
                            node.rect()
                                .width
                                .saturating_sub(relative_column)
                                .min(canvas.width.saturating_sub(relative_column)),
                            1,
                        ),
                        &text,
                        rows,
                        self.size,
                        &mut self.graphemes,
                    )?;
                }
            }
        }
        Ok(())
    }
}

fn apply_layout(layout: LayoutSpec, natural: Size, available: Size) -> Size {
    Size::new(
        resolve_length(layout.width, natural.columns, available.columns),
        resolve_length(layout.height, natural.rows, available.rows),
    )
}

fn resolve_length(length: Length, natural: u16, available: u16) -> u16 {
    match length {
        Length::Auto => natural.min(available),
        Length::Cells(value) => value.min(available),
        Length::Fill(_) => available,
    }
}

fn resolve_cross(length: Length, measured: u16, available: u16) -> u16 {
    resolve_length(length, measured, available)
}

fn measure_text(text: &str, available: Size, wrap: bool) -> Size {
    if available.is_empty() || text.is_empty() {
        return Size::default();
    }
    let mut row = 1u16;
    let mut column = 0u16;
    let mut max_column = 0u16;
    for grapheme in UnicodeSegmentation::graphemes(text, true) {
        if grapheme.contains('\n') {
            max_column = max_column.max(column);
            row = row.saturating_add(1);
            column = 0;
            continue;
        }
        let width = UnicodeWidthStr::width(grapheme)
            .max(1)
            .min(u16::MAX as usize) as u16;
        if wrap && column > 0 && column.saturating_add(width) > available.columns {
            max_column = max_column.max(column);
            row = row.saturating_add(1);
            column = 0;
        }
        column = column.saturating_add(width).min(available.columns);
    }
    Size::new(max_column.max(column), row.min(available.rows))
}

fn paint_box(rect: Rect, node: &BoxNode, rows: &mut [ScreenRow], size: Size) {
    let start_row = rect.row.0.min(size.rows);
    let end_row = rect.bottom().min(size.rows);
    let start_column = rect.column.0.min(size.columns) as usize;
    let end_column = rect.right().min(size.columns) as usize;
    let fill = Cell::blank(node.style);
    for row in start_row..end_row {
        rows[row as usize].fill_span(start_column, end_column, fill);
    }
}

fn paint_text(
    rect: Rect,
    node: &crate::TextNode,
    rows: &mut [ScreenRow],
    size: Size,
    graphemes: &mut GraphemeStore,
) -> Result<(), RuntimeError> {
    if rect.width == 0 || rect.height == 0 {
        return Ok(());
    }
    let mut relative_row = 0u16;
    let mut relative_column = 0u16;
    for grapheme in UnicodeSegmentation::graphemes(node.text.as_str(), true) {
        if grapheme.contains('\n') {
            relative_row = relative_row.saturating_add(1);
            relative_column = 0;
            if relative_row >= rect.height {
                break;
            }
            continue;
        }
        let id = graphemes.intern(grapheme)?;
        let width = graphemes
            .get(id)
            .expect("newly interned grapheme must resolve")
            .width();
        if relative_column.saturating_add(width as u16) > rect.width {
            if !node.wrap {
                break;
            }
            relative_row = relative_row.saturating_add(1);
            relative_column = 0;
        }
        if relative_row >= rect.height || width as u16 > rect.width {
            break;
        }
        let row = rect.row.0.saturating_add(relative_row);
        let column = rect.column.0.saturating_add(relative_column);
        if row >= size.rows || column.saturating_add(width as u16) > size.columns {
            break;
        }
        rows[row as usize].write_grapheme(
            crate::Column(column),
            id,
            node.style,
            AuxId(0),
            width,
        )?;
        relative_column = relative_column.saturating_add(width as u16);
    }
    Ok(())
}

/// Runtime render failure. The previous screen remains valid.
#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error(transparent)]
    Scene(#[from] SceneError),
    #[error(transparent)]
    Screen(#[from] ScreenError),
    #[error(transparent)]
    Resource(#[from] ResourceError),
    #[error(transparent)]
    Document(#[from] DocumentError),
    #[error("the MVP transcript primitive supports follow-tail mode only")]
    UnsupportedTranscriptMode,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CanvasNode, CanvasRun, Color, TextAttributes};

    #[test]
    fn canvas_runs_paint_styles_and_damage_only_changed_rows() {
        let mut runtime = Runtime::new(Size::new(5, 2));
        let canvas = runtime
            .scene_mut()
            .create_canvas(
                None,
                CanvasNode {
                    width: 5,
                    height: 2,
                    runs: vec![CanvasRun {
                        row: 0,
                        column: 1,
                        text: "@!".to_owned(),
                        foreground: Color::Indexed(14),
                        background: Color::Default,
                        attributes: TextAttributes::BOLD,
                    }],
                    layout: LayoutSpec::FILL,
                },
            )
            .unwrap();

        let first = runtime.render_frame().unwrap();
        let row = first.screen.row(crate::Row(0)).unwrap();
        let player = row.cells()[1];
        assert_eq!(
            first
                .resources
                .grapheme(player.grapheme())
                .unwrap()
                .as_str(),
            "@"
        );
        let style = first.resources.style(player.style()).unwrap();
        assert_eq!(style.foreground, Color::Indexed(14));
        assert!(style.attributes.contains(TextAttributes::BOLD));

        runtime
            .scene_mut()
            .set_canvas_frame(
                canvas,
                5,
                2,
                vec![CanvasRun {
                    row: 1,
                    column: 3,
                    text: "*".to_owned(),
                    foreground: Color::Indexed(13),
                    background: Color::Default,
                    attributes: TextAttributes::empty(),
                }],
            )
            .unwrap();
        let second = runtime.render_frame().unwrap();

        assert_eq!(second.dirty_rows.len(), 2);
        assert_eq!(second.dirty_rows[0].row, crate::Row(0));
        assert_eq!(second.dirty_rows[1].row, crate::Row(1));
        let row = second.screen.row(crate::Row(1)).unwrap();
        let relic = row.cells()[3];
        assert_eq!(
            second
                .resources
                .grapheme(relic.grapheme())
                .unwrap()
                .as_str(),
            "*"
        );
        assert_eq!(
            second.resources.style(relic.style()).unwrap().foreground,
            Color::Indexed(13)
        );
    }

    #[test]
    fn canvas_clips_to_its_allocated_layout_rect() {
        let mut runtime = Runtime::new(Size::new(4, 2));
        let root = runtime
            .scene_mut()
            .create_box(None, BoxNode::default())
            .unwrap();
        runtime
            .scene_mut()
            .create_canvas(
                Some(root),
                CanvasNode {
                    width: 3,
                    height: 4,
                    runs: vec![
                        CanvasRun {
                            row: 0,
                            column: 0,
                            text: "A界B".to_owned(),
                            foreground: Color::Default,
                            background: Color::Default,
                            attributes: TextAttributes::empty(),
                        },
                        CanvasRun {
                            row: 3,
                            column: 0,
                            text: "leak".to_owned(),
                            foreground: Color::Default,
                            background: Color::Default,
                            attributes: TextAttributes::empty(),
                        },
                    ],
                    layout: LayoutSpec {
                        width: Length::Cells(3),
                        height: Length::Cells(1),
                    },
                },
            )
            .unwrap();
        runtime
            .scene_mut()
            .create_text(Some(root), crate::TextNode::new("SAFE"))
            .unwrap();

        let frame = runtime.render_frame().unwrap();
        let row0 = frame.screen.row(crate::Row(0)).unwrap();
        let row0_text: String = row0
            .cells()
            .iter()
            .filter(|cell| cell.is_lead())
            .map(|cell| frame.resources.grapheme(cell.grapheme()).unwrap().as_str())
            .collect();
        assert_eq!(row0_text, "A界 ");
        let row1 = frame.screen.row(crate::Row(1)).unwrap();
        let row1_text: String = row1
            .cells()
            .iter()
            .filter(|cell| cell.is_lead())
            .map(|cell| frame.resources.grapheme(cell.grapheme()).unwrap().as_str())
            .collect();
        assert_eq!(row1_text, "SAFE");
    }
}
