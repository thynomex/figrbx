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
import {
  type Behavior,
  type ControlTag,
  type ParsedName,
  behaviorTarget,
  hasControl,
  parseLayerName,
  textFormatString,
} from './tags.js';

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
  | { t: 'vector2'; v: [number, number] }
  | { t: 'vector3'; v: [number, number, number] };

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
  /** Control tags, including ones the Studio runtime will consume later. */
  controls?: ControlTag[];
  /** Attribute names for `{Name}` bindings, in placeholder order. */
  bindings?: string[];
  /** Original text with `%s` placeholders, for runtime attribute binding. */
  textFormat?: string;
  /** `_bind:path`: the whole label comes from this player-relative path. */
  bindPath?: string;
  children: RbxNode[];
};

/** Where the imported UI lives at runtime. */
export type RbxHost = {
  kind: 'screen' | 'billboard' | 'surface' | 'prompt';
  /** World width in studs for billboard / surface / prompt hosts. */
  studs?: number;
  /** Anchor part the host is adorned to, for world hosts. */
  anchor?: {
    name: string;
    size: [number, number, number];
    position: [number, number, number];
  };
  /** ProximityPrompt spec, for the prompt host. */
  prompt?: RbxNode;
};

export type RbxDocument = {
  version: 1;
  /** The LayerCollector node: ScreenGui, BillboardGui, or SurfaceGui. */
  screenGui: RbxNode;
  host: RbxHost;
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
  /** Text layers chosen by a parent's `_textbox` tag. */
  textboxIds: Set<string>;
  /** Number of `_tabgroup` ancestors, used to validate bare `_tab` / `_page`. */
  tabGroupDepth: number;
  /** Number of interactive ancestors, used to validate state layers. */
  interactiveDepth: number;
  /** 1 once we are below the root, where host tags are no longer valid. */
  hostDepth: number;
  /** Durations requested by `_hold` layers, used to configure the prompt. */
  holdDurations: number[];
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

function propVector3(x: number, y: number, z: number): RbxValue {
  return { t: 'vector3', v: [round(x, 4), round(y, 4), round(z, 4)] };
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

/**
 * Blur has no UI equivalent. Shadows do: UIShadow renders drop and inner
 * shadows natively, so they are emitted as children instead of being dropped.
 */
function warnUnsupportedEffects(
  effects: OdtEffect[] | undefined,
  warnings: string[],
  name: string,
): void {
  if (!effects) return;
  for (const effect of effects) {
    if (effect.type === 'layer-blur' || effect.type === 'background-blur') {
      warnings.push(`Blur on "${name}" was skipped (not supported by Roblox UI)`);
    }
  }
}

/** Shadow offsets, spread and blur are expressed as scales so they track the layout. */
function addShadows(
  node: OdtNode,
  children: RbxNode[],
  ctx: Ctx,
  /** Text shadows follow glyphs; shape shadows follow the GuiObject's rectangle. */
  isText: boolean,
): void {
  const shadows = (node.effects ?? []).filter(
    (effect): effect is Extract<OdtEffect, { type: 'drop-shadow' | 'inner-shadow' }> =>
      effect.type === 'drop-shadow' || effect.type === 'inner-shadow',
  );
  if (shadows.length === 0) return;

  const width = node.w > EPSILON ? node.w : 1;
  const height = node.h > EPSILON ? node.h : 1;
  const shortSide = Math.max(EPSILON, Math.min(width, height));

  let zIndex = 0;
  for (const effect of shadows) {
    const inner = effect.type === 'inner-shadow';
    if (inner && isText) {
      ctx.warnings.push(
        `Inner shadow on "${node.rawName}" cannot render inside text glyphs — skipped. Use a drop shadow or a shape layer for the inner effect.`,
      );
      continue;
    }

    const spread = effect.spread ?? 0;
    children.push({
      className: 'UIShadow',
      name: inner ? 'InnerShadow' : 'DropShadow',
      figmaId: `${node.id}:shadow:${zIndex}`,
      props: {
        Offset: propUdim2(effect.offsetX / width, 0, effect.offsetY / height, 0),
        Spread: propUdim2(spread / width, 0, spread / height, 0),
        BlurRadius: { t: 'udim', v: [round(effect.radius / shortSide, 5), 0] },
        Color: propColor(effect.color),
        Transparency: propNumber(1 - clamp01(effect.color.a)),
        Inset: propBoolean(inner),
        Mode: propEnum('ApplyShadowMode', isText ? 'Text' : 'Shape'),
        ZIndex: propNumber(zIndex),
      },
      children: [],
    });
    zIndex += 1;
  }
}

type HorizontalAlign = 'Left' | 'Center' | 'Right';
type VerticalAlign = 'Top' | 'Center' | 'Bottom';

type LayoutPlan =
  | {
      kind: 'list';
      direction: 'Horizontal' | 'Vertical';
      gap: number;
      horizontal: HorizontalAlign;
      vertical: VerticalAlign;
    }
  | {
      kind: 'grid';
      columns: number;
      cellW: number;
      cellH: number;
      gapX: number;
      gapY: number;
      horizontal: HorizontalAlign;
      vertical: VerticalAlign;
    };

/** Positions closer than half a design pixel are the same line. */
function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.5;
}

/** Consecutive gaps must be identical; a 1 px deviation is not a list. */
function gapsAgree(gaps: number[]): boolean {
  return gaps.every((gap) => Math.abs(gap - gaps[0]!) <= 0.01);
}

function uniformGap(items: Array<{ start: number; size: number }>): number | undefined {
  if (items.length < 2) return undefined;
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const gaps: number[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    gaps.push(sorted[i + 1]!.start - (sorted[i]!.start + sorted[i]!.size));
  }
  if (gaps.some((gap) => gap < -0.01)) return undefined;
  if (!gapsAgree(gaps)) return undefined;
  return Math.max(0, gaps[0]!);
}

function sharedHorizontal(nodes: OdtNode[]): HorizontalAlign | undefined {
  const first = nodes[0]!;
  if (nodes.every((node) => near(node.x, first.x))) return 'Left';
  if (nodes.every((node) => near(node.x + node.w, first.x + first.w))) return 'Right';
  if (nodes.every((node) => near(node.x + node.w / 2, first.x + first.w / 2))) return 'Center';
  return undefined;
}

function sharedVertical(nodes: OdtNode[]): VerticalAlign | undefined {
  const first = nodes[0]!;
  if (nodes.every((node) => near(node.y, first.y))) return 'Top';
  if (nodes.every((node) => near(node.y + node.h, first.y + first.h))) return 'Bottom';
  if (nodes.every((node) => near(node.y + node.h / 2, first.y + first.h / 2))) return 'Center';
  return undefined;
}

function groupHorizontal(node: OdtNode, nodes: OdtNode[]): HorizontalAlign {
  const start = Math.min(...nodes.map((child) => child.x));
  const end = Math.max(...nodes.map((child) => child.x + child.w));
  if (near(start, 0)) return 'Left';
  if (near(end, node.w)) return 'Right';
  if (near((start + end) / 2, node.w / 2)) return 'Center';
  return 'Left';
}

function groupVertical(node: OdtNode, nodes: OdtNode[]): VerticalAlign {
  const start = Math.min(...nodes.map((child) => child.y));
  const end = Math.max(...nodes.map((child) => child.y + child.h));
  if (near(start, 0)) return 'Top';
  if (near(end, node.h)) return 'Bottom';
  if (near((start + end) / 2, node.h / 2)) return 'Center';
  return 'Top';
}

/** Children tagged _ignore never participate in inferred layout. */
function layoutChildren(node: OdtNode): OdtNode[] {
  return (node.children ?? []).filter(
    (child) => !hasControl(parseLayerName(child.rawName), 'ignore'),
  );
}

function detectListPlan(
  node: OdtNode,
): Omit<Extract<LayoutPlan, { kind: 'list' }>, 'kind'> | undefined {
  const children = layoutChildren(node);
  if (children.length < 3) return undefined;

  const verticalGap = uniformGap(children.map((child) => ({ start: child.y, size: child.h })));
  const horizontalGap = uniformGap(children.map((child) => ({ start: child.x, size: child.w })));

  if (verticalGap !== undefined) {
    const horizontal = sharedHorizontal(children);
    if (horizontal) {
      return {
        direction: 'Vertical',
        gap: verticalGap,
        horizontal,
        vertical: groupVertical(node, children),
      };
    }
  }
  if (horizontalGap !== undefined) {
    const vertical = sharedVertical(children);
    if (vertical) {
      return {
        direction: 'Horizontal',
        gap: horizontalGap,
        horizontal: groupHorizontal(node, children),
        vertical,
      };
    }
  }
  return undefined;
}

function explicitListPlan(node: OdtNode, ctx: Ctx, tag: string): LayoutPlan | undefined {
  const children = layoutChildren(node);
  if (children.length < 2) {
    ctx.warnings.push(
      `"${node.rawName}": _${tag} needs at least two child layers — kept absolute positions.`,
    );
    return undefined;
  }

  const verticalGap = uniformGap(children.map((child) => ({ start: child.y, size: child.h })));
  const horizontalGap = uniformGap(children.map((child) => ({ start: child.x, size: child.w })));

  let direction: 'Horizontal' | 'Vertical';
  let gap: number;
  if (verticalGap !== undefined && horizontalGap === undefined) {
    direction = 'Vertical';
    gap = verticalGap;
  } else if (horizontalGap !== undefined && verticalGap === undefined) {
    direction = 'Horizontal';
    gap = horizontalGap;
  } else if (verticalGap !== undefined) {
    direction = 'Vertical';
    gap = verticalGap;
  } else if (horizontalGap !== undefined) {
    direction = 'Horizontal';
    gap = horizontalGap;
  } else {
    ctx.warnings.push(
      `"${node.rawName}": _${tag} needs evenly spaced children, but the gaps differ — kept absolute positions. Make the spacing identical in Figma or remove _${tag}.`,
    );
    return undefined;
  }

  const horizontal =
    direction === 'Vertical'
      ? (sharedHorizontal(children) ?? groupHorizontal(node, children))
      : groupHorizontal(node, children);
  const vertical =
    direction === 'Horizontal'
      ? (sharedVertical(children) ?? groupVertical(node, children))
      : groupVertical(node, children);

  if (direction === 'Vertical' && !sharedHorizontal(children)) {
    ctx.warnings.push(
      `"${node.rawName}": list items do not share a horizontal edge — aligned ${horizontal.toLowerCase()}. Align them in Figma to control the list alignment.`,
    );
  }
  if (direction === 'Horizontal' && !sharedVertical(children)) {
    ctx.warnings.push(
      `"${node.rawName}": list items do not share a vertical edge — aligned ${vertical.toLowerCase()}. Align them in Figma to control the list alignment.`,
    );
  }

  return { kind: 'list', direction, gap, horizontal, vertical };
}

function gridPlan(node: OdtNode, ctx: Ctx): LayoutPlan | undefined {
  const children = layoutChildren(node);
  if (children.length < 2) {
    ctx.warnings.push(
      `"${node.rawName}": _grid needs at least two child layers — kept absolute positions.`,
    );
    return undefined;
  }

  const first = children[0]!;
  if (!children.every((child) => near(child.w, first.w) && near(child.h, first.h))) {
    ctx.warnings.push(
      `"${node.rawName}": _grid needs equal cell sizes, but the children differ — kept absolute positions. Make every cell the same size or remove _grid.`,
    );
    return undefined;
  }

  const sorted = [...children].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: OdtNode[][] = [];
  for (const child of sorted) {
    const row = rows[rows.length - 1];
    if (row && near(row[0]!.y, child.y)) row.push(child);
    else rows.push([child]);
  }
  for (const row of rows) row.sort((a, b) => a.x - b.x);

  const columns = rows[0]!.length;
  const ragged = rows.some((row, index) =>
    index < rows.length - 1 ? row.length !== columns : row.length > columns,
  );
  if (ragged) {
    ctx.warnings.push(
      `"${node.rawName}": _grid children form an irregular grid (only the last row may be shorter) — kept absolute positions. Align the cells in Figma or remove _grid.`,
    );
    return undefined;
  }

  const origin = rows[0]![0]!;
  const gapX = columns > 1 ? rows[0]![1]!.x - (rows[0]![0]!.x + first.w) : 0;
  const gapY = rows.length > 1 ? rows[1]![0]!.y - (rows[0]![0]!.y + first.h) : 0;
  if (gapX < -0.01 || gapY < -0.01) {
    ctx.warnings.push(`"${node.rawName}": _grid cells overlap — kept absolute positions.`);
    return undefined;
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]!;
    const expectedY = origin.y + rowIndex * (first.h + gapY);
    if (!near(row[0]!.y, expectedY)) {
      ctx.warnings.push(
        `"${node.rawName}": _grid rows are not evenly spaced — kept absolute positions. Make the row spacing identical or remove _grid.`,
      );
      return undefined;
    }
    for (let column = 0; column < row.length; column++) {
      const expectedX = origin.x + column * (first.w + gapX);
      if (!near(row[column]!.x, expectedX)) {
        ctx.warnings.push(
          `"${node.rawName}": _grid columns are not evenly spaced — kept absolute positions. Make the column spacing identical or remove _grid.`,
        );
        return undefined;
      }
    }
  }

  return {
    kind: 'grid',
    columns,
    cellW: first.w,
    cellH: first.h,
    gapX,
    gapY,
    horizontal: groupHorizontal(node, children),
    vertical: groupVertical(node, children),
  };
}

function autoListEligible(node: OdtNode, parsed: ParsedName): boolean {
  if (node.type === 'TEXT') return false;
  if (isBaked(node) || hasImageFill(node)) return false;
  if (parsed.behaviors.some((behavior) => behavior.kind === 'scroll')) return false;
  if (isInteractive(parsed)) return false;
  return (node.children?.length ?? 0) >= 3;
}

function resolveLayout(node: OdtNode, parsed: ParsedName, ctx: Ctx): LayoutPlan | undefined {
  const wantsList = hasControl(parsed, 'list');
  const wantsGrid = hasControl(parsed, 'grid');

  if (wantsList && wantsGrid) {
    ctx.warnings.push(
      `"${node.rawName}": _list and _grid conflict — _list takes precedence. Remove one tag.`,
    );
  }

  if (!wantsList && !wantsGrid) {
    if (hasControl(parsed, 'nolist')) return undefined;
    if (!autoListEligible(node, parsed)) return undefined;
    const detected = detectListPlan(node);
    if (!detected) return undefined;
    ctx.warnings.push(
      `"${node.rawName}": children share even spacing, so they were imported as a UIListLayout. Tag the layer _nolist to keep absolute positions.`,
    );
    return { kind: 'list', ...detected };
  }

  if (isBaked(node) || node.type === 'TEXT') {
    ctx.warnings.push(
      `"${node.rawName}": _${wantsList ? 'list' : 'grid'} cannot apply to a ${
        isBaked(node) ? 'baked image' : 'text layer'
      } — kept absolute positions. Tag the containing frame instead.`,
    );
    return undefined;
  }

  if (wantsList || wantsGrid) {
    const tag = wantsList ? 'list' : 'grid';
    if (parsed.behaviors.some((behavior) => behavior.kind === 'scroll')) {
      ctx.warnings.push(
        `"${node.rawName}": _${tag} on a scrolling frame lays the children out but does not expand the canvas. Put _${tag} on a child frame inside the _scroll instead.`,
      );
    }
    if (wantsList) {
      if (hasControl(parsed, 'nolist')) {
        ctx.warnings.push(
          `"${node.rawName}": _nolist only opts out of automatic detection; _list still applies. Remove _nolist to silence this.`,
        );
      }
      return explicitListPlan(node, ctx, 'list');
    }
    return gridPlan(node, ctx);
  }
  return undefined;
}

function layoutRanks(children: OdtNode[], plan: LayoutPlan): Map<number, number> {
  const indices = children
    .map((_, index) => index)
    .filter((index) => !hasControl(parseLayerName(children[index]!.rawName), 'ignore'));

  indices.sort((a, b) => {
    const left = children[a]!;
    const right = children[b]!;
    if (plan.kind === 'list') {
      const axis = plan.direction === 'Vertical' ? left.y - right.y : left.x - right.x;
      if (axis !== 0) return axis;
      return plan.direction === 'Vertical' ? left.x - right.x : left.y - right.y;
    }
    return left.y - right.y || left.x - right.x;
  });

  const ranks = new Map<number, number>();
  indices.forEach((index, rank) => ranks.set(index, rank + 1));
  return ranks;
}

function appendLayoutObject(node: OdtNode, plan: LayoutPlan, items: RbxNode): void {
  const width = Math.max(node.w, EPSILON);
  const height = Math.max(node.h, EPSILON);
  const common = {
    SortOrder: propEnum('SortOrder', 'LayoutOrder'),
    HorizontalAlignment: propEnum('HorizontalAlignment', plan.horizontal),
    VerticalAlignment: propEnum('VerticalAlignment', plan.vertical),
  };

  if (plan.kind === 'list') {
    const axis = plan.direction === 'Vertical' ? height : width;
    items.children.unshift({
      className: 'UIListLayout',
      name: 'ListLayout',
      figmaId: `${node.id}:list`,
      props: {
        FillDirection: propEnum('FillDirection', plan.direction),
        Padding: { t: 'udim', v: [round(plan.gap / axis, 5), 0] },
        ...common,
      },
      children: [],
    });
    return;
  }

  items.children.unshift({
    className: 'UIGridLayout',
    name: 'GridLayout',
    figmaId: `${node.id}:grid`,
    props: {
      CellSize: propUdim2(plan.cellW / width, 0, plan.cellH / height, 0),
      CellPadding: propUdim2(plan.gapX / width, 0, plan.gapY / height, 0),
      FillDirection: propEnum('FillDirection', 'Horizontal'),
      FillDirectionMaxCells: propNumber(plan.columns),
      ...common,
    },
    children: [],
  });
}

/**
 * Lays children out with a layout object under a child frame named `Items`, so
 * children added at runtime join the flow instead of overlapping the design.
 */
function appendChildren(
  node: OdtNode,
  parsed: ParsedName,
  parent: RbxNode,
  ctx: Ctx,
  layout: LayoutPlan | undefined,
): void {
  if (!layout) {
    convertChildren(node, parsed, parent, ctx);
    return;
  }

  const items: RbxNode = {
    className: 'Frame',
    name: 'Items',
    figmaId: `${node.id}:items`,
    props: {
      Position: propUdim2(0, 0, 0, 0),
      Size: propUdim2(1, 0, 1, 0),
      BackgroundTransparency: propNumber(1),
      BorderSizePixel: propNumber(0),
    },
    children: [],
  };

  const children = node.children ?? [];
  const ranks = layoutRanks(children, layout);
  for (let index = 0; index < children.length; index++) {
    const converted = convertNode(children[index]!, ctx);
    if (!converted) continue;
    const rank = ranks.get(index);
    if (rank !== undefined) converted.props.LayoutOrder = propNumber(rank);
    items.children.push(converted);
  }

  appendLayoutObject(node, layout, items);
  parent.children.push(items);
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
  props: Record<string, RbxValue>,
  ctx: Ctx,
  match: FontMatch,
  /** The caller already explained the font substitution; do not repeat it. */
  fontNoteSuppressed: boolean,
  /** `_fit`: let the text fill its box instead of keeping the design size. */
  scaled: boolean,
): void {
  const text = node.text!;
  const characters = applyTextCase(text);

  props.Text = propString(characters);
  props.Font = { t: 'font', name: match.robloxFont };
  // Default keeps the authored point size; TextScaled distorts typography and
  // an auto-width label has no box to fit. `_fit` opts into it explicitly.
  props.TextSize = propNumber(text.fontSize);
  props.TextScaled = propBoolean(scaled);
  props.TextWrapped = propBoolean(true);
  props.TextXAlignment = propEnum('TextXAlignment', textXAlignment(text.alignH));
  props.TextYAlignment = propEnum('TextYAlignment', textYAlignment(text.alignV));
  props.TextColor3 = propColor(textColor(node, text));
  props.RichText = propBoolean(false);
  props.BackgroundTransparency = propNumber(1);

  // Text keeps the authored placeholders (`{Coins}`) until the controller
  // binds live values; that makes a missing attribute visible in Studio
  // instead of silently rendering an empty label. Nothing to rewrite here.
  if (!fontNoteSuppressed && !match.exact && match.note) {
    ctx.warnings.push(`"${node.rawName}": ${match.note} — using ${match.robloxFont}`);
  }
}

function hasImageFill(node: OdtNode): boolean {
  return topPaint(node.fills, 'image') !== undefined;
}

const STATE_KINDS = ['hover', 'clicked', 'default', 'disabled', 'active'] as const;
const POINTER_KINDS = ['lean', 'magnet'] as const;
const HOST_KINDS = ['billboard', 'surface', 'prompt'] as const;
const HOST_DEFAULT_STUDS: Record<(typeof HOST_KINDS)[number], number> = {
  billboard: 10,
  surface: 10,
  prompt: 6,
};

function stateKind(parsed: ParsedName): (typeof STATE_KINDS)[number] | undefined {
  return STATE_KINDS.find((kind) => parsed.behaviors.some((behavior) => behavior.kind === kind));
}

function isInteractive(parsed: ParsedName): boolean {
  return parsed.behaviors.some(
    (behavior) =>
      behavior.kind === 'button' ||
      behavior.kind === 'close' ||
      behavior.kind === 'open' ||
      behavior.kind === 'toggle' ||
      behavior.kind === 'exit' ||
      behavior.kind === 'tab' ||
      behavior.kind === 'select',
  );
}

function convertTextboxNode(node: OdtNode, parsed: ParsedName, ctx: Ctx): RbxNode {
  const text = node.text!;
  const match = resolveFont(text.fontFamily, text.fontStyle);
  const color = textColor(node, text);
  const props: Record<string, RbxValue> = {
    ...baseGeometry(node, ctx),
    // The drawn text is a prompt, not a value: the field starts empty.
    Text: propString(''),
    PlaceholderText: propString(applyTextCase(text)),
    PlaceholderColor3: propColor(color),
    TextColor3: propColor(color),
    Font: { t: 'font', name: match.robloxFont },
    TextSize: propNumber(text.fontSize),
    TextScaled: propBoolean(hasControl(parsed, 'fit')),
    TextWrapped: propBoolean(true),
    TextXAlignment: propEnum('TextXAlignment', textXAlignment(text.alignH)),
    TextYAlignment: propEnum('TextYAlignment', textYAlignment(text.alignV)),
    ClearTextOnFocus: propBoolean(false),
    RichText: propBoolean(false),
    BackgroundTransparency: propNumber(1),
  };
  if (node.opacity !== undefined && node.opacity < 1) {
    props.TextTransparency = propNumber(1 - clamp01(node.opacity));
  }

  if (parsed.bindings.length > 0) {
    const names = parsed.bindings.map((binding) => `{${binding.name}}`).join(', ');
    ctx.warnings.push(
      `"${node.rawName}": a TextBox cannot bind ${names} — the field starts empty and the drawn text became the placeholder. Use a TextLabel for live values.`,
    );
  }
  if (!match.exact && match.note) {
    ctx.warnings.push(`"${node.rawName}": ${match.note} — using ${match.robloxFont}`);
  }
  const children: RbxNode[] = [];
  addShadows(node, children, ctx, true);

  const result: RbxNode = {
    className: 'TextBox',
    name: sanitizeName(parsed.name),
    figmaId: node.id,
    props,
    children,
  };
  attachLayerMeta(result, parsed);
  return result;
}

function convertTextNode(node: OdtNode, parsed: ParsedName, ctx: Ctx): RbxNode {
  const isButtonNode = isInteractive(parsed);
  const children: RbxNode[] = [];
  const props: Record<string, RbxValue> = baseGeometry(node, ctx);
  props.BackgroundTransparency = propNumber(1);

  const match = resolveFont(node.text!.fontFamily, node.text!.fontStyle);
  const forceBake = hasControl(parsed, 'bake');
  const forceLive = hasControl(parsed, 'text');
  const modeBake = shouldBakeText(ctx.doc.options.textMode, match);
  const bake = forceBake || (!forceLive && modeBake);

  const asTextbox = hasControl(parsed, 'textbox') || ctx.textboxIds.has(node.id);
  if (asTextbox) {
    if (isButtonNode) {
      ctx.warnings.push(
        `"${node.rawName}": _textbox and a button behaviour conflict — kept as a ${isButtonNode ? 'TextButton' : 'TextLabel'}. Use a TextLabel for the caption and a separate TextBox for input.`,
      );
    } else {
      if (bake) {
        ctx.warnings.push(
          `"${node.rawName}": _textbox stays live, so the bake was skipped. Remove _textbox to bake it, or _txt to keep it live without the warning.`,
        );
      }
      return convertTextboxNode(node, parsed, ctx);
    }
  }

  const bindPath = behaviorTarget(parsed, 'bind');
  if (bake && isBaked(node) && (parsed.bindings.length > 0 || bindPath)) {
    const names = bindPath
      ? `_bind:${bindPath}`
      : parsed.bindings.map((binding) => `{${binding.name}}`).join(', ');
    ctx.warnings.push(
      `"${node.rawName}": this layer is baked as an image, so its ${names} binding will not update at runtime. Remove _image or add _txt to keep it live.`,
    );
  }
  if (bake && isBaked(node) && hasControl(parsed, 'fit')) {
    ctx.warnings.push(
      `"${node.rawName}": this text is baked as an image, so _fit cannot scale it. Add _txt to keep it live.`,
    );
  }

  if (bake && isBaked(node)) {
    const imageProps: Record<string, RbxValue> = {
      ...baseGeometry(node, ctx),
      Image: propString(imageValue(ctx, node.imageRef!)),
      ScaleType: propEnum('ScaleType', 'Stretch'),
      BackgroundTransparency: propNumber(1),
      ImageTransparency: propNumber(1 - clamp01((node.opacity ?? 1) * (node.text!.color?.a ?? 1))),
    };
    if (isButtonNode) imageProps.AutoButtonColor = propBoolean(false);
    const imageNode: RbxNode = {
      className: isButtonNode ? 'ImageButton' : 'ImageLabel',
      name: sanitizeName(parsed.name),
      figmaId: node.id,
      props: imageProps,
      children: [],
    };
    attachLayerMeta(imageNode, parsed);
    return imageNode;
  }

  if (bake) {
    // The layer was asked to be an image, but the export has no raster for it.
    // Say what will actually appear, and what fixes it.
    const reason = forceBake
      ? '_image asks for this text to be rasterized'
      : `${ctx.doc.options.textMode === 'exact' ? 'Exact' : 'Auto'} mode wants "${node.text!.fontFamily}" baked`;
    ctx.warnings.push(
      `"${node.rawName}": ${reason}, but this export has no image for it — kept as live text in ${match.robloxFont}. Re-export from Figma to rasterize it.`,
    );
  }

  addText(node, props, ctx, match, bake, hasControl(parsed, 'fit'));
  if (isButtonNode) props.AutoButtonColor = propBoolean(false);
  addShadows(node, children, ctx, true);
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
  attachLayerMeta(textNode, parsed);
  if (bindPath) {
    if (parsed.bindings.length > 0) {
      ctx.warnings.push(
        `"${node.rawName}": _bind and {Attr} placeholders both set the text — _bind wins and the placeholders were ignored. Remove one of them.`,
      );
    }
    textNode.bindPath = bindPath;
  } else if (parsed.bindings.length > 0) {
    textNode.bindings = parsed.bindings.map((binding) => binding.name);
    textNode.textFormat = textFormatString(applyTextCase(node.text!));
  }
  return textNode;
}

function keptChildren(node: OdtNode, ctx: Ctx): OdtNode[] {
  const kept: OdtNode[] = [];
  let skipped = 0;
  for (const child of node.children ?? []) {
    if (hasControl(parseLayerName(child.rawName), 'keep')) {
      kept.push(child);
    } else {
      skipped += 1;
    }
  }
  if (skipped > 0) {
    ctx.warnings.push(
      `"${node.rawName}" was baked as one image; ${skipped} child layer${
        skipped === 1 ? '' : 's'
      } without _keep were part of that raster and were not imported as instances. Tag children that must stay editable with _keep.`,
    );
  }
  return kept;
}

function convertImageNode(
  node: OdtNode,
  parsed: ParsedName,
  ctx: Ctx,
  /** The raster contains the layer and its children; only _keep children stay live. */
  baked = false,
  layout?: LayoutPlan,
): RbxNode | undefined {
  const fill = topPaint(node.fills, 'image');
  const isButtonNode = isInteractive(parsed);
  const className = isButtonNode ? 'ImageButton' : 'ImageLabel';
  const imageRef = baked ? node.imageRef : fill && fill.type === 'image' ? fill.ref : node.imageRef;
  if (!imageRef) return undefined;

  const opacity = node.opacity ?? 1;
  const fillOpacity = !baked && fill && fill.type === 'image' ? (fill.opacity ?? 1) : 1;
  const props: Record<string, RbxValue> = {
    ...baseGeometry(node, ctx),
    Image: propString(imageValue(ctx, imageRef)),
    ScaleType: propEnum(
      'ScaleType',
      baked ? 'Stretch' : imageScaleType(fill && fill.type === 'image' ? fill.scaleMode : 'fill'),
    ),
    BackgroundTransparency: propNumber(1),
    // A baked raster already includes the layer's opacity and fill alpha.
    ImageTransparency: propNumber(baked ? 0 : 1 - clamp01(opacity * fillOpacity)),
  };
  if (isButtonNode) props.AutoButtonColor = propBoolean(false);
  if (node.clipsContent) props.ClipsDescendants = propBoolean(true);

  const result: RbxNode = {
    className,
    name: sanitizeName(parsed.name),
    figmaId: node.id,
    props,
    children: [],
  };
  attachLayerMeta(result, parsed);

  const childCtx: Ctx = childContext(ctx, node, parsed);

  if (baked) {
    for (const child of keptChildren(node, ctx)) {
      const converted = convertNode(child, childCtx);
      if (converted) result.children.push(converted);
    }
  } else {
    appendChildren(node, parsed, result, childCtx, layout);
    addCorner(node, result.children, ctx);
    addShadows(node, result.children, ctx, false);
  }

  return result;
}

function convertScrollingFrame(
  node: OdtNode,
  parsed: ParsedName,
  ctx: Ctx,
  layout?: LayoutPlan,
): RbxNode {
  const children: RbxNode[] = [];
  const props: Record<string, RbxValue> = baseGeometry(node, ctx);
  addFillProps(node, props, children, ctx);
  addStroke(node, children, ctx);
  addCorner(node, children, ctx);
  addShadows(node, children, ctx, false);

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
  attachLayerMeta(result, parsed);
  appendChildren(
    node,
    parsed,
    result,
    childContext(ctx, node, parsed, { opacity: ctx.opacity }),
    layout,
  );
  return result;
}

function convertFrameNode(
  node: OdtNode,
  parsed: ParsedName,
  ctx: Ctx,
  forceClassName?: 'TextButton' | 'Frame',
  layout?: LayoutPlan,
): RbxNode {
  const opacity = node.opacity ?? 1;
  const forceCanvas = hasControl(parsed, 'canvas');
  if (forceCanvas && forceClassName === 'TextButton') {
    ctx.warnings.push(
      `"${node.rawName}": _canvas cannot force a CanvasGroup on an interactive layer — kept as ${forceClassName}. Wrap it in a plain _canvas frame instead.`,
    );
  }
  const useCanvasGroup = forceClassName
    ? false
    : forceCanvas || (opacity < 0.999 && hasChildren(node) && !isBaked(node));
  const className = forceClassName ?? (useCanvasGroup ? 'CanvasGroup' : 'Frame');
  const children: RbxNode[] = [];
  const props: Record<string, RbxValue> = baseGeometry(node, ctx);

  addFillProps(node, props, children, ctx);
  addStroke(node, children, ctx);
  addCorner(node, children, ctx);
  addShadows(node, children, ctx, false);

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
  attachLayerMeta(result, parsed);

  const childCtx: Ctx = childContext(ctx, node, parsed, {
    opacity: useCanvasGroup ? 1 : ctx.opacity * opacity,
  });
  appendChildren(node, parsed, result, childCtx, layout);
  return result;
}

function attachLayerMeta(target: RbxNode, parsed: ParsedName): void {
  if (parsed.behaviors.length > 0) target.behaviors = parsed.behaviors;
  if (parsed.controls.length > 0) target.controls = parsed.controls;
}

/**
 * Conflicting or inapplicable controls are resolved deterministically and
 * reported. Precedence: _ignore > _image > _txt / _frame > automatic.
 */
function warnControlConflicts(node: OdtNode, parsed: ParsedName, ctx: Ctx): void {
  const bake = hasControl(parsed, 'bake');

  if (bake && hasControl(parsed, 'text')) {
    ctx.warnings.push(
      `"${node.rawName}": _image and _txt conflict — _image takes precedence. Remove one tag.`,
    );
  }
  if (bake && hasControl(parsed, 'frame')) {
    ctx.warnings.push(
      `"${node.rawName}": _image and _frame conflict — _image takes precedence. Remove one tag.`,
    );
  }
  if (parsed.behaviors.some((behavior) => behavior.kind === 'nopointer')) {
    const reactive = parsed.behaviors.some(
      (behavior) => behavior.kind === 'lean' || behavior.kind === 'magnet',
    );
    if (reactive) {
      ctx.warnings.push(
        `"${node.rawName}": _nopointer cancels _lean / _magnet on the same layer. Remove one of them.`,
      );
    }
  }
  const scroll = parsed.behaviors.some((behavior) => behavior.kind === 'scroll');
  if (bake && scroll && isBaked(node)) {
    ctx.warnings.push(
      `"${node.rawName}": _image and _scroll conflict — _image takes precedence, so this layer is an image and the scroll behaviour was not applied. Remove one tag.`,
    );
  }
  if (bake && node.type !== 'TEXT' && !isBaked(node) && !hasImageFill(node)) {
    ctx.warnings.push(
      `"${node.rawName}": _image asks for this layer to be rasterized, but this export has no image for it — kept as live layers. Re-export from Figma to rasterize it.`,
    );
  }
  if (hasControl(parsed, 'frame') && !bake && isBaked(node) && node.type !== 'TEXT') {
    ctx.warnings.push(
      `"${node.rawName}": _frame cannot keep a ${node.type} as an editable Frame — this export only has a raster. Convert it to a Frame in Figma or remove _frame.`,
    );
  }
  if (hasControl(parsed, 'frame') && !bake && node.type === 'TEXT') {
    ctx.warnings.push(
      `"${node.rawName}": _frame does not apply to text layers — use _txt to keep them live.`,
    );
  }
  if (hasControl(parsed, 'text') && node.type !== 'TEXT') {
    ctx.warnings.push(
      `"${node.rawName}": _txt only affects text layers — ignored on ${node.type}. Tag the text layer itself.`,
    );
  }
  if (behaviorTarget(parsed, 'bind') !== undefined && node.type !== 'TEXT') {
    ctx.warnings.push(
      `"${node.rawName}": _bind only affects text layers — ignored on ${node.type}. Tag the text layer itself.`,
    );
  }
  if (hasControl(parsed, 'fit') && node.type !== 'TEXT') {
    ctx.warnings.push(
      `"${node.rawName}": _fit only affects text layers — ignored on ${node.type}. Tag the text layer itself.`,
    );
  }
  const bareTab = parsed.behaviors.some(
    (behavior) => (behavior.kind === 'tab' || behavior.kind === 'page') && !behavior.target,
  );
  if (bareTab && ctx.tabGroupDepth === 0) {
    ctx.warnings.push(
      `"${node.rawName}": _tab / _page without a target need a _tabgroup ancestor. Add a frame tagged _tabgroup around the tabs and pages, or write _tab:Group.`,
    );
  }
  if (
    parsed.behaviors.some((behavior) => behavior.kind === 'tabgroup') &&
    (node.type === 'TEXT' || isBaked(node))
  ) {
    ctx.warnings.push(
      `"${node.rawName}": _tabgroup must be a frame containing the tabs and pages — it was ignored on this ${node.type}.`,
    );
  }

  const hostTag = HOST_KINDS.find((kind) =>
    parsed.behaviors.some((behavior) => behavior.kind === kind),
  );
  if (hostTag && ctx.hostDepth > 0) {
    ctx.warnings.push(
      `"${node.rawName}": _${hostTag} only applies to the exported root frame — it was ignored here. Select this layer as the root, or move it to its own frame.`,
    );
  }

  if (hasControl(parsed, 'canvas')) {
    const scroll = parsed.behaviors.some((behavior) => behavior.kind === 'scroll');
    const image = hasImageFill(node) || isBaked(node);
    if (node.type === 'TEXT' || scroll || image) {
      const instead = scroll
        ? 'ScrollingFrame'
        : image
          ? 'ImageLabel or ImageButton'
          : 'TextLabel or TextButton';
      ctx.warnings.push(
        `"${node.rawName}": _canvas cannot force a CanvasGroup here — kept as ${instead}. Wrap the layer in a plain _canvas frame if the fade must apply to the group.`,
      );
    }
  }
}

function applyAspectConstraint(result: RbxNode, node: OdtNode, parsed: ParsedName, ctx: Ctx): void {
  if (!hasControl(parsed, 'aspect')) return;
  if (node.h <= EPSILON) {
    ctx.warnings.push(
      `"${node.rawName}": _aspect needs a non-zero height to compute a ratio — constraint skipped.`,
    );
    return;
  }
  result.children.push({
    className: 'UIAspectRatioConstraint',
    name: 'AspectRatio',
    figmaId: `${node.id}:aspect`,
    props: {
      AspectRatio: propNumber(node.w / node.h),
      AspectType: propEnum('AspectType', 'FitWithinMaxSize'),
      DominantAxis: propEnum('DominantAxis', 'Width'),
    },
    children: [],
  });
}

/**
 * `_hold` turns a stroke into a left-to-right fill. The stroke's gradient is
 * hidden at import and swept by the generated prompt controller.
 */
function applyHold(result: RbxNode, node: OdtNode, parsed: ParsedName, ctx: Ctx): void {
  const behavior = parsed.behaviors.find((entry) => entry.kind === 'hold');
  if (!behavior) return;

  const stroke = result.children.find((child) => child.className === 'UIStroke');
  if (!stroke) {
    ctx.warnings.push(
      `"${node.rawName}": _hold animates a UIStroke, but this layer has no stroke. Add a stroke in Figma so the prompt has something to fill.`,
    );
    return;
  }
  if (stroke.children.some((child) => child.className === 'UIGradient')) {
    ctx.warnings.push(
      `"${node.rawName}": _hold needs the stroke's gradient slot, but this stroke already has a gradient — the hold fill was not added. Use a solid stroke for the hold ring.`,
    );
    return;
  }

  let seconds = 1;
  if (behavior.target !== undefined) {
    const parsedSeconds = Number(behavior.target);
    if (Number.isFinite(parsedSeconds) && parsedSeconds > 0) {
      seconds = parsedSeconds;
    } else {
      ctx.warnings.push(
        `"${node.rawName}": _hold expects a duration in seconds (for example _hold:1.5) — using 1 s.`,
      );
    }
  }
  ctx.holdDurations.push(seconds);

  stroke.children.push({
    className: 'UIGradient',
    name: 'HoldGradient',
    figmaId: `${node.id}:hold`,
    props: {
      // ColorSequence needs at least two keypoints; white leaves the stroke's
      // own colour untouched.
      Color: {
        t: 'colorsequence',
        v: [
          { t: 0, color: [1, 1, 1], transparency: 0 },
          { t: 1, color: [1, 1, 1], transparency: 0 },
        ],
      },
      // Opaque until the very end, so sweeping the offset reveals the stroke
      // from left to right with a hard leading edge.
      Transparency: {
        t: 'numbersequence',
        v: [
          { t: 0, value: 0 },
          { t: 0.9999, value: 0 },
          { t: 1, value: 1 },
        ],
      },
      // Fully transparent at rest: the whole stroke samples the endpoint.
      Offset: { t: 'vector2', v: [1, 0] },
      Rotation: propNumber(0),
    },
    children: [],
  });
}

function convertNode(node: OdtNode, ctx: Ctx): RbxNode | undefined {
  const parsed = parseLayerName(node.rawName);

  if (hasControl(parsed, 'ignore')) return undefined;

  const state = stateKind(parsed);
  if (state && !isInteractive(parsed) && ctx.interactiveDepth === 0) {
    ctx.warnings.push(
      `"${node.rawName}": _${state} is a button state layer and needs an interactive ancestor — it was imported hidden and will never show. Put it inside a _button (or _tab / _open / _close) layer.`,
    );
  }
  for (const kind of POINTER_KINDS) {
    if (
      parsed.behaviors.some((behavior) => behavior.kind === kind) &&
      !isInteractive(parsed) &&
      ctx.interactiveDepth === 0
    ) {
      ctx.warnings.push(
        `"${node.rawName}": _${kind} reacts to the pointer and needs an interactive layer — it has no effect on a plain frame. Add _button to this layer or tag a button instead.`,
      );
    }
  }

  warnControlConflicts(node, parsed, ctx);
  warnUnsupportedEffects(node.effects, ctx.warnings, node.rawName);

  const result = convertNodeCore(node, parsed, ctx);
  if (!result) return undefined;
  applyAspectConstraint(result, node, parsed, ctx);
  applyHold(result, node, parsed, ctx);

  if (
    parsed.behaviors.some((behavior) => behavior.kind === 'select') &&
    !result.children.some((child) => child.className === 'UIStroke')
  ) {
    ctx.warnings.push(
      `"${node.rawName}": _select animates an outline, but this layer has no stroke to reveal. Add a stroke in Figma, or the selection will only set the FWSelected attributes.`,
    );
  }
  return result;
}

/**
 * `_textbox` on a container applies to its first visible direct text child.
 * Only the first one: a second text layer is usually a label, not an input.
 */
function markInheritedTextbox(node: OdtNode, parsed: ParsedName, ctx: Ctx): void {
  if (!hasControl(parsed, 'textbox') || node.type === 'TEXT') return;

  if (isBaked(node)) {
    ctx.warnings.push(
      `"${node.rawName}": _textbox cannot apply because this layer is baked as one image — kept as an image. Put _input on a live text layer or remove _image.`,
    );
    return;
  }

  const child = (node.children ?? []).find(
    (candidate) =>
      candidate.type === 'TEXT' &&
      candidate.text !== undefined &&
      candidate.visible !== false &&
      !hasControl(parseLayerName(candidate.rawName), 'ignore'),
  );

  if (!child) {
    ctx.warnings.push(
      `"${node.rawName}": _textbox found no visible direct text child — the tag did nothing. Tag the text layer itself, or add one inside this frame.`,
    );
    return;
  }
  ctx.textboxIds.add(child.id);
}

function convertNodeCore(node: OdtNode, parsed: ParsedName, ctx: Ctx): RbxNode | undefined {
  const behaviors = new Set(parsed.behaviors.map((behavior) => behavior.kind));
  const hiddenByTag =
    behaviors.has('closed') ||
    behaviors.has('page') ||
    STATE_KINDS.some((kind) => behaviors.has(kind));
  const layout = resolveLayout(node, parsed, ctx);
  markInheritedTextbox(node, parsed, ctx);

  if (behaviors.has('scroll') && !isBaked(node)) {
    const result = convertScrollingFrame(node, parsed, ctx, layout);
    if (hiddenByTag) result.props.Visible = propBoolean(false);
    return result;
  }

  if (node.type === 'TEXT' && node.text) {
    const result = convertTextNode(node, parsed, ctx);
    if (hiddenByTag) result.props.Visible = propBoolean(false);
    return result;
  }

  // Any baked layer wins over its children: the raster already contains them
  // unless they are tagged _keep.
  if (isBaked(node)) {
    const result = convertImageNode(node, parsed, ctx, true);
    if (result) {
      if (hiddenByTag) result.props.Visible = propBoolean(false);
      return result;
    }
  }

  if (hasImageFill(node)) {
    const result = convertImageNode(node, parsed, ctx, false, layout);
    if (result) {
      if (hiddenByTag) result.props.Visible = propBoolean(false);
      return result;
    }
  }

  if (node.type === 'ELLIPSE' && !hasChildren(node) && node.w === node.h) {
    const result = convertFrameNode(node, parsed, ctx, undefined, layout);
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
    const result = convertFrameNode(node, parsed, ctx, 'TextButton', layout);
    result.props.AutoButtonColor = propBoolean(false);
    if (hiddenByTag) result.props.Visible = propBoolean(false);
    return result;
  }

  const result = convertFrameNode(node, parsed, ctx, undefined, layout);
  if (hiddenByTag) result.props.Visible = propBoolean(false);
  return result;
}

/** Context for a node's children, tracking `_tabgroup` nesting. */
function childContext(
  ctx: Ctx,
  node: OdtNode,
  parsed: ParsedName,
  overrides: Partial<Ctx> = {},
): Ctx {
  const opensGroup = parsed.behaviors.some((behavior) => behavior.kind === 'tabgroup');
  return {
    ...ctx,
    parentW: node.w,
    parentH: node.h,
    tabGroupDepth: ctx.tabGroupDepth + (opensGroup ? 1 : 0),
    interactiveDepth: ctx.interactiveDepth + (isInteractive(parsed) ? 1 : 0),
    hostDepth: Math.max(ctx.hostDepth, 1),
    ...overrides,
  };
}

function convertChildren(node: OdtNode, _parsed: ParsedName, parent: RbxNode, ctx: Ctx): void {
  for (const child of node.children ?? []) {
    const converted = convertNode(child, ctx);
    if (converted) parent.children.push(converted);
  }
}

/**
 * Read the root host tag. Only one host tag may be used; the first in
 * HOST_KINDS order wins and the conflict is reported.
 */
function resolveHost(parsed: ParsedName, root: OdtNode, ctx: Ctx): RbxHost {
  const used = HOST_KINDS.filter((kind) =>
    parsed.behaviors.some((behavior) => behavior.kind === kind),
  );
  if (used.length > 1) {
    ctx.warnings.push(
      `"${root.rawName}": ${used.map((kind) => `_${kind}`).join(' and ')} conflict — only one host tag may be used. _${used[0]} takes precedence.`,
    );
  }

  const kind = used[0];
  if (!kind) return { kind: 'screen' };

  let studs = HOST_DEFAULT_STUDS[kind];
  const target = behaviorTarget(parsed, kind);
  if (target !== undefined) {
    const value = Number(target);
    if (Number.isFinite(value) && value > 0) {
      studs = value;
    } else {
      ctx.warnings.push(
        `"${root.rawName}": _${kind} expects a width in studs (for example _${kind}:12) — using ${studs}.`,
      );
    }
  }

  const aspect = root.w > EPSILON ? root.h / root.w : 1;
  const name = `${sanitizeName(parsed.name)} Anchor`;
  return {
    kind,
    studs,
    anchor: {
      name,
      // SurfaceGui stretches its canvas across the part face, so the part
      // carries the intended stud size. BillboardGui size is relative to a
      // 1×1×1 anchor.
      size: kind === 'surface' ? [studs, round(studs * aspect, 3), 0.2] : [1, 1, 1],
      // Designs carry no world coordinates; the anchor lands near the origin
      // and the importer says so.
      position: [0, 5, -10],
    },
  };
}

function promptSpec(root: OdtNode, parsed: ParsedName, ctx: Ctx): RbxNode {
  const holdDuration = ctx.holdDurations.length > 0 ? Math.max(...ctx.holdDurations) : 0;
  return {
    className: 'ProximityPrompt',
    name: `${sanitizeName(parsed.name)} Prompt`,
    figmaId: `${root.id}:prompt`,
    props: {
      Style: propEnum('ProximityPromptStyle', 'Custom'),
      ActionText: propString('Interact'),
      ObjectText: propString(sanitizeName(parsed.name)),
      HoldDuration: propNumber(holdDuration),
      MaxActivationDistance: propNumber(10),
      // Line of sight was deliberately left off: custom UI should not be
      // hidden by an intervening prop the designer cannot see in Figma.
      RequiresLineOfSight: propBoolean(false),
      KeyboardKeyCode: propEnum('KeyCode', 'E'),
      GamepadKeyCode: propEnum('KeyCode', 'ButtonX'),
      ClickablePrompt: propBoolean(true),
      Enabled: propBoolean(true),
    },
    children: [],
  };
}

/** LayerCollector properties for the chosen host. */
function screenHostProps(
  host: RbxHost,
  doc: OdtDocument,
  aspectRatio: number,
): Record<string, RbxValue> {
  const clips: Record<string, RbxValue> = doc.root.clipsContent
    ? { ClipsDescendants: propBoolean(true) }
    : {};

  if (host.kind === 'screen') {
    return {
      ResetOnSpawn: propBoolean(false),
      IgnoreGuiInset: propBoolean(true),
      ZIndexBehavior: propEnum('ZIndexBehavior', 'Sibling'),
      DisplayOrder: propNumber(1),
      Enabled: propBoolean(true),
    };
  }

  if (host.kind === 'surface') {
    return {
      Face: propEnum('NormalId', 'Front'),
      SizingMode: propEnum('SurfaceGuiSizingMode', 'FixedSize'),
      CanvasSize: { t: 'vector2', v: [round(doc.root.w), round(doc.root.h)] },
      LightInfluence: propNumber(0),
      MaxDistance: propNumber(100),
      AlwaysOnTop: propBoolean(false),
      ZIndexBehavior: propEnum('ZIndexBehavior', 'Sibling'),
      ResetOnSpawn: propBoolean(false),
      ...clips,
    };
  }

  const studs = host.studs ?? HOST_DEFAULT_STUDS.billboard;
  return {
    // Scale is relative to the 1×1×1 anchor part, so this is width × height
    // in studs.
    Size: propUdim2(studs, 0, studs / aspectRatio, 0),
    StudsOffset: propVector3(0, 0, 0),
    AlwaysOnTop: propBoolean(false),
    LightInfluence: propNumber(0),
    MaxDistance: propNumber(100),
    Brightness: propNumber(1),
    Active: propBoolean(true),
    ZIndexBehavior: propEnum('ZIndexBehavior', 'Sibling'),
    ResetOnSpawn: propBoolean(false),
    ...clips,
  };
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
    textboxIds: new Set<string>(),
    tabGroupDepth: 0,
    interactiveDepth: 0,
    hostDepth: 0,
    holdDurations: [],
  };

  const rootParsed = parseLayerName(doc.root.rawName);
  if (hasControl(rootParsed, 'ignore')) {
    throw new Error(
      `The selected root "${doc.root.rawName}" is tagged _ignore, so there is nothing to import. Remove the tag or select another frame.`,
    );
  }
  warnControlConflicts(doc.root, rootParsed, ctx);
  const host = resolveHost(rootParsed, doc.root, ctx);
  if (hasControl(rootParsed, 'list') || hasControl(rootParsed, 'grid')) {
    warnings.push(
      `"${doc.root.rawName}": _list and _grid are not supported on the root frame — kept absolute positions. Move the tag to a child frame instead.`,
    );
  }

  const rootBaked = isBaked(doc.root);
  const rootChildren: RbxNode[] = [];
  const rootProps: Record<string, RbxValue> = {
    Position: propUdim2(0, 0, 0, 0),
    Size: propUdim2(1, 0, 1, 0),
    BorderSizePixel: propNumber(0),
  };

  const childCtx: Ctx = childContext(ctx, doc.root, rootParsed, { opacity: 1 });
  markInheritedTextbox(doc.root, rootParsed, ctx);

  if (rootBaked) {
    // The whole design is one raster. Only _keep children survive as instances.
    rootProps.Image = propString(imageValue(ctx, doc.root.imageRef!));
    rootProps.ScaleType = propEnum('ScaleType', 'Stretch');
    rootProps.BackgroundTransparency = propNumber(1);
    rootProps.ImageTransparency = propNumber(0);
    for (const child of keptChildren(doc.root, ctx)) {
      const converted = convertNode(child, childCtx);
      if (converted) rootChildren.push(converted);
    }
  } else {
    addFillProps(doc.root, rootProps, rootChildren, ctx);
    addStroke(doc.root, rootChildren, ctx);
    addCorner(doc.root, rootChildren, ctx);
    addShadows(doc.root, rootChildren, ctx, false);

    if (doc.root.rotation && Math.abs(doc.root.rotation) > EPSILON) {
      // The root carries the aspect constraint; rotating it would fight the
      // constraint, so the design is imported upright and the import says so.
      warnings.push(`Root rotation on "${doc.root.rawName}" was not applied`);
    }
    if (doc.root.opacity !== undefined && doc.root.opacity < 0.999) {
      warnings.push(`Root opacity on "${doc.root.rawName}" was not applied`);
    }
    for (const child of doc.root.children ?? []) {
      const converted = convertNode(child, childCtx);
      if (converted) rootChildren.push(converted);
    }
  }

  if (doc.root.clipsContent) rootProps.ClipsDescendants = propBoolean(true);

  const aspectRatio = doc.root.h > EPSILON ? doc.root.w / doc.root.h : 1;

  const rootClassName = rootBaked
    ? isInteractive(rootParsed)
      ? 'ImageButton'
      : 'ImageLabel'
    : hasControl(rootParsed, 'canvas')
      ? 'CanvasGroup'
      : 'Frame';
  if (rootClassName === 'CanvasGroup') {
    rootProps.GroupTransparency = propNumber(0);
  }

  const rootFrame: RbxNode = {
    className: rootClassName,
    name: sanitizeName(rootParsed.name),
    figmaId: doc.root.id,
    props: rootProps,
    children: rootChildren,
  };
  attachLayerMeta(rootFrame, rootParsed);
  applyHold(rootFrame, doc.root, rootParsed, ctx);

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
    className:
      host.kind === 'surface'
        ? 'SurfaceGui'
        : host.kind === 'screen'
          ? 'ScreenGui'
          : 'BillboardGui',
    name: sanitizeName(rootParsed.name),
    figmaId: `${host.kind}:${doc.root.id}`,
    props: screenHostProps(host, doc, aspectRatio),
    children: [rootFrame],
  };

  if (host.kind === 'prompt') {
    // A custom-style prompt renders the design instead of the default popup.
    host.prompt = promptSpec(doc.root, rootParsed, ctx);
  }
  if (ctx.holdDurations.length > 0 && host.kind !== 'prompt') {
    const seconds = Math.max(...ctx.holdDurations);
    warnings.push(
      `_hold:${seconds} needs a _prompt root to drive it — this import has no ProximityPrompt, so the ring stays hidden. Tag the root with _prompt or remove _hold.`,
    );
  }

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
    host,
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
