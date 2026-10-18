/**
 * Figma sandbox entry point.
 *
 * Reads the selected frame, converts it into the serializable ODT format
 * defined in @figrbx/core, and hands the document plus rasterized layers to
 * the UI, which owns all network traffic. Nothing here reaches the network.
 */

import { type FontMatch, resolveFont, shouldBakeText } from '@figrbx/core';
import type {
  OdtDocument,
  OdtEffect,
  OdtGradientStop,
  OdtImage,
  OdtNode,
  OdtNodeType,
  OdtPaint,
  OdtText,
} from '@figrbx/core';

type Settings = {
  bridgeUrl: string;
  token: string;
  textMode: 'live' | 'exact' | 'auto';
  liveSync: boolean;
};

type ImagePayload = {
  ref: string;
  name: string;
  mime: string;
  dataBase64: string;
};

type ExportPayload = {
  type: 'export-payload';
  odt: OdtDocument;
  images: ImagePayload[];
  truncated: boolean;
};

const DEFAULT_SETTINGS: Settings = {
  bridgeUrl: 'http://127.0.0.1:17341',
  token: '',
  textMode: 'auto',
  liveSync: false,
};

const MAX_NODES = 5000;
const MAX_IMAGES = 1000;

let settings: Settings = { ...DEFAULT_SETTINGS };
let liveSyncTimer: ReturnType<typeof setTimeout> | null = null;
let exporting = false;

figma.showUI(__html__, { width: 420, height: 620, themeColors: true });
figma.skipInvisibleInstanceChildren = true;

function post(message: unknown): void {
  figma.ui.postMessage(message);
}

function fail(message: string): void {
  post({ type: 'error', message });
}

async function boot(): Promise<void> {
  const stored = (await figma.clientStorage.getAsync('figrbx-settings')) as
    | Partial<Settings>
    | undefined;
  settings = { ...DEFAULT_SETTINGS, ...stored };
  const selection = figma.currentPage.selection;
  post({
    type: 'boot',
    settings,
    selection: selection.length === 1 ? describeSelection(selection[0]!) : null,
    selectionCount: selection.length,
    filename: figma.root.name,
  });
}

function describeSelection(node: SceneNode): {
  name: string;
  type: string;
  width: number;
  height: number;
} {
  return {
    name: node.name,
    type: node.type,
    width: 'width' in node ? node.width : 0,
    height: 'height' in node ? node.height : 0,
  };
}

class ExportCounter {
  nodes = 0;
  images = 0;
  truncated = false;
}

function base64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const chunk = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    output +=
      alphabet[(chunk >> 18) & 63]! +
      alphabet[(chunk >> 12) & 63]! +
      alphabet[(chunk >> 6) & 63]! +
      alphabet[chunk & 63]!;
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const chunk = bytes[i]! << 16;
    output += `${alphabet[(chunk >> 18) & 63]!}${alphabet[(chunk >> 12) & 63]!}==`;
  } else if (remaining === 2) {
    const chunk = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    output += `${alphabet[(chunk >> 18) & 63]!}${alphabet[(chunk >> 12) & 63]!}${alphabet[(chunk >> 6) & 63]!}=`;
  }
  return output;
}

function detectMime(bytes: Uint8Array): string {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    return 'image/webp';
  }
  return 'image/png';
}

function mapNodeType(type: SceneNode['type']): OdtNodeType {
  switch (type) {
    case 'FRAME':
    case 'SECTION':
    case 'COMPONENT':
    case 'COMPONENT_SET':
      return 'FRAME';
    case 'GROUP':
      return 'GROUP';
    case 'RECTANGLE':
      return 'RECTANGLE';
    case 'ELLIPSE':
      return 'ELLIPSE';
    case 'TEXT':
      return 'TEXT';
    case 'VECTOR':
    case 'STAR':
    case 'POLYGON':
      return 'VECTOR';
    case 'LINE':
      return 'LINE';
    case 'INSTANCE':
      return 'INSTANCE';
    case 'BOOLEAN_OPERATION':
      return 'BOOLEAN_OPERATION';
    default:
      return 'OTHER';
  }
}

function hasImageFill(paints: readonly Paint[] | PluginAPI['mixed'] | undefined): boolean {
  if (!paints || paints === figma.mixed) return false;
  return paints.some((paint) => paint.type === 'IMAGE' && paint.visible !== false);
}

function hasGradientFill(paints: readonly Paint[] | PluginAPI['mixed'] | undefined): boolean {
  if (!paints || paints === figma.mixed) return false;
  return paints.some(
    (paint) =>
      paint.visible !== false &&
      (paint.type === 'GRADIENT_LINEAR' ||
        paint.type === 'GRADIENT_RADIAL' ||
        paint.type === 'GRADIENT_ANGULAR' ||
        paint.type === 'GRADIENT_DIAMOND'),
  );
}

function rgba(
  color: { r: number; g: number; b: number; a?: number },
  opacity = 1,
): { r: number; g: number; b: number; a: number } {
  const alpha = typeof color.a === 'number' ? color.a : 1;
  return { r: color.r, g: color.g, b: color.b, a: alpha * opacity };
}

function gradientAngle(transform: Transform | null): number {
  if (!transform) return 0;
  const angle = (Math.atan2(transform[1][0], transform[0][0]) * 180) / Math.PI;
  return Math.round(angle * 1000) / 1000;
}

function gradientStops(stops: readonly ColorStop[]): OdtGradientStop[] {
  return stops.map((stop) => ({ position: stop.position, color: rgba(stop.color) }));
}

async function serializePaint(
  paint: Paint,
  node: SceneNode,
  images: ImagePayload[],
  odtImages: OdtImage[],
  counter: ExportCounter,
): Promise<OdtPaint | undefined> {
  if (paint.visible === false) return undefined;

  if (paint.type === 'SOLID') {
    return { type: 'solid', color: rgba(paint.color, paint.opacity ?? 1), opacity: 1 };
  }
  if (paint.type === 'GRADIENT_LINEAR') {
    return {
      type: 'linear-gradient',
      stops: gradientStops(paint.gradientStops),
      angle: gradientAngle(paint.gradientTransform),
      opacity: paint.opacity ?? 1,
    };
  }
  if (
    paint.type === 'GRADIENT_RADIAL' ||
    paint.type === 'GRADIENT_ANGULAR' ||
    paint.type === 'GRADIENT_DIAMOND'
  ) {
    return {
      type: 'radial-gradient',
      stops: gradientStops(paint.gradientStops),
      opacity: paint.opacity ?? 1,
    };
  }
  if (paint.type === 'IMAGE') {
    if (counter.images >= MAX_IMAGES) {
      counter.truncated = true;
      return undefined;
    }
    const ref = `img-${counter.images++}`;
    let bytes: Uint8Array | null = null;
    if (paint.imageHash) {
      try {
        const image = figma.getImageByHash(paint.imageHash);
        bytes = image ? await image.getBytesAsync() : null;
      } catch {
        bytes = null;
      }
    }
    if (bytes && bytes.length <= 19 * 1024 * 1024) {
      const mime = detectMime(bytes);
      images.push({
        ref,
        name: `${sanitizeFileName(node.name)}.${extensionFor(mime)}`,
        mime,
        dataBase64: base64(bytes),
      });
    } else {
      // Source image is unavailable or too large for the Assets API: bake the
      // layer instead so the design still comes across.
      const exported = await node.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: 1 },
      });
      images.push({
        ref,
        name: `${sanitizeFileName(node.name)}.png`,
        mime: 'image/png',
        dataBase64: base64(exported),
      });
    }
    odtImages.push({ ref, sha256: '', name: `${sanitizeFileName(node.name)}.png` });
    const scaleMode =
      paint.scaleMode === 'FILL'
        ? 'fill'
        : paint.scaleMode === 'FIT'
          ? 'fit'
          : paint.scaleMode === 'TILE'
            ? 'tile'
            : 'fill';
    return { type: 'image', ref, scaleMode, opacity: paint.opacity ?? 1 };
  }
  return undefined;
}

function extensionFor(mime: string): string {
  return mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
}

function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9 _-]/g, '')
      .trim()
      .slice(0, 40) || 'layer'
  );
}

async function serializePaints(
  paints: readonly Paint[] | PluginAPI['mixed'] | undefined,
  node: SceneNode,
  images: ImagePayload[],
  odtImages: OdtImage[],
  counter: ExportCounter,
): Promise<OdtPaint[] | undefined> {
  if (!paints || paints === figma.mixed) return undefined;
  const result: OdtPaint[] = [];
  for (const paint of paints) {
    const serialized = await serializePaint(paint, node, images, odtImages, counter);
    if (serialized) result.push(serialized);
  }
  return result.length > 0 ? result : undefined;
}

function serializeEffects(node: SceneNode): OdtEffect[] | undefined {
  const effects = 'effects' in node ? node.effects : undefined;
  if (!effects || effects.length === 0) return undefined;
  const result: OdtEffect[] = [];
  for (const effect of effects) {
    if (effect.type === 'DROP_SHADOW') {
      result.push({
        type: 'drop-shadow',
        color: rgba(effect.color),
        offsetX: effect.offset.x,
        offsetY: effect.offset.y,
        radius: effect.radius,
        spread: effect.spread,
      });
    } else if (effect.type === 'INNER_SHADOW') {
      result.push({
        type: 'inner-shadow',
        color: rgba(effect.color),
        offsetX: effect.offset.x,
        offsetY: effect.offset.y,
        radius: effect.radius,
        spread: effect.spread,
      });
    } else if (effect.type === 'LAYER_BLUR') {
      result.push({ type: 'layer-blur', radius: effect.radius });
    } else if (effect.type === 'BACKGROUND_BLUR') {
      result.push({ type: 'background-blur', radius: effect.radius });
    }
  }
  return result.length > 0 ? result : undefined;
}

function cornerRadii(node: SceneNode): number | [number, number, number, number] | undefined {
  const candidate = node as any;
  const values = [
    candidate.topLeftRadius,
    candidate.topRightRadius,
    candidate.bottomRightRadius,
    candidate.bottomLeftRadius,
  ];
  if (values.every((value) => typeof value === 'number')) {
    const [tl, tr, br, bl] = values as number[];
    if (new Set(values.map((value) => Math.round(value as number))).size === 1) return tl;
    return [tl!, tr!, br!, bl!];
  }
  const radius = candidate.cornerRadius;
  return typeof radius === 'number' && radius > 0 ? radius : undefined;
}

function fontForText(node: TextNode): FontName {
  if (node.characters.length === 0) return { family: 'Inter', style: 'Regular' };
  const font = node.fontName;
  if (font === figma.mixed) {
    try {
      return node.getRangeFontName(0, 1) as FontName;
    } catch {
      return { family: 'Inter', style: 'Regular' };
    }
  }
  return font;
}

function fontSizeForText(node: TextNode): number {
  const size = node.fontSize;
  if (size === figma.mixed) {
    try {
      const value = node.getRangeFontSize(0, 1);
      return typeof value === 'number' ? value : 16;
    } catch {
      return 16;
    }
  }
  return size;
}

function lineHeightPx(node: TextNode, fontSize: number): number | undefined {
  const height = node.lineHeight;
  if (height === figma.mixed || height.unit === 'AUTO') return undefined;
  return height.unit === 'PIXELS' ? height.value : (height.value / 100) * fontSize;
}

function letterSpacingPx(node: TextNode, fontSize: number): number | undefined {
  const spacing = node.letterSpacing;
  if (spacing === figma.mixed) return undefined;
  return spacing.unit === 'PIXELS' ? spacing.value : (spacing.value / 100) * fontSize;
}

function textColor(node: TextNode): { r: number; g: number; b: number; a: number } | undefined {
  const fills = node.fills;
  const paint =
    fills === figma.mixed
      ? undefined
      : [...fills].reverse().find((fill) => fill.visible !== false && fill.type === 'SOLID');
  if (paint && paint.type === 'SOLID') return rgba(paint.color, paint.opacity ?? 1);
  return undefined;
}

async function serializeText(node: TextNode, ctx: Ctx, bake: boolean): Promise<OdtNode> {
  let imageRef: string | undefined;
  if (bake) {
    if (ctx.counter.images >= MAX_IMAGES) {
      ctx.counter.truncated = true;
    } else {
      imageRef = `img-${ctx.counter.images++}`;
      const png = await node.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: ctx.imageScale },
      });
      ctx.images.push({
        ref: imageRef,
        name: `${sanitizeFileName(node.name)}.png`,
        mime: 'image/png',
        dataBase64: base64(png),
      });
      ctx.odtImages.push({ ref: imageRef, sha256: '', name: `${sanitizeFileName(node.name)}.png` });
    }
  }

  const fontSize = fontSizeForText(node);
  const font = fontForText(node);
  const rawCase = node.textCase === figma.mixed ? undefined : node.textCase;
  // Roblox has no small-caps control; the text stays as authored.
  const textCase =
    rawCase === 'UPPER' || rawCase === 'LOWER' || rawCase === 'TITLE' || rawCase === 'ORIGINAL'
      ? rawCase
      : undefined;

  const text: OdtText = {
    characters: node.characters,
    fontSize,
    fontFamily: font.family,
    fontStyle: font.style,
    alignH: node.textAlignHorizontal,
    alignV: node.textAlignVertical,
    lineHeight: lineHeightPx(node, fontSize),
    letterSpacing: letterSpacingPx(node, fontSize),
    color: textColor(node),
    textCase: textCase ?? undefined,
    textDecoration: node.textDecoration === figma.mixed ? undefined : node.textDecoration,
  };

  return {
    ...baseNode(node),
    type: 'TEXT',
    text,
    baked: bake && Boolean(imageRef),
    imageRef,
  };
}

function baseNode(
  node: SceneNode,
): Pick<OdtNode, 'id' | 'rawName' | 'x' | 'y' | 'w' | 'h' | 'rotation' | 'opacity' | 'visible'> {
  const candidate = node as any;
  const width = typeof candidate.width === 'number' ? candidate.width : 0;
  const height = typeof candidate.height === 'number' ? candidate.height : 0;
  const x = typeof candidate.x === 'number' ? candidate.x : 0;
  const y = typeof candidate.y === 'number' ? candidate.y : 0;
  return {
    id: node.id,
    rawName: node.name,
    x,
    y,
    w: width,
    h: height,
    rotation:
      typeof candidate.rotation === 'number' && Math.abs(candidate.rotation) > 0.001
        ? candidate.rotation
        : undefined,
    opacity: typeof candidate.opacity === 'number' ? candidate.opacity : undefined,
    visible: node.visible,
  };
}

type Ctx = {
  images: ImagePayload[];
  odtImages: OdtImage[];
  counter: ExportCounter;
  textMode: 'live' | 'exact' | 'auto';
  imageScale: number;
};

function isContainer(node: SceneNode): boolean {
  return 'children' in node && Array.isArray((node as any).children);
}

function shouldBakeNode(node: SceneNode): boolean {
  switch (node.type) {
    case 'VECTOR':
    case 'BOOLEAN_OPERATION':
    case 'STAR':
    case 'POLYGON':
    case 'LINE':
      return true;
    case 'ELLIPSE': {
      const candidate = node as any;
      return Math.abs((candidate.width ?? 0) - (candidate.height ?? 0)) > 0.5;
    }
    default:
      return false;
  }
}

async function serializeNode(node: SceneNode, ctx: Ctx, isRoot = false): Promise<OdtNode> {
  ctx.counter.nodes += 1;
  if (ctx.counter.nodes > MAX_NODES) {
    ctx.counter.truncated = true;
  }

  if (shouldBakeNode(node)) {
    const imageRef = `img-${ctx.counter.images++}`;
    if (ctx.counter.images >= MAX_IMAGES) ctx.counter.truncated = true;
    const png = await node.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: ctx.imageScale },
    });
    ctx.images.push({
      ref: imageRef,
      name: `${sanitizeFileName(node.name)}.png`,
      mime: 'image/png',
      dataBase64: base64(png),
    });
    ctx.odtImages.push({ ref: imageRef, sha256: '', name: `${sanitizeFileName(node.name)}.png` });
    const baked: OdtNode = {
      ...baseNode(node),
      type: mapNodeType(node.type),
      baked: true,
      imageRef,
    };
    if (isRoot) {
      baked.x = 0;
      baked.y = 0;
    }
    return baked;
  }

  if (node.type === 'TEXT') {
    const font = fontForText(node);
    const match = resolveFont(font.family, font.style);
    const complexFill = hasImageFill(node.fills) || hasGradientFill(node.fills);
    const bake = complexFill || shouldBakeText(ctx.textMode, match);
    const result = await serializeText(node, ctx, bake);
    if (isRoot) {
      result.x = 0;
      result.y = 0;
    }
    return result;
  }

  const paints = 'fills' in node ? (node as any).fills : undefined;
  const strokePaints = 'strokes' in node ? (node as any).strokes : undefined;
  const fills = await serializePaints(paints, node, ctx.images, ctx.odtImages, ctx.counter);
  const strokes = await serializePaints(strokePaints, node, ctx.images, ctx.odtImages, ctx.counter);

  const result: OdtNode = {
    ...baseNode(node),
    type: mapNodeType(node.type),
    fills,
    strokes,
    effects: serializeEffects(node),
    cornerRadius: cornerRadii(node),
  };

  if (isRoot) {
    result.x = 0;
    result.y = 0;
  }

  const candidate = node as any;
  if (typeof candidate.strokeWeight === 'number' && candidate.strokeWeight > 0) {
    result.strokeWeight = candidate.strokeWeight;
    if (candidate.strokeAlign) result.strokeAlign = candidate.strokeAlign;
  }
  if (typeof candidate.clipsContent === 'boolean') result.clipsContent = candidate.clipsContent;

  if (isContainer(node) && ctx.counter.nodes <= MAX_NODES) {
    const children: OdtNode[] = [];
    for (const child of (node as any).children as SceneNode[]) {
      if (child.type === 'SLICE') continue;
      children.push(await serializeNode(child, ctx));
    }
    if (children.length > 0) result.children = children;
  }

  // An instance whose internals are not exposed would otherwise import as an
  // empty frame; baking preserves what the user sees.
  if (node.type === 'INSTANCE' && (!result.children || result.children.length === 0)) {
    const imageRef = `img-${ctx.counter.images++}`;
    const png = await node.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: ctx.imageScale },
    });
    ctx.images.push({
      ref: imageRef,
      name: `${sanitizeFileName(node.name)}.png`,
      mime: 'image/png',
      dataBase64: base64(png),
    });
    ctx.odtImages.push({ ref: imageRef, sha256: '', name: `${sanitizeFileName(node.name)}.png` });
    result.baked = true;
    result.imageRef = imageRef;
  }

  return result;
}

/** Serialize the current selection exactly once, including image bytes. */
async function buildExport(): Promise<ExportPayload> {
  const selection = figma.currentPage.selection;
  if (selection.length !== 1) {
    throw new Error(
      selection.length === 0 ? 'Select a frame to export.' : 'Select exactly one frame to export.',
    );
  }
  const selected = selection[0]!;
  if (selected.type === 'SLICE') throw new Error('Slices cannot be exported.');

  const counter = new ExportCounter();
  const ctx: Ctx = {
    images: [],
    odtImages: [],
    counter,
    textMode: settings.textMode,
    imageScale: 2,
  };

  let root: OdtNode;
  if (isContainer(selected)) {
    root = await serializeNode(selected, ctx, true);
  } else {
    const inner = await serializeNode(selected, ctx);
    inner.x = 0;
    inner.y = 0;
    const box = baseNode(selected);
    root = {
      id: `wrapper:${selected.id}`,
      rawName: selected.name,
      type: 'FRAME',
      x: 0,
      y: 0,
      w: box.w,
      h: box.h,
      children: [inner],
    };
  }

  const document: OdtDocument = {
    version: 1,
    root,
    images: ctx.odtImages,
    options: { textMode: settings.textMode, imageScale: 2, strokeScale: 1 },
    meta: {
      name: selected.name,
      width: root.w,
      height: root.h,
      source: `figma:${figma.root.name}`,
      exportedAt: new Date().toISOString(),
    },
  };

  return {
    type: 'export-payload',
    odt: document,
    images: ctx.images,
    truncated: counter.truncated,
  };
}

async function runExport(live = false): Promise<void> {
  if (exporting) return;
  exporting = true;
  try {
    post({ type: 'progress', stage: 'serialize', message: 'Reading the selected frame…' });
    const payload = await buildExport();
    post({
      type: 'progress',
      stage: 'images',
      message: `Prepared ${payload.odt.images.length} image${payload.odt.images.length === 1 ? '' : 's'}…`,
    });
    post({ type: 'progress', stage: 'send', message: 'Sending to the bridge…' });
    post({ ...payload, live });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    exporting = false;
  }
}

figma.ui.onmessage = async (message: any) => {
  try {
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'save-settings') {
      settings = { ...settings, ...message.settings };
      await figma.clientStorage.setAsync('figrbx-settings', settings);
      post({ type: 'settings-saved', settings });
      return;
    }

    if (message.type === 'export') {
      await runExport(false);
      return;
    }

    if (message.type === 'set-live-sync') {
      settings.liveSync = Boolean(message.enabled);
      await figma.clientStorage.setAsync('figrbx-settings', settings);
      return;
    }

    if (message.type === 'notify') {
      figma.notify(String(message.message ?? ''), { timeout: 4000 });
      return;
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
};

figma.on('selectionchange', () => {
  const selection = figma.currentPage.selection;
  post({
    type: 'selection',
    selection: selection.length === 1 ? describeSelection(selection[0]!) : null,
    selectionCount: selection.length,
  });
});

figma.on('documentchange', () => {
  if (!settings.liveSync) return;
  if (liveSyncTimer) clearTimeout(liveSyncTimer);
  liveSyncTimer = setTimeout(() => {
    liveSyncTimer = null;
    post({ type: 'document-changed' });
  }, 700);
});

boot().catch((error) => fail(error instanceof Error ? error.message : String(error)));
