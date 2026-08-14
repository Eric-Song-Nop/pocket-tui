//! Typed invalidation propagated by scene mutations.

use bitflags::bitflags;

bitflags! {
    /// Runtime phases invalidated by a semantic mutation.
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
    pub struct DirtyMask: u16 {
        const MEASURE = 1 << 0;
        const LAYOUT = 1 << 1;
        const PAINT = 1 << 2;
        const HIT_TEST = 1 << 3;
        const SEMANTICS = 1 << 4;
        const CHILDREN = 1 << 5;

        const VISUAL = Self::MEASURE.bits() | Self::LAYOUT.bits() | Self::PAINT.bits();
        const ALL = Self::VISUAL.bits()
            | Self::HIT_TEST.bits()
            | Self::SEMANTICS.bits()
            | Self::CHILDREN.bits();
    }
}

/// The semantic source of an invalidation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DirtyReason {
    Created,
    Removed,
    TextChanged,
    TextAppended,
    LayoutChanged,
    StyleChanged,
    ActiveChanged,
    ChildChanged,
    DocumentAppended,
    DocumentSealed,
    CanvasChanged,
}

impl DirtyReason {
    /// The minimum phases affected by this reason.
    pub const fn mask(self) -> DirtyMask {
        match self {
            Self::Created | Self::Removed => DirtyMask::ALL,
            Self::TextChanged | Self::TextAppended => DirtyMask::VISUAL,
            Self::LayoutChanged => DirtyMask::VISUAL.union(DirtyMask::HIT_TEST),
            Self::StyleChanged => DirtyMask::PAINT,
            Self::ActiveChanged => DirtyMask::ALL,
            Self::ChildChanged => DirtyMask::VISUAL.union(DirtyMask::CHILDREN),
            Self::DocumentAppended | Self::DocumentSealed | Self::CanvasChanged => {
                DirtyMask::VISUAL
            }
        }
    }
}

/// Dirty metadata held by one scene node.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DirtyState {
    mask: DirtyMask,
    reason: Option<DirtyReason>,
    generation: u64,
}

impl DirtyState {
    pub(crate) fn new(mask: DirtyMask, reason: DirtyReason, generation: u64) -> Self {
        Self {
            mask,
            reason: Some(reason),
            generation,
        }
    }

    /// Invalid phases.
    pub const fn mask(self) -> DirtyMask {
        self.mask
    }

    /// Most recent semantic reason.
    pub const fn reason(self) -> Option<DirtyReason> {
        self.reason
    }

    /// Scene generation which most recently dirtied the node.
    pub const fn generation(self) -> u64 {
        self.generation
    }

    pub(crate) fn mark(&mut self, mask: DirtyMask, reason: DirtyReason, generation: u64) {
        self.mask |= mask;
        self.reason = Some(reason);
        self.generation = generation;
    }

    pub(crate) fn clear(&mut self) {
        self.mask = DirtyMask::empty();
        self.reason = None;
    }
}
