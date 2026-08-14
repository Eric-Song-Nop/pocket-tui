/**
 * PocketJS 0.6 wire constants used by HostOps. They are pinned here because
 * the framework deliberately does not export its low-level spec subpath.
 * HostOps itself comes from the type side of the pinned runtime facade.
 */

export const NODE = {
  view: 0,
  text: 1,
  image: 2,
} as const;

export const ROOT_ID = 1;
export const STYLE_ID_NONE = -1;
export const SIZE_FULL = -1;

export const ID_SLOT_BITS = 20;
export const ID_SLOT_MASK = 0x000f_ffff;
export const MAX_GENERATION = 0x7ff;
export const MAX_TREE_DEPTH = 64;

export const PROP = {
  width: 1,
  height: 2,
  minW: 3,
  minH: 4,
  maxW: 5,
  maxH: 6,
  paddingT: 8,
  paddingR: 9,
  paddingB: 10,
  paddingL: 11,
  marginT: 12,
  marginR: 13,
  marginB: 14,
  marginL: 15,
  gap: 16,
  flexDir: 17,
  justify: 18,
  align: 19,
  grow: 20,
  shrink: 21,
  basis: 22,
  flexWrap: 23,
  posType: 24,
  insetT: 25,
  insetR: 26,
  insetB: 27,
  insetL: 28,
  display: 29,
  overflow: 30,
  zIndex: 31,
  bgColor: 64,
  gradFrom: 65,
  gradTo: 66,
  gradDir: 67,
  radius: 68,
  opacity: 69,
  borderColor: 70,
  borderWidth: 71,
  shadow: 72,
  bevelOuterLight: 77,
  bevelOuterDark: 78,
  bevelInnerLight: 79,
  bevelInnerDark: 80,
  bevelWidth: 81,
  textColor: 96,
  fontSlot: 97,
  textAlign: 98,
  lineHeight: 99,
  tracking: 100,
  translateX: 128,
  translateY: 129,
  scale: 130,
  rotate: 131,
  scaleX: 132,
  scaleY: 133,
  originX: 134,
  originY: 135,
  rotateX: 136,
  rotateY: 137,
  translateZ: 138,
  perspective: 139,
  arcStart: 140,
  arcSweep: 141,
  arcWidth: 142,
} as const;

export const ENUM = {
  flexRow: 0,
  flexColumn: 1,
  justifyStart: 0,
  justifyCenter: 1,
  justifyEnd: 2,
  justifyBetween: 3,
  justifyAround: 4,
  alignStart: 0,
  alignCenter: 1,
  alignEnd: 2,
  alignStretch: 3,
  relative: 0,
  absolute: 1,
  displayFlex: 0,
  displayNone: 1,
  overflowVisible: 0,
  overflowHidden: 1,
  textLeft: 0,
  textCenter: 1,
  textRight: 2,
} as const;

export const STYLE_MAGIC = 0x5453_4344;
export const STYLE_VERSION = 2;
export const STYLE_HEADER_BYTES = 12;
export const STYLE_TRANSITION_BYTES = 12;
export const STYLE_PROP_BYTES = 6;
export const STYLE_BASE = 1 << 0;
export const STYLE_FOCUS = 1 << 1;
export const STYLE_ACTIVE = 1 << 2;
export const STYLE_TRANSITION = 1 << 3;
export const STYLE_ANIMATION = 1 << 4;

export const FLOAT_PROPS = new Set<number>([
  PROP.width,
  PROP.height,
  PROP.minW,
  PROP.minH,
  PROP.maxW,
  PROP.maxH,
  PROP.paddingT,
  PROP.paddingR,
  PROP.paddingB,
  PROP.paddingL,
  PROP.marginT,
  PROP.marginR,
  PROP.marginB,
  PROP.marginL,
  PROP.gap,
  PROP.grow,
  PROP.shrink,
  PROP.basis,
  PROP.insetT,
  PROP.insetR,
  PROP.insetB,
  PROP.insetL,
  PROP.opacity,
  PROP.borderWidth,
  PROP.radius,
  PROP.bevelWidth,
  PROP.lineHeight,
  PROP.tracking,
  PROP.translateX,
  PROP.translateY,
  PROP.scale,
  PROP.rotate,
  PROP.scaleX,
  PROP.scaleY,
  PROP.originX,
  PROP.originY,
  PROP.rotateX,
  PROP.rotateY,
  PROP.translateZ,
  PROP.perspective,
  PROP.arcStart,
  PROP.arcSweep,
  PROP.arcWidth,
]);

export const COLOR_PROPS = new Set<number>([
  PROP.bgColor,
  PROP.gradFrom,
  PROP.gradTo,
  PROP.borderColor,
  PROP.bevelOuterLight,
  PROP.bevelOuterDark,
  PROP.bevelInnerLight,
  PROP.bevelInnerDark,
  PROP.textColor,
]);

export const SUPPORTED_PROPS = new Set<number>([
  PROP.width,
  PROP.height,
  PROP.minW,
  PROP.minH,
  PROP.maxW,
  PROP.maxH,
  PROP.paddingT,
  PROP.paddingR,
  PROP.paddingB,
  PROP.paddingL,
  PROP.marginT,
  PROP.marginR,
  PROP.marginB,
  PROP.marginL,
  PROP.gap,
  PROP.flexDir,
  PROP.justify,
  PROP.align,
  PROP.grow,
  PROP.shrink,
  PROP.basis,
  PROP.posType,
  PROP.insetT,
  PROP.insetR,
  PROP.insetB,
  PROP.insetL,
  PROP.display,
  PROP.overflow,
  PROP.zIndex,
  PROP.bgColor,
  PROP.opacity,
  PROP.borderColor,
  PROP.borderWidth,
  PROP.textColor,
  PROP.fontSlot,
  PROP.textAlign,
  PROP.lineHeight,
  PROP.tracking,
]);

export const KNOWN_PROPS = new Set<number>(Object.values(PROP));
