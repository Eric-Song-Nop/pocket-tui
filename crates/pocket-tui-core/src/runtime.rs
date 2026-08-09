//! Runtime orchestration from scene mutations to immutable frame artifacts.

use thiserror::Error;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::{
    AuxId, BoxNode, Cell, DirtyMask, GraphemeStore, LayoutSpec, Length, NodeId, NodeKind, Rect,
    ResourceError, ResourceSnapshot, RowDamage, SceneDb, SceneError, Screen, ScreenError,
    ScreenRow, ScreenSnapshot, Size, Style, StyleId, StyleStore,
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
                continue;
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
}
