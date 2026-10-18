import { describe, expect, it } from 'vitest';
import { convertDocument } from '../src/convert.js';
import { DEFAULT_OPTIONS, type OdtDocument, type OdtNode } from '../src/schema.js';

/**
 * Geometry invariants.
 *
 * The converter expresses layout in Scale, and the root frame carries a
 * UIAspectRatioConstraint. That combination only works if the scale values,
 * multiplied by the fitted root size, reproduce the original design pixels.
 * These tests simulate the Roblox layout pass and assert that property at
 * several viewport shapes.
 */

type Box = { x: number; y: number; w: number; h: number };

function root(): OdtNode {
  return {
    id: 'root',
    rawName: 'Screen',
    type: 'FRAME',
    x: 0,
    y: 0,
    w: 800,
    h: 450,
    children: [
      { id: 'a', rawName: 'A', type: 'FRAME', x: 40, y: 90, w: 200, h: 56 },
      { id: 'b', rawName: 'B', type: 'FRAME', x: 600, y: 20, w: 160, h: 28 },
      { id: 'c', rawName: 'C', type: 'FRAME', x: 0, y: 0, w: 800, h: 450 },
    ],
  };
}

function doc(): OdtDocument {
  return {
    version: 1,
    root: root(),
    images: [],
    options: { ...DEFAULT_OPTIONS },
  };
}

function fitWithin(designW: number, designH: number, viewportW: number, viewportH: number) {
  const scale = Math.min(viewportW / designW, viewportH / designH);
  return { w: designW * scale, h: designH * scale, scale };
}

function udim2(value: any): [number, number, number, number] {
  return value.v as [number, number, number, number];
}

function absolute(box: Box, props: Record<string, any>): Box {
  const [px, po, py, poY] = udim2(props.Position);
  const [sx, so, sy, soY] = udim2(props.Size);
  return {
    x: box.x + px * box.w + po,
    y: box.y + py * box.h + poY,
    w: sx * box.w + so,
    h: sy * box.h + soY,
  };
}

function layoutFor(viewportW: number, viewportH: number) {
  const spec = convertDocument(doc());
  const screenGui = spec.screenGui;
  const frame = screenGui.children[0]!;
  const proportional = fitWithin(800, 450, viewportW, viewportH);

  // The root frame is Size (1,1) inside a ScreenGui that the constraint keeps
  // at the design aspect ratio.
  const rootBox: Box = { x: 0, y: 0, w: proportional.w, h: proportional.h };
  const children = frame.children.filter((child) => child.className === 'Frame');
  return { spec, frame, rootBox, proportional, children };
}

describe('layout geometry', () => {
  it('pins the root to the design aspect ratio', () => {
    const { frame } = layoutFor(1920, 1080);
    expect(frame.props.Size).toEqual({ t: 'udim2', v: [1, 0, 1, 0] });
    const aspect = frame.children.find((child) => child.className === 'UIAspectRatioConstraint');
    expect(aspect?.props.AspectRatio).toEqual({ t: 'number', v: 1.77778 });
    expect(aspect?.props.AspectType).toEqual({
      t: 'enum',
      enum: 'AspectType',
      name: 'FitWithinMaxSize',
    });
  });

  it('reproduces design pixels at a 16:9 viewport', () => {
    const { rootBox, children } = layoutFor(1920, 1080);
    const a = absolute(rootBox, children[0]!.props);
    // 40/800 * 1920 = 96, 90/450 * 1080 = 216
    expect(a.x).toBeCloseTo(96, 1);
    expect(a.y).toBeCloseTo(216, 1);
    expect(a.w).toBeCloseTo(480, 1);
    expect(a.h).toBeCloseTo(134.4, 1);
  });

  it('keeps relative placement at 4:3', () => {
    const { rootBox, children } = layoutFor(1280, 960);
    // The constraint fits 16:9 inside 1280×960, so the root is 1280×720.
    expect(rootBox.w).toBeCloseTo(1280, 1);
    expect(rootBox.h).toBeCloseTo(720, 1);
    const b = absolute(rootBox, children[1]!.props);
    expect(b.x).toBeCloseTo(960, 1);
    expect(b.y).toBeCloseTo(32, 1);
    expect(b.w).toBeCloseTo(256, 1);
  });

  it('survives a portrait viewport', () => {
    const { rootBox, children } = layoutFor(720, 1280);
    // FitWithinMaxSize keeps 16:9 and letterboxes vertically: 720×405.
    expect(rootBox.w).toBeCloseTo(720, 1);
    expect(rootBox.h).toBeCloseTo(405, 1);
    const c = absolute(rootBox, children[2]!.props);
    expect(c.w).toBeCloseTo(720, 1);
    expect(c.h).toBeCloseTo(405, 1);
  });

  it('never emits an offset-based position for a design-sized layout', () => {
    const { children } = layoutFor(1920, 1080);
    for (const child of children) {
      const position = udim2(child.props.Position);
      expect(position[1]).toBe(0);
      expect(position[3]).toBe(0);
      const size = udim2(child.props.Size);
      expect(size[1]).toBe(0);
      expect(size[3]).toBe(0);
    }
  });

  it('keeps deep children relative to their parent, not the root', () => {
    const nested: OdtDocument = {
      version: 1,
      root: {
        id: 'root',
        rawName: 'Screen',
        type: 'FRAME',
        x: 0,
        y: 0,
        w: 800,
        h: 450,
        children: [
          {
            id: 'panel',
            rawName: 'Panel',
            type: 'FRAME',
            x: 400,
            y: 225,
            w: 200,
            h: 100,
            children: [
              { id: 'child', rawName: 'Child', type: 'FRAME', x: 100, y: 50, w: 50, h: 25 },
            ],
          },
        ],
      },
      images: [],
      options: { ...DEFAULT_OPTIONS },
    };
    const spec = convertDocument(nested);
    const frame = spec.screenGui.children[0]!;
    const panel = frame.children[0]!;
    const child = panel.children[0]!;
    // Child is at the centre of the panel, expressed relative to it.
    expect(child.props.Position).toEqual({ t: 'udim2', v: [0.5, 0, 0.5, 0] });
    expect(child.props.Size).toEqual({ t: 'udim2', v: [0.25, 0, 0.25, 0] });
  });
});
