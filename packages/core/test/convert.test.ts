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

function findAll(
  node: { className: string; children: any[] },
  className: string,
  found: any[] = [],
): any[] {
  if (node.className === className) found.push(node);
  for (const child of node.children) findAll(child, className, found);
  return found;
}

function textNode(
  id: string,
  rawName: string,
  { fontFamily = 'Roboto', fontSize = 24 }: { fontFamily?: string; fontSize?: number } = {},
): OdtNode {
  return node({
    id,
    rawName,
    type: 'TEXT',
    text: {
      characters: 'Hello',
      fontSize,
      fontFamily,
      fontStyle: 'Regular',
      alignH: 'LEFT',
      alignV: 'TOP',
    },
  });
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

  it('keeps the authored text size by default', () => {
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
    expect(text.props.TextSize).toEqual({ t: 'number', v: 24 });
    expect(text.props.TextScaled).toEqual({ t: 'boolean', v: false });
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

  it('keeps attr: and player binding tokens in the format string', () => {
    const label = textNode('rank', 'Rank: {attr:Rank}');
    label.text!.characters = 'Rank: {attr:Rank}';
    const result = convertDocument(doc(node({ id: 'root', children: [label] })));
    const text = find(result.screenGui, 'TextLabel');
    expect(text.bindings).toEqual(['attr:Rank']);
    expect(text.textFormat).toBe('Rank: %s');
    expect(text.props.Text).toEqual({ t: 'string', v: 'Rank: {attr:Rank}' });
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

  it('explains a bake that had no image rather than dropping the layer', () => {
    const label = node({
      id: 'label',
      rawName: 'Title',
      type: 'TEXT',
      text: {
        characters: 'Build faster',
        fontSize: 64,
        fontFamily: 'Sohne Buch',
        fontStyle: 'Bold',
        alignH: 'LEFT',
        alignV: 'TOP',
      },
    });
    const result = convertDocument(doc(node({ id: 'root', children: [label] })));

    // One warning, not two: the substitution and the missing raster are the
    // same fact from the reader's point of view.
    expect(result.warnings).toHaveLength(1);
    const warning = result.warnings[0]!;
    expect(warning).toContain('Auto mode wants "Sohne Buch" baked');
    expect(warning).toContain('GothamBold');
    expect(warning).toContain('Re-export');
    expect(find(result.screenGui, 'TextLabel').props.Text).toEqual({
      t: 'string',
      v: 'Build faster',
    });
  });

  it('reports a substituted font exactly once', () => {
    const label = node({
      id: 'label',
      rawName: 'Headline',
      type: 'TEXT',
      text: {
        characters: 'Hello',
        fontSize: 32,
        fontFamily: 'Inter',
        fontStyle: 'Bold',
        alignH: 'LEFT',
        alignV: 'TOP',
      },
    });
    const result = convertDocument(doc(node({ id: 'root', children: [label] })));
    const fontWarnings = result.warnings.filter((warning) => warning.includes('Headline'));
    expect(fontWarnings).toHaveLength(1);
    expect(fontWarnings[0]).toContain('Substituted "Inter"');
  });

  it('maps a drop shadow to a UIShadow child', () => {
    const card = node({
      id: 'card',
      rawName: 'Card',
      w: 200,
      h: 100,
      effects: [
        {
          type: 'drop-shadow',
          color: { r: 0, g: 0, b: 0, a: 0.3 },
          offsetX: 4,
          offsetY: 8,
          radius: 10,
          spread: 2,
        },
      ],
    });
    const result = convertDocument(doc(node({ id: 'root', children: [card] })));
    const shadow = find(result.screenGui, 'UIShadow');
    expect(shadow.name).toBe('DropShadow');
    expect(shadow.props.Offset).toEqual({ t: 'udim2', v: [0.02, 0, 0.08, 0] });
    expect(shadow.props.Spread).toEqual({ t: 'udim2', v: [0.01, 0, 0.02, 0] });
    expect(shadow.props.BlurRadius).toEqual({ t: 'udim', v: [0.1, 0] });
    expect(shadow.props.Color).toEqual({ t: 'color3', v: [0, 0, 0] });
    expect(shadow.props.Transparency).toEqual({ t: 'number', v: 0.7 });
    expect(shadow.props.Inset).toEqual({ t: 'boolean', v: false });
    expect(shadow.props.Mode).toEqual({
      t: 'enum',
      enum: 'ApplyShadowMode',
      name: 'Shape',
    });
    expect(result.warnings).toEqual([]);
  });

  it('maps an inner shadow with Inset and a text shadow with Mode Text', () => {
    const card = node({
      id: 'card',
      rawName: 'Card',
      effects: [
        {
          type: 'inner-shadow',
          color: { r: 0, g: 0, b: 0, a: 1 },
          offsetX: 0,
          offsetY: 0,
          radius: 4,
        },
      ],
    });
    const label = textNode('label', 'Title');
    label.effects = [
      {
        type: 'drop-shadow',
        color: { r: 0, g: 0, b: 0, a: 0.5 },
        offsetX: 0,
        offsetY: 2,
        radius: 2,
      },
    ];
    const result = convertDocument(doc(node({ id: 'root', children: [card, label] })));

    const shadows = findAll(result.screenGui, 'UIShadow');
    expect(shadows.map((shadow: any) => shadow.props.Mode.name)).toEqual(['Shape', 'Text']);
    expect(shadows[0]!.props.Inset).toEqual({ t: 'boolean', v: true });
    expect(shadows[1]!.props.Inset).toEqual({ t: 'boolean', v: false });
  });

  it('skips an inner text shadow and explains why', () => {
    const label = textNode('label', 'Title');
    label.effects = [
      {
        type: 'inner-shadow',
        color: { r: 0, g: 0, b: 0, a: 1 },
        offsetX: 0,
        offsetY: 0,
        radius: 4,
      },
    ];
    const result = convertDocument(doc(node({ id: 'root', children: [label] })));
    expect(find(result.screenGui, 'UIShadow')).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes('Inner shadow on "Title"'))).toBe(
      true,
    );
  });

  it('still warns about blur, which has no UI equivalent', () => {
    const card = node({
      id: 'card',
      rawName: 'Card',
      effects: [{ type: 'layer-blur', radius: 8 }],
    });
    const result = convertDocument(doc(node({ id: 'root', children: [card] })));
    expect(result.warnings.some((warning) => warning.includes('Blur'))).toBe(true);
  });

  it('skips _ignore subtrees without reporting their effects', () => {
    const ignored = node({
      id: 'ignored',
      rawName: 'Debug_ignore',
      effects: [{ type: 'layer-blur', radius: 8 }],
      children: [node({ id: 'inner', rawName: 'Inner' })],
    });
    const kept = node({ id: 'kept', rawName: 'Kept' });
    const result = convertDocument(
      doc(node({ id: 'root', rawName: 'Screen', children: [kept, ignored] })),
    );
    const root = result.screenGui.children[0]!;
    expect(root.children.some((child) => child.figmaId === 'ignored')).toBe(false);
    expect(root.children.some((child) => child.figmaId === 'inner')).toBe(false);
    expect(root.children.some((child) => child.figmaId === 'kept')).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('refuses to import a root tagged _ignore', () => {
    expect(() => convertDocument(doc(node({ id: 'root', rawName: 'Screen_ignore' })))).toThrow(
      /_ignore/,
    );
  });

  it('imports a _image layer as one image and skips its children', () => {
    const child = node({ id: 'inner', rawName: 'Inner' });
    const hero = node({
      id: 'hero',
      rawName: 'Hero_image',
      baked: true,
      imageRef: 'img-1',
      children: [child],
    });
    const result = convertDocument(
      doc(node({ id: 'root', children: [hero] }), [
        { ref: 'img-1', sha256: 'a'.repeat(64), name: 'hero.png', assetId: '42' },
      ]),
    );

    const image = find(result.screenGui, 'ImageLabel');
    expect(image.name).toBe('Hero');
    expect(image.props.Image).toEqual({ t: 'string', v: 'rbxassetid://42' });
    expect(image.props.ScaleType).toEqual({ t: 'enum', enum: 'ScaleType', name: 'Stretch' });
    expect(image.children.some((entry: any) => entry.figmaId === 'inner')).toBe(false);
    expect(result.warnings.some((warning) => warning.includes('without _keep'))).toBe(true);
  });

  it('lets _image win over _scroll when a raster exists', () => {
    const list = node({
      id: 'list',
      rawName: 'List_scroll_image',
      baked: true,
      imageRef: 'img-1',
    });
    const result = convertDocument(
      doc(node({ id: 'root', children: [list] }), [
        { ref: 'img-1', sha256: 'a'.repeat(64), name: 'list.png', assetId: '1' },
      ]),
    );
    expect(find(result.screenGui, 'ImageLabel')).toBeDefined();
    expect(find(result.screenGui, 'ScrollingFrame')).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes('_image and _scroll conflict'))).toBe(
      true,
    );
  });

  it('keeps _scroll when _image has no raster', () => {
    const list = node({ id: 'list', rawName: 'List_scroll_image' });
    const result = convertDocument(doc(node({ id: 'root', children: [list] })));
    expect(find(result.screenGui, 'ScrollingFrame')).toBeDefined();
    expect(result.warnings.some((warning) => warning.includes('_image asks'))).toBe(true);
  });

  it('keeps _keep children editable when the parent is baked', () => {
    const badge = node({ id: 'badge', rawName: 'Badge_keep_button' });
    const hero = node({
      id: 'hero',
      rawName: 'Hero_image',
      baked: true,
      imageRef: 'img-1',
      children: [badge],
    });
    const result = convertDocument(
      doc(node({ id: 'root', children: [hero] }), [
        { ref: 'img-1', sha256: 'a'.repeat(64), name: 'hero.png', assetId: '1' },
      ]),
    );

    const image = find(result.screenGui, 'ImageLabel');
    expect(image.children).toHaveLength(1);
    expect(image.children[0].className).toBe('TextButton');
    expect(image.children[0].name).toBe('Badge');
    expect(result.warnings.some((warning) => warning.includes('without _keep'))).toBe(false);
  });

  it('explains a forced bake that has no raster', () => {
    const card = node({
      id: 'card',
      rawName: 'Card_image',
      children: [node({ id: 'inner', rawName: 'Inner' })],
    });
    const result = convertDocument(doc(node({ id: 'root', children: [card] })));
    const root = result.screenGui.children[0]!;
    const imported = root.children.find((child) => child.figmaId === 'card')!;
    expect(imported.className).toBe('Frame');
    expect(imported.children.some((child) => child.figmaId === 'inner')).toBe(true);
    expect(
      result.warnings.some(
        (warning) => warning.includes('_image asks') && warning.includes('Re-export'),
      ),
    ).toBe(true);
  });

  it('imports a baked root as a single image', () => {
    const rootNode = node({
      id: 'root',
      rawName: 'Screen_image',
      w: 800,
      h: 400,
      baked: true,
      imageRef: 'img-1',
    });
    const result = convertDocument(
      doc(rootNode, [{ ref: 'img-1', sha256: 'a'.repeat(64), name: 'screen.png', assetId: '7' }]),
    );
    const root = result.screenGui.children[0]!;
    expect(root.className).toBe('ImageLabel');
    expect(root.props.Image).toEqual({ t: 'string', v: 'rbxassetid://7' });
    expect(root.children.some((child) => child.className === 'UIAspectRatioConstraint')).toBe(true);
  });

  it('keeps _txt live even when the text mode would bake', () => {
    const label = textNode('label', 'Title_txt', { fontFamily: 'Sohne Buch' });
    const document = doc(node({ id: 'root', children: [label] }));
    document.options = { ...document.options, textMode: 'exact' };
    const result = convertDocument(document);

    expect(find(result.screenGui, 'TextLabel')).toBeDefined();
    expect(result.warnings.some((warning) => warning.includes('baked'))).toBe(false);
  });

  it('reports an _image/_txt conflict and bakes', () => {
    const label = textNode('label', 'Title_image_txt');
    label.baked = true;
    label.imageRef = 'img-1';
    const result = convertDocument(
      doc(node({ id: 'root', children: [label] }), [
        { ref: 'img-1', sha256: 'a'.repeat(64), name: 'title.png', assetId: '1' },
      ]),
    );

    expect(find(result.screenGui, 'ImageLabel')).toBeDefined();
    expect(result.warnings.some((warning) => warning.includes('_image and _txt conflict'))).toBe(
      true,
    );
  });

  it('warns that a baked text layer loses its binding and cannot scale', () => {
    const label = textNode('label', 'Coins: {Coins}_image_fit');
    label.text!.characters = 'Coins: {Coins}';
    label.baked = true;
    label.imageRef = 'img-1';
    const result = convertDocument(
      doc(node({ id: 'root', children: [label] }), [
        { ref: 'img-1', sha256: 'a'.repeat(64), name: 'coins.png', assetId: '1' },
      ]),
    );

    expect(find(result.screenGui, 'ImageLabel')).toBeDefined();
    expect(result.warnings.some((warning) => warning.includes('binding will not update'))).toBe(
      true,
    );
    expect(result.warnings.some((warning) => warning.includes('_fit cannot scale'))).toBe(true);
  });

  it('warns when _frame is used on text', () => {
    const label = textNode('label', 'Title_frame');
    const result = convertDocument(doc(node({ id: 'root', children: [label] })));
    expect(find(result.screenGui, 'TextLabel')).toBeDefined();
    expect(result.warnings.some((warning) => warning.includes('_frame does not apply'))).toBe(true);
  });

  it('_fit opts into TextScaled and warns on non-text layers', () => {
    const label = textNode('label', 'Title_fit', { fontSize: 32 });
    const panel = node({ id: 'panel', rawName: 'Panel_fit' });
    const result = convertDocument(doc(node({ id: 'root', children: [label, panel] })));

    const text = find(result.screenGui, 'TextLabel');
    expect(text.props.TextSize).toEqual({ t: 'number', v: 32 });
    expect(text.props.TextScaled).toEqual({ t: 'boolean', v: true });
    expect(result.warnings.some((warning) => warning.includes('_fit only affects text'))).toBe(
      true,
    );
  });

  it('warns when _frame cannot un-bake a vector', () => {
    const vector = node({
      id: 'logo',
      rawName: 'Logo_frame',
      type: 'VECTOR',
      baked: true,
      imageRef: 'img-1',
    });
    const result = convertDocument(
      doc(node({ id: 'root', children: [vector] }), [
        { ref: 'img-1', sha256: 'a'.repeat(64), name: 'logo.png', assetId: '1' },
      ]),
    );
    expect(find(result.screenGui, 'ImageLabel')).toBeDefined();
    expect(result.warnings.some((warning) => warning.includes('_frame cannot keep'))).toBe(true);
  });

  it('_canvas forces a CanvasGroup at full opacity', () => {
    const panel = node({ id: 'panel', rawName: 'Panel_canvas' });
    const result = convertDocument(doc(node({ id: 'root', children: [panel] })));
    const group = find(result.screenGui, 'CanvasGroup');
    expect(group.props.GroupTransparency).toEqual({ t: 'number', v: 0 });
  });

  it('warns when _canvas cannot apply to a text layer', () => {
    const label = textNode('label', 'Title_canvas');
    const result = convertDocument(doc(node({ id: 'root', children: [label] })));
    expect(find(result.screenGui, 'TextLabel')).toBeDefined();
    expect(result.warnings.some((warning) => warning.includes('_canvas cannot force'))).toBe(true);
  });

  it('warns about a bare _tab outside any _tabgroup', () => {
    const tab = textNode('tab', 'Audio_tab');
    const result = convertDocument(doc(node({ id: 'root', children: [tab] })));
    expect(result.warnings.some((warning) => warning.includes('_tabgroup ancestor'))).toBe(true);
  });

  it('accepts a bare _tab inside a _tabgroup without warning', () => {
    const tab = textNode('tab', 'Audio_tab');
    const page = node({ id: 'page', rawName: 'Audio_page' });
    const group = node({
      id: 'group',
      rawName: 'Tabs_tabgroup',
      children: [tab, page],
    });
    const result = convertDocument(doc(node({ id: 'root', children: [group] })));

    const root = result.screenGui.children[0]!;
    const imported = root.children.find((child) => child.figmaId === 'group')!;
    expect(imported.behaviors).toEqual([{ kind: 'tabgroup' }]);
    expect(result.warnings).toEqual([]);
  });

  it('warns when _tabgroup is used on a text layer', () => {
    const label = textNode('label', 'Tabs_tabgroup');
    const result = convertDocument(doc(node({ id: 'root', children: [label] })));
    expect(result.warnings.some((warning) => warning.includes('must be a frame'))).toBe(true);
  });

  it('hides state layers and records their behaviour tags', () => {
    const hover = node({ id: 'hover', rawName: 'Glow_hover' });
    const idle = node({ id: 'idle', rawName: 'Idle_default' });
    const button = node({
      id: 'buy',
      rawName: 'Buy_button',
      children: [hover, idle],
    });
    const result = convertDocument(doc(node({ id: 'root', children: [button] })));

    const buttonNode = find(result.screenGui, 'TextButton');
    const stateNodes = buttonNode.children.filter((child: any) =>
      ['hover', 'idle'].includes(child.figmaId),
    );
    expect(stateNodes).toHaveLength(2);
    for (const stateNode of stateNodes) {
      expect(stateNode.props.Visible).toEqual({ t: 'boolean', v: false });
    }
    expect(stateNodes.map((stateNode: any) => stateNode.behaviors)).toEqual([
      [{ kind: 'hover' }],
      [{ kind: 'default' }],
    ]);
  });

  it('warns about a state layer with no interactive ancestor', () => {
    const hover = node({ id: 'hover', rawName: 'Glow_hover' });
    const result = convertDocument(doc(node({ id: 'root', children: [hover] })));
    expect(result.warnings.some((warning) => warning.includes('needs an interactive'))).toBe(true);
  });

  it('_select becomes an interactive button and needs a stroke for its outline', () => {
    const plain = node({ id: 'plain', rawName: 'Weapon_select' });
    const outlined = node({
      id: 'outlined',
      rawName: 'Armor_select',
      strokeWeight: 2,
      strokes: [{ type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } }],
    });
    const result = convertDocument(doc(node({ id: 'root', children: [plain, outlined] })));

    expect(findAll(result.screenGui, 'TextButton')).toHaveLength(2);
    expect(result.warnings.some((warning) => warning.includes('no stroke to reveal'))).toBe(true);
    const outlinedNode = findAll(result.screenGui, 'TextButton').find(
      (child: any) => child.figmaId === 'outlined',
    )!;
    expect(outlinedNode.children.some((child: any) => child.className === 'UIStroke')).toBe(true);
  });

  it('_bind replaces the whole label from a player path', () => {
    const score = textNode('score', 'Score_bind:leaderstats.Coins');
    const result = convertDocument(doc(node({ id: 'root', children: [score] })));
    const text = find(result.screenGui, 'TextLabel');

    expect(text.bindPath).toBe('leaderstats.Coins');
    expect(text.bindings).toBeUndefined();
    expect(text.textFormat).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('warns when _bind and {Attr} placeholders collide', () => {
    const score = textNode('score', 'Score {Coins}_bind:Coins');
    score.text!.characters = 'Score {Coins}';
    const result = convertDocument(doc(node({ id: 'root', children: [score] })));
    const text = find(result.screenGui, 'TextLabel');

    expect(text.bindPath).toBe('Coins');
    expect(text.bindings).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes('_bind wins'))).toBe(true);
  });

  it('warns when _bind is baked into an image', () => {
    const score = textNode('score', 'Score_bind:Coins_image');
    score.baked = true;
    score.imageRef = 'img-1';
    const result = convertDocument(
      doc(node({ id: 'root', children: [score] }), [
        { ref: 'img-1', sha256: 'a'.repeat(64), name: 'score.png', assetId: '1' },
      ]),
    );

    expect(find(result.screenGui, 'ImageLabel')).toBeDefined();
    expect(result.warnings.some((warning) => warning.includes('_bind:Coins'))).toBe(true);
  });

  it('_lean and _magnet need an interactive layer', () => {
    const plain = node({ id: 'plain', rawName: 'Card_lean_magnet' });
    const button = textNode('button', 'Card_button_lean_magnet');
    const result = convertDocument(doc(node({ id: 'root', children: [plain, button] })));

    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.every((warning) => warning.includes('needs an interactive'))).toBe(true);
  });

  it('warns that _nopointer cancels pointer effects', () => {
    const button = textNode('button', 'Card_button_lean_nopointer');
    const result = convertDocument(doc(node({ id: 'root', children: [button] })));
    expect(result.warnings.some((warning) => warning.includes('cancels _lean'))).toBe(true);
  });

  it('turns off Roblox auto button colour on interactive text', () => {
    const button = textNode('button', 'Buy_button');
    const result = convertDocument(doc(node({ id: 'root', children: [button] })));
    const node1 = find(result.screenGui, 'TextButton');
    expect(node1.props.AutoButtonColor).toEqual({ t: 'boolean', v: false });
  });

  it('hosts the design in a BillboardGui for _billboard', () => {
    const result = convertDocument(
      doc(node({ id: 'root', rawName: 'Sign_billboard:12', w: 800, h: 400 })),
    );

    expect(result.host.kind).toBe('billboard');
    expect(result.screenGui.className).toBe('BillboardGui');
    expect(result.screenGui.props.Size).toEqual({ t: 'udim2', v: [12, 0, 6, 0] });
    expect(result.host.anchor).toEqual({
      name: 'Sign Anchor',
      size: [1, 1, 1],
      position: [0, 5, -10],
    });
    expect(result.warnings).toEqual([]);
  });

  it('hosts the design in a SurfaceGui sized to the stud width', () => {
    const result = convertDocument(
      doc(node({ id: 'root', rawName: 'Panel_surface:8', w: 800, h: 400 })),
    );

    expect(result.screenGui.className).toBe('SurfaceGui');
    expect(result.screenGui.props.CanvasSize).toEqual({ t: 'vector2', v: [800, 400] });
    expect(result.screenGui.props.Face).toEqual({
      t: 'enum',
      enum: 'NormalId',
      name: 'Front',
    });
    expect(result.host.anchor?.size).toEqual([8, 4, 0.2]);
  });

  it('builds a custom ProximityPrompt for _prompt', () => {
    const ring = node({
      id: 'ring',
      rawName: 'Ring_hold:1.5',
      strokeWeight: 4,
      strokes: [{ type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } }],
    });
    const result = convertDocument(
      doc(node({ id: 'root', rawName: 'Crate_prompt:6', children: [ring] })),
    );

    expect(result.screenGui.className).toBe('BillboardGui');
    expect(result.host.kind).toBe('prompt');
    expect(result.host.prompt?.className).toBe('ProximityPrompt');
    expect(result.host.prompt?.props.Style).toEqual({
      t: 'enum',
      enum: 'ProximityPromptStyle',
      name: 'Custom',
    });
    expect(result.host.prompt?.props.HoldDuration).toEqual({ t: 'number', v: 1.5 });
    expect(result.host.prompt?.props.RequiresLineOfSight).toEqual({ t: 'boolean', v: false });
  });

  it('defaults the host width and warns about a bad one', () => {
    const bare = convertDocument(doc(node({ id: 'root', rawName: 'Sign_billboard' })));
    expect(bare.host.studs).toBe(10);

    const bad = convertDocument(doc(node({ id: 'root', rawName: 'Sign_surface:wide' })));
    expect(bad.host.studs).toBe(10);
    expect(bad.warnings.some((warning) => warning.includes('expects a width in studs'))).toBe(true);
  });

  it('warns when several host tags are used', () => {
    const result = convertDocument(doc(node({ id: 'root', rawName: 'Thing_billboard_surface:8' })));
    expect(result.host.kind).toBe('billboard');
    expect(result.warnings.some((warning) => warning.includes('conflict'))).toBe(true);
  });

  it('warns that host tags only apply to the root', () => {
    const child = node({ id: 'child', rawName: 'Inner_billboard' });
    const result = convertDocument(doc(node({ id: 'root', children: [child] })));
    expect(result.screenGui.className).toBe('ScreenGui');
    expect(result.warnings.some((warning) => warning.includes('only applies'))).toBe(true);
  });

  it('_hold adds a sweep gradient to the stroke', () => {
    const ring = node({
      id: 'ring',
      rawName: 'Ring_hold:2',
      strokeWeight: 4,
      strokes: [{ type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } }],
    });
    const result = convertDocument(
      doc(node({ id: 'root', rawName: 'Crate_prompt', children: [ring] })),
    );
    const stroke = find(result.screenGui, 'UIStroke');
    const gradient = stroke.children.find((child: any) => child.name === 'HoldGradient');

    expect(gradient).toBeDefined();
    expect(gradient.props.Offset).toEqual({ t: 'vector2', v: [1, 0] });
    expect(gradient.props.Transparency.v).toHaveLength(3);
    expect(result.warnings).toEqual([]);
  });

  it('warns when _hold has no prompt root to drive it', () => {
    const ring = node({
      id: 'ring',
      rawName: 'Ring_hold',
      strokeWeight: 4,
      strokes: [{ type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } }],
    });
    const result = convertDocument(doc(node({ id: 'root', children: [ring] })));
    expect(result.warnings.some((warning) => warning.includes('needs a _prompt root'))).toBe(true);
  });

  it('does not stack a hold gradient onto a gradient stroke', () => {
    const ring = node({
      id: 'ring',
      rawName: 'Ring_hold',
      strokeWeight: 4,
      strokes: [
        {
          type: 'linear-gradient',
          angle: 0,
          stops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
          ],
        },
      ],
    });
    const result = convertDocument(
      doc(node({ id: 'root', rawName: 'Crate_prompt', children: [ring] })),
    );
    const stroke = find(result.screenGui, 'UIStroke');
    expect(stroke.children.filter((child: any) => child.className === 'UIGradient')).toHaveLength(
      1,
    );
    expect(result.warnings.some((warning) => warning.includes('gradient slot'))).toBe(true);
  });

  it('warns when _hold has no stroke to fill', () => {
    const ring = node({ id: 'ring', rawName: 'Ring_hold' });
    const result = convertDocument(doc(node({ id: 'root', children: [ring] })));
    expect(result.warnings.some((warning) => warning.includes('has no stroke'))).toBe(true);
  });

  it('explains a malformed _hold duration', () => {
    const ring = node({
      id: 'ring',
      rawName: 'Ring_hold:soon',
      strokeWeight: 4,
      strokes: [{ type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } }],
    });
    const result = convertDocument(doc(node({ id: 'root', children: [ring] })));
    expect(result.warnings.some((warning) => warning.includes('duration in seconds'))).toBe(true);
  });

  it('makes _toggle and _exit layers interactive', () => {
    const toggle = node({ id: 'toggle', rawName: 'Toggle_toggle:Shop' });
    const exit = node({ id: 'exit', rawName: 'Exit_exit' });
    const result = convertDocument(doc(node({ id: 'root', children: [toggle, exit] })));

    const buttons = findAll(result.screenGui, 'TextButton');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.behaviors).toEqual([{ kind: 'toggle', target: 'Shop' }]);
    expect(buttons[1]!.behaviors).toEqual([{ kind: 'exit' }]);
    expect(result.warnings).toEqual([]);
  });

  it('turns a text layer into a TextBox with the drawn text as placeholder', () => {
    const field = textNode('field', 'Name_input');
    const result = convertDocument(doc(node({ id: 'root', children: [field] })));
    const box = find(result.screenGui, 'TextBox');

    expect(box.props.Text).toEqual({ t: 'string', v: '' });
    expect(box.props.PlaceholderText).toEqual({ t: 'string', v: 'Hello' });
    expect(box.props.ClearTextOnFocus).toEqual({ t: 'boolean', v: false });
    expect(box.props.Font).toEqual({ t: 'font', name: 'Roboto' });
    expect(box.props.TextSize).toEqual({ t: 'number', v: 24 });
    expect(result.warnings).toEqual([]);
  });

  it('applies _textbox on a frame to its first visible direct text child', () => {
    const first = textNode('first', 'Placeholder');
    const second = textNode('second', 'Hint');
    const field = node({
      id: 'field',
      rawName: 'Field_input',
      w: 300,
      h: 80,
      children: [first, second],
    });
    const result = convertDocument(doc(node({ id: 'root', children: [field] })));

    expect(findAll(result.screenGui, 'TextBox')).toHaveLength(1);
    expect(findAll(result.screenGui, 'TextLabel')).toHaveLength(1);
    const box = find(result.screenGui, 'TextBox');
    expect(box.figmaId).toBe('first');
  });

  it('applies a root _textbox to its first text child', () => {
    const field = textNode('field', 'Placeholder');
    const result = convertDocument(
      doc(node({ id: 'root', rawName: 'Form_input', children: [field] })),
    );
    expect(find(result.screenGui, 'TextBox')).toBeDefined();
  });

  it('warns that _bind only affects text layers', () => {
    const panel = node({ id: 'panel', rawName: 'Panel_bind:Coins' });
    const result = convertDocument(doc(node({ id: 'root', children: [panel] })));
    expect(result.warnings.some((warning) => warning.includes('_bind only affects'))).toBe(true);
  });

  it('warns that a TextBox cannot bind live values', () => {
    const field = textNode('field', 'Coins: {Coins}_input');
    field.text!.characters = 'Coins: {Coins}';
    const result = convertDocument(doc(node({ id: 'root', children: [field] })));
    const box = find(result.screenGui, 'TextBox');

    expect(box.bindings).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes('cannot bind'))).toBe(true);
  });

  it('keeps a TextBox live when a bake was requested', () => {
    const field = textNode('field', 'Name_input_image');
    field.baked = true;
    field.imageRef = 'img-1';
    const result = convertDocument(
      doc(node({ id: 'root', children: [field] }), [
        { ref: 'img-1', sha256: 'a'.repeat(64), name: 'name.png', assetId: '1' },
      ]),
    );

    expect(find(result.screenGui, 'TextBox')).toBeDefined();
    expect(find(result.screenGui, 'ImageLabel')).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes('bake was skipped'))).toBe(true);
  });

  it('warns when _textbox is combined with a button behaviour', () => {
    const field = textNode('field', 'Name_button_input');
    const result = convertDocument(doc(node({ id: 'root', children: [field] })));
    expect(find(result.screenGui, 'TextButton')).toBeDefined();
    expect(find(result.screenGui, 'TextBox')).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes('button behaviour conflict'))).toBe(
      true,
    );
  });

  it('_aspect adds a constraint to a non-root layer', () => {
    const card = node({ id: 'card', rawName: 'Card_aspect', w: 300, h: 100 });
    const result = convertDocument(doc(node({ id: 'root', children: [card] })));
    const root = result.screenGui.children[0]!;
    const imported = root.children.find((child) => child.figmaId === 'card')!;
    const aspect = imported.children.find(
      (child: any) => child.className === 'UIAspectRatioConstraint',
    )!;
    expect(aspect.props.AspectRatio).toEqual({ t: 'number', v: 3 });
  });

  function stack(rawName: string, gaps: number[] = [10, 10]) {
    let y = 10;
    const children = [0, 1, 2].map((index) => {
      const child = node({
        id: `row-${index}`,
        rawName: `Row ${index}`,
        x: 20,
        y,
        w: 200,
        h: 40,
      });
      y += 40 + (gaps[index] ?? gaps[gaps.length - 1]!);
      return child;
    });
    return node({ id: 'list', rawName, w: 300, h: 300, children });
  }

  it('_list lays children out under Items with a UIListLayout', () => {
    const result = convertDocument(doc(node({ id: 'root', children: [stack('Rows_list')] })));
    const root = result.screenGui.children[0]!;
    const list = root.children.find((child) => child.figmaId === 'list')!;
    const items = list.children.find((child: any) => child.name === 'Items')!;
    const layout: any = items.children.find((child: any) => child.className === 'UIListLayout');

    expect(items.className).toBe('Frame');
    expect(layout.props.FillDirection).toEqual({
      t: 'enum',
      enum: 'FillDirection',
      name: 'Vertical',
    });
    expect(layout.props.Padding.v[0]).toBeCloseTo(10 / 300, 5);
    expect(layout.props.HorizontalAlignment.name).toBe('Left');
    expect(layout.props.VerticalAlignment.name).toBe('Top');
    expect(layout.props.SortOrder.name).toBe('LayoutOrder');
    expect(
      items.children
        .filter((child: any) => child.className === 'Frame')
        .map((child: any) => child.props.LayoutOrder.v),
    ).toEqual([1, 2, 3]);
    expect(result.warnings).toEqual([]);
  });

  it('auto-detects an evenly spaced stack as a list', () => {
    const result = convertDocument(doc(node({ id: 'root', children: [stack('Rows')] })));
    expect(find(result.screenGui, 'UIListLayout')).toBeDefined();
    expect(
      result.warnings.some(
        (warning) => warning.includes('UIListLayout') && warning.includes('_nolist'),
      ),
    ).toBe(true);
  });

  it('_nolist keeps absolute positions', () => {
    const result = convertDocument(doc(node({ id: 'root', children: [stack('Rows_nolist')] })));
    expect(find(result.screenGui, 'UIListLayout')).toBeUndefined();
    const root = result.screenGui.children[0]!;
    const list = root.children.find((child) => child.figmaId === 'list')!;
    expect(list.children.some((child: any) => child.name === 'Items')).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('keeps absolute positions when _list gaps differ', () => {
    const result = convertDocument(
      doc(node({ id: 'root', children: [stack('Rows_list', [15, 5])] })),
    );
    expect(find(result.screenGui, 'UIListLayout')).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes('evenly spaced'))).toBe(true);
  });

  it('_grid lays cells out with a UIGridLayout', () => {
    const cells = [
      node({ id: 'c0', rawName: 'Cell 0', x: 10, y: 10, w: 80, h: 50 }),
      node({ id: 'c1', rawName: 'Cell 1', x: 100, y: 10, w: 80, h: 50 }),
      node({ id: 'c2', rawName: 'Cell 2', x: 10, y: 80, w: 80, h: 50 }),
    ];
    const grid = node({ id: 'grid', rawName: 'Cells_grid', w: 300, h: 300, children: cells });
    const result = convertDocument(doc(node({ id: 'root', children: [grid] })));
    const root = result.screenGui.children[0]!;
    const imported = root.children.find((child) => child.figmaId === 'grid')!;
    const items = imported.children.find((child: any) => child.name === 'Items')!;
    const layout: any = items.children.find((child: any) => child.className === 'UIGridLayout');

    expect(layout.props.CellSize).toEqual({ t: 'udim2', v: [0.26667, 0, 0.16667, 0] });
    expect(layout.props.CellPadding).toEqual({ t: 'udim2', v: [0.03333, 0, 0.06667, 0] });
    expect(layout.props.FillDirectionMaxCells).toEqual({ t: 'number', v: 2 });
    expect(layout.props.FillDirection.name).toBe('Horizontal');
    expect(result.warnings).toEqual([]);
  });

  it('keeps absolute positions for an irregular _grid', () => {
    const cells = [
      node({ id: 'c0', rawName: 'Cell 0', x: 10, y: 10, w: 80, h: 50 }),
      node({ id: 'c1', rawName: 'Cell 1', x: 10, y: 80, w: 80, h: 50 }),
      node({ id: 'c2', rawName: 'Cell 2', x: 100, y: 80, w: 80, h: 50 }),
    ];
    const grid = node({ id: 'grid', rawName: 'Cells_grid', w: 300, h: 300, children: cells });
    const result = convertDocument(doc(node({ id: 'root', children: [grid] })));
    expect(find(result.screenGui, 'UIGridLayout')).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes('irregular grid'))).toBe(true);
  });

  it('ignores _list on text and explains the tag is misplaced', () => {
    const label = textNode('label', 'Title_list');
    const result = convertDocument(doc(node({ id: 'root', children: [label] })));
    expect(find(result.screenGui, 'UIListLayout')).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes('_list cannot apply'))).toBe(true);
  });

  it('supports _grid on a group inside a _scroll frame', () => {
    const cells = [
      node({ id: 'c0', rawName: 'Cell 0', x: 0, y: 0, w: 80, h: 50 }),
      node({ id: 'c1', rawName: 'Cell 1', x: 90, y: 0, w: 80, h: 50 }),
      node({ id: 'c2', rawName: 'Cell 2', x: 0, y: 60, w: 80, h: 50 }),
    ];
    const grid = node({ id: 'grid', rawName: 'Cells_grid', w: 200, h: 300, children: cells });
    const scroll = node({
      id: 'scroll',
      rawName: 'List_scroll',
      w: 200,
      h: 120,
      children: [grid],
    });
    const result = convertDocument(doc(node({ id: 'root', children: [scroll] })));
    const root = result.screenGui.children[0]!;
    const scrollFrame = root.children.find((child) => child.figmaId === 'scroll')!;

    expect(scrollFrame.className).toBe('ScrollingFrame');
    const gridNode = scrollFrame.children.find((child) => child.figmaId === 'grid')!;
    const items = gridNode.children.find((child: any) => child.name === 'Items')!;
    expect(items.children.some((child: any) => child.className === 'UIGridLayout')).toBe(true);
  });

  it('warns that layouts are unsupported on the root frame', () => {
    const result = convertDocument(doc(node({ id: 'root', rawName: 'Screen_list' })));
    expect(result.warnings.some((warning) => warning.includes('not supported on the root'))).toBe(
      true,
    );
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
