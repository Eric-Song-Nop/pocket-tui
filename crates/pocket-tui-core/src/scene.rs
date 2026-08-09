//! Generational scene database for Box and Text primitives.

use thiserror::Error;

use crate::{Axis, DirtyMask, DirtyReason, DirtyState, Insets, LayoutSpec, Rect, StyleId};

/// Opaque generational scene handle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(transparent)]
pub struct NodeId(u64);

impl NodeId {
    const fn new(index: u32, generation: u32) -> Self {
        Self(((generation as u64) << 32) | index as u64)
    }

    /// Reconstructs a non-zero-generation ID received over an ABI boundary.
    pub const fn from_raw(raw: u64) -> Option<Self> {
        if raw >> 32 == 0 {
            None
        } else {
            Some(Self(raw))
        }
    }

    /// Packed ABI representation.
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

/// Box primitive properties.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoxNode {
    pub axis: Axis,
    pub gap: u16,
    pub padding: Insets,
    pub layout: LayoutSpec,
    /// Style used to paint the box background cells.
    pub style: StyleId,
}

impl Default for BoxNode {
    fn default() -> Self {
        Self {
            axis: Axis::Column,
            gap: 0,
            padding: Insets::default(),
            layout: LayoutSpec::FILL,
            style: StyleId::DEFAULT,
        }
    }
}

/// Text primitive properties.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextNode {
    pub text: String,
    pub style: StyleId,
    pub layout: LayoutSpec,
    pub wrap: bool,
}

impl TextNode {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            style: StyleId::DEFAULT,
            layout: LayoutSpec::default(),
            wrap: true,
        }
    }
}

/// Primitive-specific node data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NodeKind {
    Box(BoxNode),
    Text(TextNode),
}

/// One active or retained scene node.
#[derive(Clone, Debug)]
pub struct Node {
    parent: Option<NodeId>,
    children: Vec<NodeId>,
    active: bool,
    rect: Rect,
    dirty: DirtyState,
    kind: NodeKind,
}

impl Node {
    pub const fn parent(&self) -> Option<NodeId> {
        self.parent
    }

    pub fn children(&self) -> &[NodeId] {
        &self.children
    }

    pub const fn is_active(&self) -> bool {
        self.active
    }

    pub const fn rect(&self) -> Rect {
        self.rect
    }

    pub const fn dirty(&self) -> DirtyState {
        self.dirty
    }

    pub const fn kind(&self) -> &NodeKind {
        &self.kind
    }

    pub fn kind_mut(&mut self) -> &mut NodeKind {
        &mut self.kind
    }

    pub const fn layout(&self) -> LayoutSpec {
        match &self.kind {
            NodeKind::Box(node) => node.layout,
            NodeKind::Text(node) => node.layout,
        }
    }
}

#[derive(Clone, Debug)]
struct Slot {
    generation: u32,
    node: Option<Node>,
}

/// Single-owner generational store for scene primitives.
#[derive(Clone, Debug, Default)]
pub struct SceneDb {
    slots: Vec<Slot>,
    free: Vec<u32>,
    roots: Vec<NodeId>,
    generation: u64,
}

impl SceneDb {
    pub const fn generation(&self) -> u64 {
        self.generation
    }

    pub fn roots(&self) -> &[NodeId] {
        &self.roots
    }

    pub fn create_box(
        &mut self,
        parent: Option<NodeId>,
        value: BoxNode,
    ) -> Result<NodeId, SceneError> {
        self.create(parent, NodeKind::Box(value))
    }

    pub fn create_text(
        &mut self,
        parent: Option<NodeId>,
        value: TextNode,
    ) -> Result<NodeId, SceneError> {
        self.create(parent, NodeKind::Text(value))
    }

    fn create(&mut self, parent: Option<NodeId>, kind: NodeKind) -> Result<NodeId, SceneError> {
        if let Some(parent) = parent {
            self.node(parent)?;
        }
        let generation = self.bump_generation();
        let node = Node {
            parent,
            children: Vec::new(),
            active: true,
            rect: Rect::default(),
            dirty: DirtyState::new(DirtyMask::ALL, DirtyReason::Created, generation),
            kind,
        };
        let id = if let Some(index) = self.free.pop() {
            let slot = &mut self.slots[index as usize];
            slot.node = Some(node);
            NodeId::new(index, slot.generation)
        } else {
            let index = u32::try_from(self.slots.len()).map_err(|_| SceneError::Capacity)?;
            self.slots.push(Slot {
                generation: 1,
                node: Some(node),
            });
            NodeId::new(index, 1)
        };
        if let Some(parent) = parent {
            self.node_slot_mut(parent)?.children.push(id);
            self.mark(parent, DirtyReason::ChildChanged, generation)?;
        } else {
            self.roots.push(id);
        }
        Ok(id)
    }

    pub fn node(&self, id: NodeId) -> Result<&Node, SceneError> {
        let slot = self
            .slots
            .get(id.index() as usize)
            .ok_or(SceneError::StaleNode(id))?;
        if slot.generation != id.generation() {
            return Err(SceneError::StaleNode(id));
        }
        slot.node.as_ref().ok_or(SceneError::StaleNode(id))
    }

    /// Returns a mutable node and pessimistically marks all phases dirty.
    pub fn node_mut(&mut self, id: NodeId) -> Result<&mut Node, SceneError> {
        let generation = self.bump_generation();
        self.mark(id, DirtyReason::LayoutChanged, generation)?;
        self.node_slot_mut(id)
    }

    pub fn set_text(&mut self, id: NodeId, text: impl Into<String>) -> Result<(), SceneError> {
        let text = text.into();
        {
            let node = self.node_slot_mut(id)?;
            let NodeKind::Text(value) = &mut node.kind else {
                return Err(SceneError::WrongKind(id));
            };
            if value.text == text {
                return Ok(());
            }
            value.text = text;
        }
        let generation = self.bump_generation();
        self.mark(id, DirtyReason::TextChanged, generation)
    }

    pub fn append_text(&mut self, id: NodeId, text: &str) -> Result<(), SceneError> {
        if text.is_empty() {
            return Ok(());
        }
        {
            let node = self.node_slot_mut(id)?;
            let NodeKind::Text(value) = &mut node.kind else {
                return Err(SceneError::WrongKind(id));
            };
            value.text.push_str(text);
        }
        let generation = self.bump_generation();
        self.mark(id, DirtyReason::TextAppended, generation)
    }

    pub fn set_active(&mut self, id: NodeId, active: bool) -> Result<(), SceneError> {
        if self.node(id)?.active == active {
            return Ok(());
        }
        self.node_slot_mut(id)?.active = active;
        let generation = self.bump_generation();
        self.mark(id, DirtyReason::ActiveChanged, generation)
    }

    pub fn remove(&mut self, id: NodeId) -> Result<(), SceneError> {
        let generation = self.bump_generation();
        self.remove_inner(id, generation)
    }

    fn remove_inner(&mut self, id: NodeId, generation: u64) -> Result<(), SceneError> {
        let (parent, children) = {
            let node = self.node(id)?;
            (node.parent, node.children.clone())
        };
        for child in children {
            self.remove_inner(child, generation)?;
        }
        if let Some(parent) = parent {
            self.node_slot_mut(parent)?
                .children
                .retain(|child| *child != id);
            self.mark(parent, DirtyReason::ChildChanged, generation)?;
        } else {
            self.roots.retain(|root| *root != id);
        }
        let slot = self
            .slots
            .get_mut(id.index() as usize)
            .ok_or(SceneError::StaleNode(id))?;
        if slot.generation != id.generation() || slot.node.is_none() {
            return Err(SceneError::StaleNode(id));
        }
        slot.node = None;
        slot.generation = slot.generation.wrapping_add(1).max(1);
        self.free.push(id.index());
        Ok(())
    }

    pub fn dirty_mask(&self) -> DirtyMask {
        self.slots
            .iter()
            .filter_map(|slot| slot.node.as_ref())
            .fold(DirtyMask::empty(), |mask, node| mask | node.dirty.mask())
    }

    pub(crate) fn clear_dirty(&mut self) {
        for node in self.slots.iter_mut().filter_map(|slot| slot.node.as_mut()) {
            node.dirty.clear();
        }
    }

    pub(crate) fn set_rect(&mut self, id: NodeId, rect: Rect) -> Result<(), SceneError> {
        self.node_slot_mut(id)?.rect = rect;
        Ok(())
    }

    fn mark(
        &mut self,
        mut id: NodeId,
        reason: DirtyReason,
        generation: u64,
    ) -> Result<(), SceneError> {
        let mut first = true;
        loop {
            let node = self.node_slot_mut(id)?;
            let mask = if first {
                reason.mask()
            } else {
                DirtyMask::LAYOUT | DirtyMask::PAINT | DirtyMask::CHILDREN
            };
            node.dirty.mark(
                mask,
                if first {
                    reason
                } else {
                    DirtyReason::ChildChanged
                },
                generation,
            );
            let Some(parent) = node.parent else {
                break;
            };
            id = parent;
            first = false;
        }
        Ok(())
    }

    fn node_slot_mut(&mut self, id: NodeId) -> Result<&mut Node, SceneError> {
        let slot = self
            .slots
            .get_mut(id.index() as usize)
            .ok_or(SceneError::StaleNode(id))?;
        if slot.generation != id.generation() {
            return Err(SceneError::StaleNode(id));
        }
        slot.node.as_mut().ok_or(SceneError::StaleNode(id))
    }

    fn bump_generation(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1).max(1);
        self.generation
    }
}

/// Scene handle or mutation failure.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum SceneError {
    #[error("stale or foreign scene node {0:?}")]
    StaleNode(NodeId),
    #[error("node {0:?} has the wrong primitive kind")]
    WrongKind(NodeId),
    #[error("scene exhausted its 32-bit slot space")]
    Capacity,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removed_handle_never_resolves_after_slot_reuse() {
        let mut scene = SceneDb::default();
        let old = scene.create_text(None, TextNode::new("old")).unwrap();
        scene.remove(old).unwrap();
        let new = scene.create_text(None, TextNode::new("new")).unwrap();
        assert_eq!(old.index(), new.index());
        assert_ne!(old.generation(), new.generation());
        assert!(scene.node(old).is_err());
    }
}
