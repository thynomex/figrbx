# figrbx

Turn a Figma frame into native Roblox Studio UI.

Select a frame in Figma, press **Export**, paste the six-character code into the
Studio plugin, and the design is rebuilt as `Frame`, `TextLabel`, `TextButton`,
`ScrollingFrame` and `CanvasGroup` instances with `UICorner`, `UIStroke` and
`UIGradient` attached, sized in Scale so the layout holds on other screens.

figrbx is an independent, MIT-licensed project. It is not affiliated with,
endorsed by, or derived from Framewisp, Figma, or Roblox.

## How it fits together

```
Figma plugin (TypeScript)        Local bridge (Node)                 Studio plugin (Luau)
┌───────────────────────┐  HTTP  ┌───────────────────────┐   HTTP    ┌───────────────────┐
│ read the selected      │ ─────> │ validate + convert    │ <──────── │ fetch by code     │
│ frame, export images   │        │ Roblox OAuth + upload │           │ build instances   │
│ send the design tree   │ <───── │ store revision/code   │ ────────> │ live-sync poller  │
└───────────────────────┘        └───────────────────────┘           └───────────────────┘
```

Everything runs on your machine. The bridge binds to `localhost` and talks to
Roblox only when you import images into your own account.

A static path also exists: **Download JSON** in the Figma plugin produces a
bundle the Studio plugin can import from the clipboard, with no bridge and no
network access.

## Requirements

- Node.js 20+
- pnpm 10+
- Roblox Studio (for the Studio plugin)
- Rojo 7 (only to build the Studio plugin from source)
- A Roblox account for image upload. Either:
  - an OAuth app (recommended), or
  - an Open Cloud API key with **Assets: Read and Write** (`FIGRBX_API_KEY`,
    `FIGRBX_USER_ID`)

## Quick start

```bash
pnpm install
pnpm build
pnpm dev:bridge          # prints the bridge token and listens on :17341
```

Install the Figma plugin:

1. In Figma desktop: **Plugins → Development → Import plugin from manifest…**
2. Choose `packages/figma-plugin/manifest.json`.
3. Open `dist/ui.html` after building (`pnpm --filter @figrbx/figma-plugin build`).

Studio must be allowed to make HTTP requests: **Studio Settings → Security →
Allow HTTP Requests** (the plugin talks to the bridge on loopback).

Install the Studio plugin:

```bash
pnpm build:studio        # writes studio-plugin/figrbx.rbxm
```

Drop `figrbx.rbxm` into your Roblox **Plugins** folder, or build it with Rojo
and sync `studio-plugin/default.project.json`.

## Connecting Roblox

Images (image fills, vector layers, baked text) must be uploaded to Roblox to
become `rbxassetid://` values in Studio.

### OAuth (recommended)

1. Create an OAuth 2.0 app at
   <https://create.roblox.com/dashboard/credentials>. Use the **Creation &
   Productivity Tools** category and request `asset:read` and `asset:write`.
2. Add `http://localhost:17341/oauth/callback` as a redirect URI. Roblox allows
   localhost redirects for local debugging.
3. Export the client credentials before starting the bridge:

```bash
export FIGRBX_CLIENT_ID=...        # PowerShell: $env:FIGRBX_CLIENT_ID="..."
export FIGRBX_CLIENT_SECRET=...
pnpm dev:bridge login              # opens the authorization page
```

Tokens are stored in `~/.figrbx/config.json`, mode 0600. Access tokens last 15
minutes; refresh tokens rotate on every use, and figrbx persists each rotation.

### Open Cloud API key

If you cannot register an OAuth app, set:

```bash
export FIGRBX_API_KEY=...
export FIGRBX_USER_ID=...          # numeric user id
```

The bridge then sends `x-api-key` instead of a bearer token.

Uploads are cached by SHA-256 in `~/.figrbx/images.json`, so re-importing the
same design does not re-upload anything.

## Live sync

With live sync on, the Studio plugin polls the bridge every two seconds for a
newer revision of the same code and rebuilds the imported tree when one
arrives. The rebuild replaces the ScreenGui that figrbx created; edits you made
inside that ScreenGui are not preserved. Work on your copy after you stop
syncing, or import under a new code.

## Behaviour tags

Behaviour is authored in layer names, so a design carries its own interactivity:

| Layer name | Result |
| --- | --- |
| `Shop_button` | `TextButton` with hover and press state |
| `List_scroll` | `ScrollingFrame` with automatic canvas size |
| `Settings_panel` | panel root, toggled by `_open` / `_close` |
| `Close_close` | hides the nearest `_panel` ancestor |
| `OpenShop_open:Shop` | toggles the panel named `Shop` |
| `Tab1_tab:Weapons` | tab button |
| `PageA_page:Weapons` | page shown while tab group `Weapons` is active |
| `Coins: {Coins}` | binds the text to the ScreenGui attribute `Coins` |
| `Shop_panel_closed` | panel starts hidden |

Tags are stripped from the final instance names. A `LocalScript` named
`figrbx_controller` is generated only when at least one tag or binding exists.
Unknown underscore-prefixed words are left alone.

## What transfers, and what does not

Transfers: positions and sizes (Scale), corner radii (proportional), solid
fills, linear gradients, strokes, opacity, clipping, rotation, text (mapped to
the closest built-in font), image fills, text bindings, behavior tags.

Does not transfer, by design of the Roblox UI API:

- blend modes
- auto-layout reflow (positions are baked, not reflowing)
- Figma constraints
- backdrop blur
- inner shadows and drop shadows (reported as warnings)
- per-corner radii (collapsed to the smallest radius, reported)
- radial gradients (approximated with a linear gradient, reported)
- `UIStroke.Thickness` is in pixels, so a stroke does not scale with the frame
- root rotation and root opacity (the aspect constraint owns the root)

Every approximation appears in the import report in both plugins. Nothing is
silently dropped.

### Text handling

The Figma plugin offers three modes:

- **Auto** (default) — bake only fonts with no known Roblox counterpart.
- **Live** — always keep editable text, in the closest built-in font.
- **Exact** — bake every text layer whose font or style Roblox cannot match.

Baked layers become `ImageLabel`s at 2× scale.

## Repository layout

```
packages/core          ODT schema, converter, font map, tag parser (pure TS)
packages/bridge        local HTTP bridge, OAuth, Roblox asset upload
packages/figma-plugin  Figma side: selection serialization + UI
studio-plugin          Rojo project for the Studio plugin (Luau)
tests/behaviors        generates the controller source and syntax-checks it
```

## Development

```bash
pnpm test            # core + bridge unit tests
pnpm typecheck       # all TypeScript packages
pnpm lint            # Biome
pnpm build           # core, bridge, Figma plugin
pnpm build:studio    # Rojo model build
```

The Studio controller generator is verified outside Studio:

```bash
lune run tests/behaviors/generate.luau
selene tests/behaviors/generated_controller.luau
selene studio-plugin/src
```

## Security notes

- The bridge binds loopback only and requires a bearer token generated on first
  run. `/api/health` is intentionally unauthenticated so both plugins can
  discover the bridge before a token is pasted; it exposes no secrets.
- Documents are validated structurally before conversion; unknown fields and
  unknown classes are rejected or skipped, never executed.
- The Studio plugin only instantiates classes on an allow-list and applies
  properties with `pcall`, so one bad value cannot abort an import.

## License

MIT. See [LICENSE](LICENSE).
