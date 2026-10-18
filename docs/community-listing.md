# Figma Community listing

Copy for the plugin's Community page. Publish through Figma desktop:
**Plugins → Development → Manage plugins in development → figrbx → Publish**.

## Name

```
figrbx — Figma to Roblox UI
```

## Tagline

Figma's tagline field is one short line, shown under the plugin name:

```
Open-source Figma → Roblox Studio UI converter
```

54 characters. If Figma rejects the arrow, use:

```
Open-source Figma to Roblox Studio UI converter
```

## Category

**Developer tools**

Alternatives, in order of fit if that category is unavailable:

1. **Import & export** — closest to what it does mechanically
2. **Design tools** — broadest, most discoverable
3. **Productivity**

## Description

```markdown
figrbx turns a Figma frame into native Roblox Studio GUI, for free.

Select a frame, press Export, paste the six-character code into the figrbx
Roblox Studio plugin, and the design is rebuilt as real instances: Frame,
TextLabel, TextButton, ScrollingFrame, CanvasGroup, with UICorner, UIStroke and
UIGradient attached, laid out in Scale so it holds on screens you did not
design for.

WHAT YOU GET
• Positions and sizes as Scale, with a root UIAspectRatioConstraint
• Corner radii kept proportional
• Solid fills, linear gradients, strokes and opacity
• Text mapped to the closest built-in Roblox font
• Image fills and vector layers uploaded to your own Roblox account
• Behaviour from layer names: _button, _scroll, _panel, _close, _open:Name,
  _tab:Group, _page:Group, plus {Attribute} bindings for live values
• Every approximation reported in the plugin, never silently dropped

WHAT DOES NOT TRANSFER
Blend modes, auto-layout reflow, Figma constraints and backdrop blur have no
Roblox equivalent. Rotation, per-corner radii, radial gradients and drop
shadows are approximated and listed in the export report.

BOTH PLUGINS ARE OPEN SOURCE (MIT)
The Figma plugin, the converter, and the Roblox Studio plugin live at
github.com/thynomex/figrbx. Fork it, audit it, change it.

SETUP — PLEASE READ
This plugin talks to a small helper that runs on your own computer. Nothing
is sent to a server of ours. You will need:

1. Node.js 20+ and the figrbx bridge:
   `npm install -g figrbx` or run it from the repository
2. The figrbx Roblox Studio plugin (.rbxm) from the repository
3. A bridge token, printed when the bridge starts, pasted into both plugins

Images are uploaded to your own Roblox account and need either a Roblox OAuth
app or an Open Cloud API key with Assets read/write. Designs with no images
convert with no Roblox credentials at all.

figrbx is an independent project. It is not affiliated with, endorsed by, or
sponsored by Figma or Roblox.
```

## Tags

```
figma to roblox, roblox, roblox studio, roblox ui, roblox gui, converter,
game ui, rojo, luau, open source
```

## Assets to upload

| Field | Requirement | Source |
| --- | --- | --- |
| Icon | 128×128 PNG | `docs/plugin-icon.png` (create from the brand mark) |
| Cover | 1920×960 PNG | `docs/plugin-panel.png` is portrait 420×620 — a wider shot is needed |

## Review notes to include

Figma's reviewer will ask why a plugin contacts `localhost`. Answer:

> The plugin sends the selected frame to a helper the user runs on their own
> machine (`http://localhost:17341`), which converts it and uploads images to
> the user's Roblox account. No data reaches any server operated by the
> author; there is no backend. The request is declared in `networkAccess` with
> the localhost-only allowlist, and the helper binds loopback only.

## Before submitting

- [ ] `pnpm build` is current; `dist/code.js` and `dist/ui.html` exist
- [ ] Version bumped in `package.json` and `PLUGIN_VERSION` in `src/code.ts`
- [ ] The manifest `id` is the one Figma assigned if it objected to the custom
      value; re-import and confirm the plugin opens without a manifest error
- [ ] Cover image is 1920×960
- [ ] Repository is public and the README documents the bridge setup
- [ ] A support contact is set in the publish dialog
