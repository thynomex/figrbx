/**
 * ODT -> Roblox instance spec.
 *
 * The output is deliberately inert: a typed tree of class names and property
 * values that the Studio plugin applies with pcall. Keeping it data-only means
 * the converter is testable in Node and the Studio side never evaluates
 * anything the Figma document produced.
 */

import { type FontMatch, resolveFont, shouldBakeText } from './fonts.js';
import type {
  OdtDocument,
  OdtEffect,
  OdtGradientStop,
  OdtNode,
  OdtPaint,
  OdtText,
  Rgba,
} from './schema.js';
import { type Behavior, type ParsedName, parseLayerName, textFormatString } from './tags.js';

export type RbxValue =
  | { t: 'udim2'; v: [number, number, number, number] }
  | { t: 'udim'; v: [number, number] }
  | { t: 'color3'; v: [number, number, number] }
  | { t: 'number'; v: number }
  | { t: 'string'; v: string }
  | { t: 'boolean'; v: boolean }
  | { t: 'enum'; enum: string; name: string }
  | { t: 'font'; name: string }
  | { t: 'colorsequence'; v: ColorSequencePoint[] }
  | { t: 'numbersequence'; v: NumberSequencePoint[] }
  | { t: 'vector2'; v: [number, number] };

export type ColorSequencePoint = {
  t: number;
  color: [number, number, number];
  transparency: number;
};
export type NumberSequencePoint = { t: number; value: number };

export type RbxNode = {
  className: string;
  name: string;
  figmaId: string;
  props: Record<string, RbxValue>;
  /** Behavior tags parsed from the layer name. */
  behaviors?: Behavior[];
  /** Attribute names for `{Name}` bindings, in placeholder order. */
  bindings?: string[];
  /** Original text with `%s` placeholders, for runtime attribute binding. */
  textFormat?: string;
  children: RbxNode[];
};

export type RbxDocument = {
  version: 1;
  screenGui: RbxNode;
  warnings: string[];
  meta: {
    name: string;
    width: number;
    height: number;
    aspectRatio: number;
    nodeCount: number;
    imageRefs: string[];
  };
};

type Ctx = {
  /** Design-space size of the parent, in px. */
  parentW: number;
  parentH: number;
  opacity: number;
  warnings: string[];
  doc: OdtDocument;
  imageAsset: (ref: string) => string | undefined;
};

const EPSILON = 1e-6;

function round(value: number, places = 5): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function propUdim2(xs: number, xo: number, ys: number, yo: number): RbxValue {
  return { t: 'udim2', v: [round(xs), round(xo, 2), round(ys), round(yo, 2)] };
}

function propNumber(value: number): RbxValue {
  return { t: 'number', v: round(value) };
}

function propString(value: string): RbxValue {
  return { t: 'string', v: value };
}

function propBoolean(value: boolean): RbxValue {
  return { t: 'boolean', v: value };
}

function propColor(color: Rgba): RbxValue {
  return { t: 'color3', v: [round(color.r), round(color.g), round(color.b)] };
}

function propEnum(enumName: string, name: string): RbxValue {
  return { t: 'enum', enum: enumName, name };
}

function sanitizeName(name: string): string {
  // Roblox instance names may contain most characters, but control bytes and
  // the pipe used by our diagnostics are stripped to keep logs readable.
  let cleaned = '';
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) cleaned += character;
  }
  return cleaned.trim() || 'Layer';
}

/** First visible paint of a kind. Figma stacks fills bottom-first. */
function topPaint(paints: OdtPaint[] | undefined, type: OdtPaint['type']): OdtPaint | undefined {
  if (!paints) return undefined;
  for (let i = paints.length - 1; i >= 0; i--) {
    const paint = paints[i]!;
    if (paint.type === type && paint.visible !== false) return paint;
  }
  return undefined;
}

function firstSolid(
  paints: OdtPaint[] | undefined,
): Extract<OdtPaint, { type: 'solid' }> | undefined {
  const paint = topPaint(paints, 'solid');
  return paint && paint.type === 'solid' ? paint : undefined;
}

function topFill(paints: OdtPaint[] | undefined): OdtPaint | undefined {
  if (!paints) return undefined;
  for (let i = paints.length - 1; i >= 0; i--) {
    if (paints[i]!.visible !== false) return paints[i];
  }
  return undefined;
}

function normalizeStops(stops: OdtGradientStop[], opacity: number): ColorSequencePoint[] {
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  if (sorted.length === 0) {
    return [
      { t: 0, color: [0, 0, 0], transparency: 0 },
      { t: 1, color: [1, 1, 1], transparency: 0 },
    ];
  }
  const points = sorted.map((stop) => ({
    t: clamp01(stop.position),
    color: [round(stop.color.r), round(stop.color.g), round(stop.color.b)] as [
      number,
      number,
      number,
    ],
    transparency: round(clamp01(1 - stop.color.a * opacity)),
  }));
  // Roblox sequences must start at 0 and end at 1.
  if (points[0]!.t > 0) points.unshift({ ...points[0]!, t: 0 });
  if (points[points.length - 1]!.t < 1) points.push({ ...points[points.length - 1]!, t: 1 });
  return points;
}

function transparencySequence(points: ColorSequencePoint[]): NumberSequencePoint[] {
  return points.map((point) => ({ t: point.t, value: point.transparency }));
}

function gradientProps(points: ColorSequencePoint[]): Record<string, RbxValue> {
  const props: Record<string, RbxValue> = { Color: { t: 'colorsequence', v: points } };
  if (points.some((point) => point.transparency > 0.001)) {
    props.Transparency = { t: 'numbersequence', v: transparencySequence(points) };
  }
  return props;
}

function gradientRotation(paint: Extract<OdtPaint, { type: 'linear-gradient' }>): number {
  const angle = Number.isFinite(paint.angle) ? paint.angle : 0;
  // Roblox rotates clockwise from the left-to-right axis, same convention as
  // the angle we compute in the Figma plugin.
  return round(((angle % 360) + 360) % 360);
}

function hasChildren(node: OdtNode): boolean {
  return (node.children?.length ?? 0) > 0;
}

function isBaked(node: OdtNode): boolean {
  return node.baked === true && typeof node.imageRef === 'string';
}

function imageValue(ctx: Ctx, ref: string): string {
  const assetId = ctx.imageAsset(ref);
  return assetId ? `rbxassetid://${assetId}` : 'rbxassetid://0';
}

function imageScaleType(scaleMode: string): string {
  switch (scaleMode) {
    case 'fit':
      return 'Fit';
    case 'stretch':
      return 'Stretch';
    case 'tile':
      return 'Tile';
    default:
      return 'Crop';
  }
}

function cornerScale(node: OdtNode): { scale: number; approximate: boolean } | undefined {
  const radius = node.cornerRadius;
  if (radius === undefined) return undefined;
  const values = Array.isArray(radius) ? radius : [radius];
  const positive = values.filter((value) => value > 0);
  if (positive.length === 0) return undefined;
  const minDimension = Math.min(node.w, node.h);
  const scale = minDimension > EPSILON ? Math.min(...positive) / minDimension : 0;
  const approximate = Array.isArray(radius) && new Set(radius.map((v) => Math.round(v))).size > 1;
  return { scale: Math.min(0.5, scale), approximate };
}

function describeEffects(effects: OdtEffect[] | undefined, warnings: string[], name: string): void {
  if (!effects) return;
  for (const effect of effects) {
    if (effect.type === 'drop-shadow') {
      if (effect.offsetY > 0.5 || effect.radius > 0.5 || (effect.spread ?? 0) > 0.5) {
        warnings.push(`Drop shadow on "${name}" was skipped (not supported)`);
      }
    } else if (effect.type === 'inner-shadow') {
      warnings.push(`Inner shadow on "${name}" was skipped (not supported)`);
    } else {
      warnings.push(`Blur on "${name}" was skipped (not supported by Roblox UI)`);
    }
  }
}

function textColor(node: OdtNode, text: OdtText): Rgba {
  if (text.color) return text.color;
  const solid = firstSolid(node.fills);
  return solid ? solid.color : { r: 1, g: 1, b: 1, a: 1 };
}

function textXAlignment(alignH: OdtText['alignH']): string {
  switch (alignH) {
    case 'CENTER':
      return 'Center';
    case 'RIGHT':
      return 'Right';
    default:
      return 'Left';
  }
}

function textYAlignment(alignV: OdtText['alignV']): string {
  switch (alignV) {
    case 'CENTER':
      return 'Center';
    case 'BOTTOM':
      return 'Bottom';
    default:
      return 'Top';
  }
}

function applyTextCase(text: OdtText): string {
  switch (text.textCase) {
    case 'UPPER':
      return text.characters.toUpperCase();
    case 'LOWER':
      return text.characters.toLowerCase();
    default:
      return text.characters;
  }
}

function baseGeometry(node: OdtNode, ctx: Ctx): Record<string, RbxValue> {
  const { parentW, parentH } = ctx;
  const xScale = parentW > EPSILON ? node.x / parentW : 0;
  const yScale = parentH > EPSILON ? node.y / parentH : 0;
  const wScale = parentW > EPSILON ? node.w / parentW : 0;
  const hScale = parentH > EPSILON ? node.h / parentH : 0;

  const props: Record<string, RbxValue> = {
    Position: propUdim2(xScale, 0, yScale, 0),
    Size: propUdim2(wScale, 0, hScale, 0),
    Visible: propBoolean(node.visible !== false),
    BorderSizePixel: propNumber(0),
  };

  if (node.rotation && Math.abs(node.rotation) > EPSILON) {
    props.Rotation = propNumber(node.rotation);
  }
  if (node.clipsContent) props.ClipsDescendants = propBoolean(true);
  return props;
}

function addFillProps(
  node: OdtNode,
  props: Record<string, RbxValue>,
  children: RbxNode[],
  ctx: Ctx,
): void {
  const opacity = node.opacity ?? 1;
  const fill = topFill(node.fills);

  props.BackgroundTransparency = propNumber(1);
  props.BackgroundColor3 = { t: 'color3', v: [1, 1, 1] };

  if (!fill) return;

  if (fill.type === 'solid') {
    props.BackgroundColor3 = propColor(fill.color);
    props.BackgroundTransparency = propNumber(
      1 - clamp01(fill.color.a * (fill.opacity ?? 1) * opacity),
    );
    return;
  }

  if (fill.type === 'linear-gradient') {
    props.BackgroundTransparency = propNumber(0);
    const points = normalizeStops(fill.stops, opacity);
    children.push({
      className: 'UIGradient',
      name: 'Gradient',
      figmaId: `${node.id}:gradient`,
      props: {
        ...gradientProps(points),
        Rotation: propNumber(gradientRotation(fill)),
      },
      children: [],
    });
    return;
  }

  if (fill.type === 'radial-gradient') {
    // UIGradient is linear only. Approximate with the widest span so the
    // colours survive; the shape is documented as an approximation.
    ctx.warnings.push(`Radial gradient on "${node.rawName}" approximated as linear`);
    props.BackgroundTransparency = propNumber(0);
    children.push({
      className: 'UIGradient',
      name: 'Gradient',
      figmaId: `${node.id}:gradient`,
      props: {
        ...gradientProps(normalizeStops(fill.stops, opacity)),
        Rotation: propNumber(0),
      },
      children: [],
    });
  }
}

function addStroke(node: OdtNode, children: RbxNode[], ctx: Ctx): void {
  const stroke = topFill(node.strokes);
  if (!stroke) return;
  const thickness = (node.strokeWeight ?? 1) * ctx.doc.options.strokeScale;
  if (thickness <= EPSILON) return;

  if (stroke.type !== 'solid' && stroke.type !== 'linear-gradient') {
    ctx.warnings.push(`Unsupported stroke on "${node.rawName}" was skipped`);
    return;
  }

  const props: Record<string, RbxValue> = {
    Thickness: propNumber(thickness),
    ApplyStrokeMode: propEnum('ApplyStrokeMode', 'Border'),
  };
  if (stroke.type === 'solid') {
    props.Color = propColor(stroke.color);
    props.Transparency = propNumber(1 - clamp01(stroke.color.a));
  } else {
    props.Color = { t: 'color3', v: [1, 1, 1] };
    props.Transparency = propNumber(0);
  }

  const strokeNode: RbxNode = {
    className: 'UIStroke',
    name: 'Stroke',
    figmaId: `${node.id}:stroke`,
    props,
    children: [],
  };

  if (stroke.type === 'linear-gradient') {
    const points = normalizeStops(stroke.stops, 1);
    strokeNode.children.push({
      className: 'UIGradient',
      name: 'Gradient',
      figmaId: `${node.id}:stroke-gradient`,
      props: {
        ...gradientProps(points),
        Rotation: propNumber(gradientRotation(stroke)),
      },
      children: [],
    });
  }
  children.push(strokeNode);
}

function addCorner(node: OdtNode, children: RbxNode[], ctx: Ctx): void {
  const corner = cornerScale(node);
  if (!corner) return;
  if (corner.approximate) {
    ctx.warnings.push(`Per-corner radii on "${node.rawName}" reduced to the smallest radius`);
  }
  children.push({
    className: 'UICorner',
    name: 'Corner',
    figmaId: `${node.id}:corner`,
    props: { CornerRadius: { t: 'udim', v: [round(corner.scale), 0] } },
    children: [],
  });
}

function addText(
  node: OdtNode,
  parsed: ParsedName,
  props: Record<string, RbxValue>,
  ctx: Ctx,
): void {
  const text = node.text!;
  const match: FontMatch = resolveFont(text.fontFamily, text.fontStyle);
  const characters = applyTextCase(text);

  props.Text = propString(characters);
  props.Font = { t: 'font', name: match.robloxFont };
  props.TextScaled = propBoolean(true);
  props.TextWrapped = propBoolean(true);
  props.TextXAlignment = propEnum('TextXAlignment', textXAlignment(text.alignH));
  props.TextYAlignment = propEnum('TextYAlignment', textYAlignment(text.alignV));
  props.TextColor3 = propColor(textColor(node, text));
  props.RichText = propBoolean(false);
  props.BackgroundTransparency = propNumber(1);

  // Text keeps the authored placeholders (`{Coins}`) until the controller
  // binds live values; that makes a missing attribute visible in Studio
  // instead of silently rendering an empty label.
  if (parsed.bindings.length > 0) {
    props.Text = propString(characters);
  }
  if (!match.exact && match.note) {
    ctx.warnings.push(`"${node.rawName}": ${match.note} — using ${match.robloxFont}`);
  }
}

function hasImageFill(node: OdtNode): boolean {
  return topPaint(node.fills, 'image') !== undefined;
}

function isInteractive(parsed: ParsedName): boolean {
  return parsed.behaviors.some(
    (behavior) =>
      behavior.kind === 'button' ||
      behavior.kind === 'close' ||
      behavior.kind === 'open' ||
      behavior.kind === 'tab',
  );
}

function convertTextNode(node: OdtNode, parsed: ParsedName, ctx: Ctx): RbxNode {
  const isButtonNode = isInteractive(parsed);
  const children: RbxNode[] = [];
  const props: Record<string, RbxValue> = baseGeometry(node, ctx);
  props.BackgroundTransparency = propNumber(1);

  const match = resolveFont(node.text!.fontFamily, node.text!.fontStyle);
  const bake = shouldBakeText(ctx.doc.options.textMode, match);

  if (bake && isBaked(node)) {
    const imageProps: Record<string, RbxValue> = {
      ...baseGeometry(node, ctx),
      Image: propString(imageValue(ctx, node.imageRef!)),
      ScaleType: propEnum('ScaleType', 'Stretch'),
      BackgroundTransparency: propNumber(1),
      ImageTransparency: propNumber(1 - clamp01((node.opacity ?? 1) * (node.text!.color?.a ?? 1))),
    };
    const imageNode: RbxNode = {
      className: isButtonNode ? 'ImageButton' : 'ImageLabel',
      name: sanitizeName(parsed.name),
      figmaId: node.id,
      props: imageProps,
      children: [],
    };
    attachBehaviorMeta(imageNode, parsed);
    return imageNode;
  }

  if (bake) {
    ctx.warnings.push(
      `Baking requested for "${node.rawName}" but no rasterized layer was supplied`,
    );
  }

  addText(node, parsed, props, ctx);
  if (node.opacity !== undefined && node.opacity < 1) {
    props.TextTransparency = propNumber(1 - clamp01(node.opacity));
  }

  const textNode: RbxNode = {
    className: isButtonNode ? 'TextButton' : 'TextLabel',
    name: sanitizeName(parsed.name),
    figmaId: node.id,
    props,
    children,
  };
  attachBehaviorMeta(textNode, parsed);
  if (parsed.bindings.length > 0) {
    textNode.bindings = parsed.bindings.map((binding) => binding.name);
    textNode.textFormat = textFormatString(applyTextCase(node.text!));
  }
  return textNode;
}

function convertImageNode(node: OdtNode, parsed: ParsedName, ctx: Ctx): RbxNode | undefined {
  const fill = topPaint(node.fills, 'image');
  const isButtonNode = isInteractive(parsed);
  const className = isButtonNode ? 'ImageButton' : 'ImageLabel';
  const imageRef = fill && fill.type === 'image' ? fill.ref : node.imageRef;
  if (!imageRef) return undefined;

  const opacity = node.opacity ?? 1;
  const fillOpacity = fill && fill.type === 'image' ? (fill.opacity ?? 1) : 1;
  const props: Record<string, RbxValue> = {
    ...baseGeometry(node, ctx),
    Image: propString(imageValue(ctx, imageRef)),
    ScaleType: propEnum(
      'ScaleType',
      imageScaleType(fill && fill.type === 'image' ? fill.scaleMode : 'fill'),
    ),
    BackgroundTransparency: propNumber(1),
    ImageTransparency: propNumber(1 - clamp01(opacity * fillOpacity)),
  };
  if (node.clipsContent) props.ClipsDescendants = propBoolean(true);

  const result: RbxNode = {
    className,
    name: sanitizeName(parsed.name),
    figmaId: node.id,
    props,
    children: [],
  };
  attachBehaviorMeta(result, parsed);
  convertChildren(node, parsed, result, {
    ...ctx,
    parentW: node.w,
    parentH: node.h,
  });
  addCorner(node, result.children, ctx);
  return result;
}

function convertScrollingFrame(node: OdtNode, parsed: ParsedName, ctx: Ctx): RbxNode {
  const children: RbxNode[] = [];
  const props: Record<string, RbxValue> = baseGeometry(node, ctx);
  addFillProps(node, props, children, ctx);
  addStroke(node, children, ctx);
  addCorner(node, children, ctx);

  const overflowsY = (node.children ?? []).some((child) => child.y + child.h > node.h + 0.5);
  const overflowsX = (node.children ?? []).some((child) => child.x + child.w > node.w + 0.5);
  const direction = overflowsY && overflowsX ? 'XY' : overflowsX ? 'X' : 'Y';

  props.ScrollingDirection = propEnum('ScrollingDirection', direction);
  props.AutomaticCanvasSize = propEnum('AutomaticSize', direction === 'XY' ? 'XY' : direction);
  props.CanvasSize = propUdim2(0, 0, 0, 0);
  props.ScrollBarThickness = propNumber(4);
  props.ScrollBarImageColor3 = { t: 'color3', v: [0.5, 0.5, 0.6] };

  const result: RbxNode = {
    className: 'ScrollingFrame',
    name: sanitizeName(parsed.name),
    figmaId: node.id,
    props,
    children,
  };
  attachBehaviorMeta(result, parsed);
  convertChildren(node, parsed, result, {
    ...ctx,
    parentW: node.w,
    parentH: node.h,
    opacity: ctx.opacity,
  });
  return result;
}

function convertFrameNode(
  node: OdtNode,
  parsed: ParsedName,
  ctx: Ctx,
  forceClassName?: 'TextButton' | 'Frame',
): RbxNode {
  const opacity = node.opacity ?? 1;
  const useCanvasGroup = opacity < 0.999 && hasChildren(node) && !isBaked(node) && !forceClassName;
  const className = forceClassName ?? (useCanvasGroup ? 'CanvasGroup' : 'Frame');
  const children: RbxNode[] = [];
  const props: Record<string, RbxValue> = baseGeometry(node, ctx);

  addFillProps(node, props, children, ctx);
  addStroke(node, children, ctx);
  addCorner(node, children, ctx);

  if (useCanvasGroup) {
    props.GroupTransparency = propNumber(1 - clamp01(opacity));
  }

  const result: RbxNode = {
    className,
    name: sanitizeName(parsed.name),
    figmaId: node.id,
    props,
    children,
  };
  attachBehaviorMeta(result, parsed);

  const childCtx: Ctx = {
    ...ctx,
    parentW: node.w,
    parentH: node.h,
    opacity: useCanvasGroup ? 1 : ctx.opacity * opacity,
  };
  convertChildren(node, parsed, result, childCtx);
  return result;
}

function attachBehaviorMeta(target: RbxNode, parsed: ParsedName): void {
  if (parsed.behaviors.length > 0) target.behaviors = parsed.behaviors;
}

function convertNode(node: OdtNode, ctx: Ctx): RbxNode | undefined {
  const parsed = parseLayerName(node.rawName);
  describeEffects(node.effects, ctx.warnings, node.rawName);

  const behaviors = new Set(parsed.behaviors.map((behavior) => behavior.kind));
  const hiddenByTag = behaviors.has('closed') || behaviors.has('page');

  if (behaviors.has('scroll')) {
    const result = convertScrollingFrame(node, parsed, ctx);
    if (hiddenByTag) result.props.Visible = propBoolean(false);
    return result;
  }

  if (node.type === 'TEXT' && node.text) {
    const result = convertTextNode(node, parsed, ctx);
    if (hiddenByTag) result.props.Visible = propBoolean(false);
    return result;
  }

  if (isBaked(node) && !hasChildren(node)) {
    const result = convertImageNode(node, parsed, ctx);
    if (result) {
      if (hiddenByTag) result.props.Visible = propBoolean(false);
      return result;
    }
  }

  if (hasImageFill(node)) {
    const result = convertImageNode(node, parsed, ctx);
    if (result) {
      if (hiddenByTag) result.props.Visible = propBoolean(false);
      return result;
    }
  }

  if (node.type === 'ELLIPSE' && !hasChildren(node) && node.w === node.h) {
    const result = convertFrameNode(node, parsed, ctx);
    result.children.push({
      className: 'UICorner',
      name: 'Corner',
      figmaId: `${node.id}:ellipse`,
      props: { CornerRadius: { t: 'udim', v: [0.5, 0] } },
      children: [],
    });
    if (hiddenByTag) result.props.Visible = propBoolean(false);
    return result;
  }

  if (node.type === 'ELLIPSE') {
    ctx.warnings.push(`Ellipse "${node.rawName}" is not square and was approximated as a frame`);
  }

  // A tagged interactive layer without text or an image needs a button class
  // to receive input; TextButton with empty text renders like a Frame.
  if (isInteractive(parsed)) {
    const result = convertFrameNode(node, parsed, ctx, 'TextButton');
    result.props.AutoButtonColor = propBoolean(false);
    if (hiddenByTag) result.props.Visible = propBoolean(false);
    return result;
  }

  const result = convertFrameNode(node, parsed, ctx);
  if (hiddenByTag) result.props.Visible = propBoolean(false);
  return result;
}

function convertChildren(node: OdtNode, _parsed: ParsedName, parent: RbxNode, ctx: Ctx): void {
  for (const child of node.children ?? []) {
    const converted = convertNode(child, ctx);
    if (converted) parent.children.push(converted);
  }
}

/** Build a ScreenGui-level spec from a validated ODT document. */
export function convertDocument(doc: OdtDocument): RbxDocument {
  const assets = new Map<string, string>();
  for (const image of doc.images) {
    if (image.assetId) assets.set(image.ref, image.assetId);
  }

  const warnings: string[] = [];
  const ctx: Ctx = {
    parentW: doc.root.w,
    parentH: doc.root.h,
    opacity: 1,
    warnings,
    doc,
    imageAsset: (ref) => assets.get(ref),
  };

  const rootParsed = parseLayerName(doc.root.rawName);
  const rootChildren: RbxNode[] = [];
  const rootProps: Record<string, RbxValue> = {
    Position: propUdim2(0, 0, 0, 0),
    Size: propUdim2(1, 0, 1, 0),
    BorderSizePixel: propNumber(0),
  };

  addFillProps(doc.root, rootProps, rootChildren, ctx);
  addStroke(doc.root, rootChildren, ctx);
  addCorner(doc.root, rootChildren, ctx);

  if (doc.root.clipsContent) rootProps.ClipsDescendants = propBoolean(true);
  if (doc.root.rotation && Math.abs(doc.root.rotation) > EPSILON) {
    // The root carries the aspect constraint; rotating it would fight the
    // constraint, so the design is imported upright and the import says so.
    warnings.push(`Root rotation on "${doc.root.rawName}" was not applied`);
  }
  if (doc.root.opacity !== undefined && doc.root.opacity < 0.999) {
    warnings.push(`Root opacity on "${doc.root.rawName}" was not applied`);
  }

  const aspectRatio = doc.root.h > EPSILON ? doc.root.w / doc.root.h : 1;

  const rootFrame: RbxNode = {
    className: 'Frame',
    name: sanitizeName(rootParsed.name),
    figmaId: doc.root.id,
    props: rootProps,
    children: rootChildren,
  };
  attachBehaviorMeta(rootFrame, rootParsed);

  const childCtx: Ctx = {
    ...ctx,
    parentW: doc.root.w,
    parentH: doc.root.h,
    opacity: 1,
  };
  convertChildren(doc.root, rootParsed, rootFrame, childCtx);

  rootFrame.children.push({
    className: 'UIAspectRatioConstraint',
    name: 'AspectRatio',
    figmaId: `${doc.root.id}:aspect`,
    props: {
      AspectRatio: propNumber(aspectRatio),
      AspectType: propEnum('AspectType', 'FitWithinMaxSize'),
      DominantAxis: propEnum('DominantAxis', 'Width'),
    },
    children: [],
  });

  const screenGui: RbxNode = {
    className: 'ScreenGui',
    name: sanitizeName(rootParsed.name),
    figmaId: `screengui:${doc.root.id}`,
    props: {
      ResetOnSpawn: propBoolean(false),
      IgnoreGuiInset: propBoolean(true),
      ZIndexBehavior: propEnum('ZIndexBehavior', 'Sibling'),
      DisplayOrder: propNumber(1),
      Enabled: propBoolean(true),
    },
    children: [rootFrame],
  };

  const imageRefs = new Set<string>();
  const collect = (node: OdtNode): void => {
    if (node.imageRef) imageRefs.add(node.imageRef);
    for (const paint of node.fills ?? []) {
      if (paint.type === 'image') imageRefs.add(paint.ref);
    }
    for (const child of node.children ?? []) collect(child);
  };
  collect(doc.root);

  let nodeCount = 0;
  const countTree = (node: RbxNode): void => {
    nodeCount += 1;
    for (const child of node.children) countTree(child);
  };
  countTree(screenGui);

  return {
    version: 1,
    screenGui,
    warnings,
    meta: {
      name: screenGui.name,
      width: doc.root.w,
      height: doc.root.h,
      aspectRatio: round(aspectRatio),
      nodeCount,
      imageRefs: [...imageRefs],
    },
  };
}

/**
 * Encode a UDim2 the way the converter does, exposed for tests and for the
 * Figma plugin's own preview.
 */
export function udim2(xScale: number, xOffset: number, yScale: number, yOffset: number): RbxValue {
  return propUdim2(xScale, xOffset, yScale, yOffset);
}

export function color3(r: number, g: number, b: number): RbxValue {
  return { t: 'color3', v: [round(r), round(g), round(b)] };
}
