//! Integer cell geometry and compact layout inputs.

/// A zero-based terminal row.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(transparent)]
pub struct Row(pub u16);

/// A zero-based terminal column.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(transparent)]
pub struct Column(pub u16);

/// A terminal-sized rectangle extent.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Size {
    /// Number of columns.
    pub columns: u16,
    /// Number of rows.
    pub rows: u16,
}

impl Size {
    /// Creates a size in terminal cells.
    pub const fn new(columns: u16, rows: u16) -> Self {
        Self { columns, rows }
    }

    /// Returns the cell count, without `u16` multiplication overflow.
    pub const fn area(self) -> usize {
        self.columns as usize * self.rows as usize
    }

    /// Returns whether either dimension is zero.
    pub const fn is_empty(self) -> bool {
        self.columns == 0 || self.rows == 0
    }
}

/// A half-open rectangle in terminal cells.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Rect {
    /// Left column.
    pub column: Column,
    /// Top row.
    pub row: Row,
    /// Width in columns.
    pub width: u16,
    /// Height in rows.
    pub height: u16,
}

impl Rect {
    /// Creates a rectangle.
    pub const fn new(column: u16, row: u16, width: u16, height: u16) -> Self {
        Self {
            column: Column(column),
            row: Row(row),
            width,
            height,
        }
    }

    /// Creates a rectangle covering a size from the origin.
    pub const fn from_size(size: Size) -> Self {
        Self::new(0, 0, size.columns, size.rows)
    }

    /// Exclusive right edge.
    pub const fn right(self) -> u16 {
        self.column.0.saturating_add(self.width)
    }

    /// Exclusive bottom edge.
    pub const fn bottom(self) -> u16 {
        self.row.0.saturating_add(self.height)
    }

    /// Returns the rectangle inside `insets`.
    pub const fn inset(self, insets: Insets) -> Self {
        let horizontal = insets.left.saturating_add(insets.right);
        let vertical = insets.top.saturating_add(insets.bottom);
        Self::new(
            self.column.0.saturating_add(insets.left),
            self.row.0.saturating_add(insets.top),
            self.width.saturating_sub(horizontal),
            self.height.saturating_sub(vertical),
        )
    }
}

/// Main-axis direction for a Box node.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Axis {
    /// Children are placed left-to-right.
    Row,
    /// Children are placed top-to-bottom.
    #[default]
    Column,
}

/// Integer edge insets.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Insets {
    pub top: u16,
    pub right: u16,
    pub bottom: u16,
    pub left: u16,
}

impl Insets {
    /// Applies the same inset to all edges.
    pub const fn all(value: u16) -> Self {
        Self {
            top: value,
            right: value,
            bottom: value,
            left: value,
        }
    }
}

/// A compact integer length constraint.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Length {
    /// Use the node's measured content size.
    #[default]
    Auto,
    /// Use an exact number of cells, clamped to the parent.
    Cells(u16),
    /// Share remaining cells by a non-zero integer weight.
    Fill(u16),
}

impl Length {
    pub(crate) const fn weight(self) -> u16 {
        match self {
            Self::Fill(0) => 1,
            Self::Fill(weight) => weight,
            _ => 0,
        }
    }
}

/// Width and height constraints shared by Box and Text nodes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct LayoutSpec {
    pub width: Length,
    pub height: Length,
}

impl LayoutSpec {
    /// A node which fills all available space in both axes.
    pub const FILL: Self = Self {
        width: Length::Fill(1),
        height: Length::Fill(1),
    };
}
