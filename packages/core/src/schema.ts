/**
 * ODT — Open Design Tree.
 *
 * The serialized, framework-free description of a Figma frame that travels from
 * the Figma plugin to the converter. Everything here is plain JSON: no Figma
 * types, no Roblox types, no functions.
 */

export type Rgba = {
  /** 0..1 */
  r: number;
  g: number;
  b: number;
  /** 0..1, 1 = opaque */
  a: number;
};

export type OdtGradientStop = {
  /** 0..1 along the gradient axis */
  position: number;
  color: Rgba;
};

export type OdtPaint =
  | { type: 'solid'; color: Rgba; visible?: boolean; opacity?: number }
  | {
      type: 'linear-gradient';
      stops: OdtGradientStop[];
      /** Direction in degrees, 0 = left-to-right, positive = clockwise. */
      angle: number;
      visible?: boolean;
      opacity?: number;
    }
  | {
      type: 'radial-gradient';
      stops: OdtGradientStop[];
      visible?: boolean;
      opacity?: number;
    }
  | {
      type: 'image';
      /** Key into OdtDocument.images */
      ref: string;
      scaleMode: 'fill' | 'fit' | 'stretch' | 'tile';
      /** 0..1 crop rectangle, default full image */
      crop?: { x: number; y: number; w: number; h: number };
      visible?: boolean;
      opacity?: number;
    };

export type OdtShadow = {
  type: 'drop-shadow' | 'inner-shadow';
  color: Rgba;
  offsetX: number;
  offsetY: number;
  radius: number;
  spread?: number;
};

export type OdtBlur = {
  type: 'layer-blur' | 'background-blur';
  radius: number;
};

export type OdtEffect = OdtShadow | OdtBlur;

export type OdtText = {
  characters: string;
  fontSize: number;
  fontFamily: string;
  /** e.g. "Regular", "Bold", "Semi Bold Italic" */
  fontStyle: string;
  alignH: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  alignV: 'TOP' | 'CENTER' | 'BOTTOM';
  lineHeight?: number;
  letterSpacing?: number;
  color?: Rgba;
  textCase?: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
  textDecoration?: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  /** Additional spacing Roblox text needs to visually match Figma, in design px. */
  padding?: { top: number; right: number; bottom: number; left: number };
};

export type OdtNodeType =
  | 'FRAME'
  | 'GROUP'
  | 'RECTANGLE'
  | 'ELLIPSE'
  | 'TEXT'
  | 'VECTOR'
  | 'LINE'
  | 'COMPONENT'
  | 'INSTANCE'
  | 'BOOLEAN_OPERATION'
  | 'OTHER';

export type OdtNode = {
  /** Stable Figma node id, e.g. "12:34" */
  id: string;
  /** Layer name exactly as authored, including behavior tags. */
  rawName: string;
  type: OdtNodeType;

  /** Position relative to the parent's top-left, in design px, pre-rotation. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees, clockwise. */
  rotation?: number;
  opacity?: number;
  visible?: boolean;
  clipsContent?: boolean;

  /** Uniform radius in px, or per-corner [topLeft, topRight, bottomRight, bottomLeft]. */
  cornerRadius?: number | [number, number, number, number];

  fills?: OdtPaint[];
  strokes?: OdtPaint[];
  strokeWeight?: number;
  strokeAlign?: 'INSIDE' | 'OUTSIDE' | 'CENTER';

  effects?: OdtEffect[];

  text?: OdtText;

  /** True when the node's pixels cannot be represented natively and were exported. */
  baked?: boolean;
  /** Key into OdtDocument.images for baked layers / image fills. */
  imageRef?: string;

  /** Children in Figma paint order (first = bottom). */
  children?: OdtNode[];
};

export type OdtOptions = {
  /** live: always editable text; exact: bake fonts Roblox cannot match; auto: bake unknown fonts only. */
  textMode: 'live' | 'exact' | 'auto';
  /** Export scale for rasterized layers. */
  imageScale: number;
  /** Roblox UIStroke thickness is in px at the design size. */
  strokeScale: number;
};

export type OdtImage = {
  /** Stable key referenced by OdtNode.imageRef / OdtPaint.ref */
  ref: string;
  /** SHA-256 of the exported PNG bytes, hex. */
  sha256: string;
  /** Suggested file name */
  name: string;
  /** Assigned by the bridge after upload. */
  assetId?: string;
  /** Fallback data transfer, only used by the static export. */
  width?: number;
  height?: number;
};

export type OdtDocument = {
  version: 1;
  /** Selected frame */
  root: OdtNode;
  images: OdtImage[];
  options: OdtOptions;
  meta?: {
    name?: string;
    /** Design size of the root frame in px */
    width?: number;
    height?: number;
    source?: string;
    exportedAt?: string;
  };
};

export const DEFAULT_OPTIONS: OdtOptions = {
  textMode: 'auto',
  imageScale: 2,
  strokeScale: 1,
};

/** Depth-first walk, parents before children. */
export function walkOdt(
  node: OdtNode,
  visit: (node: OdtNode, parent: OdtNode | null) => void,
): void {
  const stack: Array<{ node: OdtNode; parent: OdtNode | null }> = [{ node, parent: null }];
  while (stack.length > 0) {
    const entry = stack.pop()!;
    visit(entry.node, entry.parent);
    const children = entry.node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i]!, parent: entry.node });
    }
  }
}

/** Basic structural validation for untrusted documents arriving at the bridge. */
export function validateOdt(
  value: unknown,
): { ok: true; doc: OdtDocument } | { ok: false; error: string } {
  if (!value || typeof value !== 'object')
    return { ok: false, error: 'document must be an object' };
  const doc = value as Partial<OdtDocument>;
  if (doc.version !== 1) return { ok: false, error: 'unsupported document version' };
  if (!doc.root || typeof doc.root !== 'object') return { ok: false, error: 'missing root node' };
  if (!Array.isArray(doc.images)) return { ok: false, error: 'images must be an array' };
  if (!doc.options || typeof doc.options !== 'object') {
    doc.options = { ...DEFAULT_OPTIONS };
  }
  if (
    doc.options.textMode !== 'live' &&
    doc.options.textMode !== 'exact' &&
    doc.options.textMode !== 'auto'
  ) {
    return { ok: false, error: 'invalid textMode' };
  }
  const imageRefs = new Set(doc.images.map((image) => image?.ref));
  const result = validateNode(doc.root, imageRefs, 0);
  if (!result.ok) return result;
  return { ok: true, doc: doc as OdtDocument };
}

function validateNode(
  node: OdtNode,
  imageRefs: Set<string | undefined>,
  depth: number,
): { ok: true } | { ok: false; error: string } {
  if (depth > 200) return { ok: false, error: 'tree too deep' };
  if (!node || typeof node !== 'object') return { ok: false, error: 'invalid node' };
  if (typeof node.id !== 'string' || node.id.length === 0)
    return { ok: false, error: 'node id missing' };
  if (typeof node.rawName !== 'string') return { ok: false, error: `node ${node.id} has no name` };
  for (const key of ['x', 'y', 'w', 'h'] as const) {
    if (typeof node[key] !== 'number' || !Number.isFinite(node[key])) {
      return { ok: false, error: `node ${node.id} has invalid ${key}` };
    }
  }
  if (node.w < 0 || node.h < 0) return { ok: false, error: `node ${node.id} has negative size` };
  if (node.imageRef && !imageRefs.has(node.imageRef)) {
    return { ok: false, error: `node ${node.id} references unknown image ${node.imageRef}` };
  }
  for (const paint of [...(node.fills ?? []), ...(node.strokes ?? [])]) {
    if (paint.type === 'image' && !imageRefs.has(paint.ref)) {
      return { ok: false, error: `node ${node.id} references unknown image ${paint.ref}` };
    }
  }
  if (node.children) {
    if (!Array.isArray(node.children))
      return { ok: false, error: `node ${node.id} children must be an array` };
    for (const child of node.children) {
      const result = validateNode(child, imageRefs, depth + 1);
      if (!result.ok) return result;
    }
  }
  return { ok: true };
}
