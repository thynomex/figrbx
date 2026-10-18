import { describe, expect, it } from 'vitest';
import { convertDocument } from '../src/convert.js';
import { DEFAULT_OPTIONS, type OdtDocument, type OdtNode, validateOdt } from '../src/schema.js';

function node(overrides: Partial<OdtNode> & { id: string }): OdtNode {
  return {
    rawName: overrides.id,
    type: 'FRAME',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    ...overrides,
  };
}

function doc(root: OdtNode, images: OdtDocument['images'] = []): OdtDocument {
  return {
    version: 1,
    root,
    images,
    options: { ...DEFAULT_OPTIONS },
    meta: { name: root.rawName, width: root.w, height: root.h },
  };
}

function find(node: { className: string; children: any[] }, className: string): any | undefined {
  if (node.className === className) return node;
  for (const child of node.children) {
    const found = find(child, className);
    if (found) return found;
  }
  return undefined;
}

describe('convertDocument', () => {
  it('creates a ScreenGui with an aspect-constrained root frame', () => {
    const result = convertDocument(doc(node({ id: 'root', rawName: 'Screen', w: 1600, h: 900 })));
    expect(result.screenGui.className).toBe('ScreenGui');
    const root = result.screenGui.children[0]!;
    expect(root.className).toBe('Frame');
    expect(root.props.Size).toEqual({ t: 'udim2', v: [1, 0, 1, 0] });
    const aspect = root.children.find((child) => child.className === 'UIAspectRatioConstraint');
    expect(aspect?.props.AspectRatio).toEqual({ t: 'number', v: 1.77778 });
  });

  it('converts positions and sizes to parent-relative scale', () => {
    const child = node({ id: 'child', rawName: 'Card', x: 320, y: 90, w: 800, h: 450 });
    const result = convertDocument(doc(node({ id: 'root', w: 1600, h: 900, children: [child] })));
    const root = result.screenGui.children[0]!;
    const card = root.children[0]!;
    expect(card.props.Position).toEqual({ t: 'udim2', v: [0.2, 0, 0.1, 0] });
    expect(card.props.Size).toEqual({ t: 'udim2', v: [0.5, 0, 0.5, 0] });
  });

  it('adds UICorner with a proportional radius', () => {
    const card = node({ id: 'card', rawName: 'Card', w: 200, h: 100, cornerRadius: 20 });
    const result = convertDocument(doc(node({ id: 'root', w: 1000, h: 1000, children: [card] })));
    const root = result.screenGui.children[0]!;
    const corner = find(root, 'UICorner');
    expect(corner.props.CornerRadius).toEqual({ t: 'udim', v: [0.2, 0] });
  });

  it('emits a UIGradient with a color sequence', () => {
    const card = node({
      id: 'card',
      rawName: 'Card',
      fills: [
        {
          type: 'linear-gradient',
          angle: 90,
          stops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } },
          ],
        },
      ],
    });
    const result = convertDocument(doc(node({ id: 'root', children: [card] })));
    const gradient = find(result.screenGui, 'UIGradient');
    expect(gradient.props.Rotation).toEqual({ t: 'number', v: 90 });
    expect(gradient.props.Color.v).toHaveLength(2);
    expect(gradient.props.Color.v[1].transparency).toBe(0.5);
  });

  it('creates a UIStroke in design pixels', () => {
    const card = node({
      id: 'card',
      rawName: 'Card',
      strokeWeight: 4,
      strokes: [{ type: 'solid', color: { r: 0.1, g: 0.2, b: 0.3, a: 1 } }],
    });
    const result = convertDocument(doc(node({ id: 'root', children: [card] })));
    const stroke = find(result.screenGui, 'UIStroke');
    expect(stroke.props.Thickness).toEqual({ t: 'number', v: 4 });
    expect(stroke.props.Color.v).toEqual([0.1, 0.2, 0.3]);
  });

  it('converts text into a scaled TextLabel with a mapped font', () => {
    const label = node({
      id: 'label',
      rawName: 'Title',
      type: 'TEXT',
      text: {
        characters: 'Hello',
        fontSize: 24,
        fontFamily: 'Roboto',
        fontStyle: 'Bold',
        alignH: 'CENTER',
        alignV: 'CENTER',
        color: { r: 1, g: 1, b: 1, a: 1 },
      },
    });
    const result = convertDocument(doc(node({ id: 'root', children: [label] })));
    const text = find(result.screenGui, 'TextLabel');
    expect(text.props.Text).toEqual({ t: 'string', v: 'Hello' });
    expect(text.props.Font).toEqual({ t: 'font', name: 'Roboto' });
    expect(text.props.TextScaled).toEqual({ t: 'boolean', v: true });
    expect(text.props.TextXAlignment).toEqual({
      t: 'enum',
      enum: 'TextXAlignment',
      name: 'Center',
    });
  });

  it('turns _button text into a TextButton and _scroll into a ScrollingFrame', () => {
    const button = node({
      id: 'button',
      rawName: 'Buy_button',
      type: 'TEXT',
      text: {
        characters: 'Buy',
        fontSize: 18,
        fontFamily: 'Inter',
        fontStyle: 'Medium',
        alignH: 'CENTER',
        alignV: 'CENTER',
      },
    });
    const scroll = node({
      id: 'scroll',
      rawName: 'List_scroll',
      children: [node({ id: 'row', rawName: 'Row', y: 0, h: 100 })],
    });
    const result = convertDocument(doc(node({ id: 'root', children: [button, scroll] })));
    expect(find(result.screenGui, 'TextButton')).toBeDefined();
    const scrollFrame = find(result.screenGui, 'ScrollingFrame');
    expect(scrollFrame.props.AutomaticCanvasSize).toEqual({
      t: 'enum',
      enum: 'AutomaticSize',
      name: 'Y',
    });
  });

  it('binds {Attr} placeholders into a format string', () => {
    const label = node({
      id: 'coins',
      rawName: 'Coins: {Coins}',
      type: 'TEXT',
      text: {
        characters: 'Coins: {Coins}',
        fontSize: 18,
        fontFamily: 'Inter',
        fontStyle: 'Regular',
        alignH: 'LEFT',
        alignV: 'TOP',
      },
    });
    const result = convertDocument(doc(node({ id: 'root', children: [label] })));
    const text = find(result.screenGui, 'TextLabel');
    expect(text.bindings).toEqual(['Coins']);
    expect(text.textFormat).toBe('Coins: %s');
    // The authored placeholder stays visible until the controller binds a value.
    expect(text.props.Text).toEqual({ t: 'string', v: 'Coins: {Coins}' });
  });

  it('uses a CanvasGroup for a semi-transparent group', () => {
    const group = node({
      id: 'group',
      rawName: 'Overlay',
      type: 'GROUP',
      opacity: 0.5,
      children: [node({ id: 'child', rawName: 'Child' })],
    });
    const result = convertDocument(doc(node({ id: 'root', children: [group] })));
    const canvas = find(result.screenGui, 'CanvasGroup');
    expect(canvas.props.GroupTransparency).toEqual({ t: 'number', v: 0.5 });
  });

  it('resolves uploaded image asset ids', () => {
    const card = node({
      id: 'card',
      rawName: 'Hero',
      fills: [{ type: 'image', ref: 'img-1', scaleMode: 'fill' }],
    });
    const result = convertDocument(
      doc(node({ id: 'root', children: [card] }), [
        { ref: 'img-1', sha256: 'a'.repeat(64), name: 'hero.png', assetId: '12345' },
      ]),
    );
    const image = find(result.screenGui, 'ImageLabel');
    expect(image.props.Image).toEqual({ t: 'string', v: 'rbxassetid://12345' });
  });

  it('hides _closed and _page layers', () => {
    const panel = node({
      id: 'panel',
      rawName: 'Shop_panel_closed',
      children: [node({ id: 'page', rawName: 'Main_page:Shop' })],
    });
    const result = convertDocument(doc(node({ id: 'root', children: [panel] })));
    const root = result.screenGui.children[0]!;
    expect(root.children[0]!.props.Visible).toEqual({ t: 'boolean', v: false });
    expect(root.children[0]!.children[0]!.props.Visible).toEqual({ t: 'boolean', v: false });
  });

  it('warns about unsupported effects', () => {
    const card = node({
      id: 'card',
      rawName: 'Card',
      effects: [
        {
          type: 'drop-shadow',
          color: { r: 0, g: 0, b: 0, a: 0.3 },
          offsetX: 0,
          offsetY: 4,
          radius: 10,
        },
      ],
    });
    const result = convertDocument(doc(node({ id: 'root', children: [card] })));
    expect(result.warnings.some((warning) => warning.includes('Drop shadow'))).toBe(true);
  });
});

describe('validateOdt', () => {
  it('accepts a minimal document', () => {
    const result = validateOdt(doc(node({ id: 'root' })));
    expect(result.ok).toBe(true);
  });

  it('rejects a wrong version', () => {
    const result = validateOdt({ ...doc(node({ id: 'root' })), version: 2 });
    expect(result.ok).toBe(false);
  });

  it('rejects unknown image references', () => {
    const root = node({
      id: 'root',
      fills: [{ type: 'image', ref: 'missing', scaleMode: 'fill' }],
    });
    const result = validateOdt(doc(root));
    expect(result.ok).toBe(false);
  });
});
