# ODT — Open Design Tree

ODT is the data format that travels from the Figma plugin to the converter. It
is plain JSON: no Figma types, no Roblox types, no code. Keeping it inert means
the bridge can validate it and the Studio plugin can never be induced to run
something a design file contains.

The authoritative definition is `packages/core/src/schema.ts`. This document
explains the intent behind each part.

## Document

```jsonc
{
  "version": 1,
  "root": { /* OdtNode, usually the selected frame */ },
  "images": [
    { "ref": "img-0", "sha256": "…", "name": "hero.png", "assetId": "12345" }
  ],
  "options": { "textMode": "auto", "imageScale": 2, "strokeScale": 1 },
  "meta": { "name": "Shop", "width": 800, "height": 450 }
}
```

- `images[].ref` is the only handle nodes use to reference pixels.
- `images[].assetId` is filled in by the bridge after the upload to Roblox.
  A document without asset ids still converts; image labels resolve to
  `rbxassetid://0` and the import report lists the missing images.
- `options.textMode` is `live | exact | auto` and decides whether text layers
  are baked. See the README for the user-facing meaning.

## Node

```jsonc
{
  "id": "1:23",              // Figma node id, stable within a document
  "rawName": "Shop_button",  // authored name, behavior tags included
  "type": "FRAME",
  "x": 40, "y": 90,          // relative to the parent's top-left, design px
  "w": 200, "h": 56,
  "rotation": 0,             // degrees, clockwise, optional
  "opacity": 1,
  "visible": true,
  "clipsContent": false,
  "cornerRadius": 12,        // or [tl, tr, br, bl]
  "fills": [ /* OdtPaint */ ],
  "strokes": [ /* OdtPaint */ ],
  "strokeWeight": 2,
  "strokeAlign": "INSIDE",
  "effects": [ /* OdtEffect */ ],
  "text": { /* OdtText */ },
  "baked": false,            // pixels exported because they cannot be native
  "imageRef": "img-0",
  "children": [ /* OdtNode, bottom to top paint order */ ]
}
```

Positions are parent-relative and pre-rotation. The Figma plugin obtains them
from absolute bounding boxes and subtracts the parent origin, which means
auto-layout frames arrive with their computed layout already baked in.

`fills` and `strokes` follow Figma's convention: later entries paint on top.

## Paint

| `type` | Fields |
| --- | --- |
| `solid` | `color` |
| `linear-gradient` | `stops`, `angle` (degrees, 0 = left→right) |
| `radial-gradient` | `stops` |
| `image` | `ref`, `scaleMode` (`fill \| fit \| stretch \| tile`) |

Colours are `{ r, g, b, a }` in 0..1.

## Text

```jsonc
{
  "characters": "Coins: {Coins}",
  "fontSize": 18,
  "fontFamily": "Inter",
  "fontStyle": "Semi Bold",
  "alignH": "LEFT",
  "alignV": "CENTER",
  "lineHeight": 22,
  "letterSpacing": 0.2,
  "color": { "r": 1, "g": 1, "b": 1, "a": 1 },
  "textCase": "ORIGINAL"
}
```

`{Name}` placeholders are preserved in `characters`. The converter keeps them
in the Text property and emits a format string (`%s`) for the generated
controller, so a missing attribute is visible in Studio rather than rendering
as an empty label.

## Validation

`validateOdt` enforces:

- `version === 1`
- a root node with finite `x`, `y`, `w`, `h` and non-negative size
- unique, non-empty ids per node
- every `imageRef` and image paint `ref` exists in `images`
- tree depth ≤ 200

Anything that fails is rejected with a message naming the node or reference.
The Studio plugin additionally refuses class names outside its allow-list.
