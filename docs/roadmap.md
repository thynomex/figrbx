# Roadmap: closing the gap with the commercial converter

This document is the handoff for continuing figrbx in a fresh session. It
records what exists, what is missing, and the order that avoids rework.

Status at the time of writing: **v0.1.0**, pipeline proven end to end against
real Figma and Roblox Studio. Phases A–E are implemented; Phases F–H remain:
114 core tests, 23 bridge tests, Luau lint clean.

### What is left, in order

1. **F2 — non-destructive re-import.** The only remaining item that can destroy
   user work today: `Materialize.run` deletes the whole GUI before rebuilding.
2. **F1 — group uploads.** Needs a group id in config and an Open Cloud key
   whose creator is that group.
3. **F3–F5 — pairing, auto-sync, delivery confirmation.** Small bridge and
   plugin work once F2 makes re-import safe.
4. **F6 — Roblox → Figma.** Largest single feature; do it after F2.
5. **Phase G — animation runtime.** Largest phase by far; see the batching
   table. The generated controller is already ~15 KB, so keep the section
   delimiters and consider splitting helpers before adding all of G.
6. **Phase H — authoring UX.**
7. **D2 / D3** — remove the placeholder manifest id before publishing; decide
   whether to compile the bridge into one executable.

### Known deviations from the original plan

- **Billboard self-contained mode was dropped.** A `LocalScript` inside a
  Workspace GUI does not run, so a billboard parented to the Part cannot drive
  the behaviors. World hosts always live in `StarterGui` with `Adornee` set.
- **Anchor placement is fixed** at `(0, 5, -10)`. Figma designs carry no world
  coordinates; the user moves the anchor after import.
- **`_surface` always uses `SizingMode = FixedSize`.** `PixelsPerStud` is not
  offered.
- **Older Studio builds** skip `UIShadow` / layout classes rather than
  emulating them (`Instance.new` is wrapped in `pcall`).

---

## 1. Architecture you inherit

```
Figma plugin (TS, sandbox)  →  bridge (Node, loopback)  →  Studio plugin (Luau)
   serializes ODT                validates + converts         materializes
```

### The three layers

| Layer | Entry point | Rule |
| --- | --- | --- |
| `packages/core` | `convertDocument(doc)` in `src/convert.ts` | Pure. No I/O. Testable in Node. |
| `packages/bridge` | `createApp()` in `src/server.ts` | Loopback only, bearer token. |
| `studio-plugin` | `Materialize.run(spec, code)` in `src/materialize.luau` | Allow-listed classes, `pcall` property apply. |

### The data flow

1. `code.ts` walks `figma.currentPage.selection[0]` and produces an **ODT**
   document (`packages/core/src/schema.ts`).
2. The bridge converts ODT into an **RbxDocument**: a typed tree of class names
   and encoded property values (`RbxValue` in `convert.ts`).
3. `materialize.luau` creates instances from that tree; `props.luau` decodes
   each value; `behaviors.luau` generates the controller `LocalScript`.

### Key types

```ts
type RbxValue =
  | { t: 'udim2'; v: [xs, xo, ys, yo] }
  | { t: 'udim'; v: [scale, offset] }
  | { t: 'color3'; v: [r, g, b] }
  | { t: 'number' | 'string' | 'boolean'; v: ... }
  | { t: 'enum'; enum: string; name: string }
  | { t: 'font'; name: string }
  | { t: 'colorsequence'; v: ColorSequencePoint[] }
  | { t: 'numbersequence'; v: NumberSequencePoint[] }
  | { t: 'vector2'; v: [x, y] }
  | { t: 'vector3'; v: [x, y, z] };
```

Any new property type must be added here **and** in `props.luau`'s `decode`.
Anything not in that union will throw at import time. `RbxNode.controls` carries
parsed control tags (for example `_nodim`) that later runtime phases will read;
the Studio plugin ignores fields it does not know.

### Conversion invariants

- Child geometry is `Position = (x/parentW, 0, y/parentH, 0)`, size likewise.
  Offsets stay 0 so the layout scales.
- The root frame is `Size = (1,0,1,0)` with a `UIAspectRatioConstraint`
  (`FitWithinMaxSize`, `DominantAxis = Width`).
- `parentW`/`parentH` in `Ctx` **must** be updated when descending into a node
  whose children are positioned relative to it.
- Every approximation pushes a string into `ctx.warnings`. No silent drops.

---

## 2. Hard-won gotchas

Read these before touching the corresponding area. Each one cost a debugging
cycle.

| Area | Gotcha |
| --- | --- |
| Figma manifest | `allowedDomains` rejects IP literals. `http://127.0.0.1:...` fails validation; `http://localhost:...` works. This is why every client default is `localhost`. |
| Bridge binding | `localhost` resolves to `::1` before `127.0.0.1` on Windows/macOS, so the bridge listens on **both**. Do not revert to a single `+ hostname`. |
| `documentAccess: dynamic-page` | `figma.on('documentchange')` throws unless `figma.loadAllPagesAsync()` was awaited first. Registration is therefore lazy, inside `enableLiveSync()`. |
| `UIStroke.Thickness` | Pixels, not scale. A stroke does not grow with the frame. |
| Text | `TextScaled` is off by default; `_fit` opts in. See D1. |
| Re-import | `Materialize.run` destroys any `ScreenGui` whose `figrbxCode` attribute matches. User-added children are lost. See F2. |
| Group uploads | `ImageUploader.creatorField()` only ever returns `{ userId }`. See F1. |
| Lune / selene | The `~/.rokit/bin` shims fail with "Failed to find tool in any project manifest". Use the tool-storage paths in §6. |
| Live sync vs. rasters | Exporting a `_image` layer temporarily hides `_keep` / `_ignore` children, which mutates the document. `exportRaster` suppresses the change watcher for 1 s; without that, live sync re-exports in a loop. |
| World hosts | A `LocalScript` inside a GUI parented to a `Part` does not run. World hosts must stay in `StarterGui` with `Adornee` set, or every behavior silently stops working. |
| `BillboardGui.Size` | Scale components are relative to the **adornee**, so the anchor part is 1×1×1 and the stud width lives in `Size`. `SurfaceGui.CanvasSize` is pixels, not studs. |
| `UIShadow` units | `Offset` / `Spread` are `UDim2` and `BlurRadius` is `UDim`; the converter writes scales so the shadow tracks the layout. `Inset` has no effect in `Text` mode. |
| `Instance.new` | New UI classes are not present in every Studio build. `materialize.luau` wraps creation in `pcall` and skips the node; do not replace it with a direct call. |
| `GuiObject.Active` | Defaults to **false** on GuiObjects, so `Active == false` is not a disabled signal. `_disabled` uses `Interactable` and the `figrbxDisabled` attribute instead. |
| `_keep` scope | Only **direct** children of a baked layer survive as instances, so only direct `_keep` children are hidden from the raster. A deeper `_keep` tag is ignored (and the layer stays in the image). |
| Tests | `packages/core/tsconfig.json` has `noEmit`; the build uses `tsconfig.build.json`. Do not merge them (test files fall outside `rootDir`). |

---

## 3. What ships today

Supported tags: `_button`, `_scroll`, `_panel`, `_close`, `_closed`, `_open:Name`,
`_toggle:Name`, `_close:Name`, `_exit`, `_tab:Group`, `_tab` (inside
`_tabgroup`), `_tabgroup`, `_page:Group`, `_hover`, `_clicked`, `_default`,
`_disabled`, `_active`, `_select`, and `{Attr}` bindings.

Control tags: `_ignore`; `_image` / `_img` / `_lock` / `#Name` / `img:Name`;
`_frame`; `_txt`; `_keep`; `_fit`; `_aspect`; `_canvas`; `_list`; `_grid`;
`_nolist`; `_textbox` / `_input`; `_nodim`.

Root host tags: `_billboard`, `_surface`, `_prompt` (optional width in studs).
`_hold` fills a stroke during a prompt hold.

Supported output: `ScreenGui`, `BillboardGui`, `SurfaceGui`, `Frame`,
`TextLabel`, `TextButton`, `TextBox`, `ImageLabel`, `ImageButton`,
`ScrollingFrame`, `CanvasGroup`, `UICorner`, `UIStroke`, `UIGradient`,
`UIShadow`, `UIListLayout`, `UIGridLayout`, `UIAspectRatioConstraint`,
`ProximityPrompt`.

---

## 4. Work plan

Ordered so that later work does not have to be redone. Each unit lists the files
it touches and how to prove it works.

### Phase A — Bake and control tags (do first)

**Status: done.** Implementation notes: `_keep`
(and `_ignore`) is honoured while an ancestor raster is exported by hiding
those children in Figma and restoring visibility afterwards; `_frame` cannot
un-bake a vector or text layer, so that case warns; `_image` wins over `_txt` /
`_frame` / `_scroll` when tags conflict, with a warning. Drop and inner shadows
now import as `UIShadow` (no tag required); only blur remains a warning.

These change the conversion pipeline itself. Everything later depends on the
converter being able to decide *per layer* what becomes what.

**A1. `_ignore`** — skip a layer entirely, including its children.
- `convert.ts`: early return in `convertNode`.
- Test: tagged subtree absent from output, no warnings.

**A2. `_image` / `_img` / `_lock` / `#` prefix / `img:` prefix** — force a layer
to bake to an image.
- The ODT already carries `baked` + `imageRef`; the exporter must honour the tag
  when walking the tree (`code.ts` `serializeNode`).
- `convert.ts`: if `node.baked`, always emit `ImageLabel`/`ImageButton`.
- Tests: forced bake of a `FRAME` with children produces one image node.

**A3. `_frame`** — keep a real Frame, drop only the unsupportable effect.
- `convert.ts`: currently `describeEffects` always warns and drops. With
  `_frame`, suppress the bake path and keep the effect drop warning.
- Requires A2's structure so the two paths are symmetric.

**A4. `_txt`** — keep text live instead of baking.
- `convert.ts` `shouldBakeText` currently takes only the global mode. Add a
  per-node override: `_txt` forces `live`, `_image` forces `bake`.
- Also covers the wrapping-text case (they bake wrapped text by default).

**A5. `_keep`** — keep the layer out of a parent's baked background.
- Requires the parent to have been baked. Coordinate with A2/A3.

**A6. `_fit`** — `TextScaled` opt-in. See decision D1.

**A7. `_aspect`, `_canvas`, `_nodim`, `_nolist`** — direct control tags.
- `_aspect` → `UIAspectRatioConstraint` on any node, not just root.
- `_canvas` → force `CanvasGroup` even at opacity 1.
- `_nodim` opts a button out of the default hover dim (wired in the controller).

### Phase B — Layout

**Status: B1–B3 done.** Implementation notes:
layout children move under a child `Items` frame; `_list` auto-detects three or
more children with identical gaps and a shared edge (`_nolist` opts out, with a
warning explaining the automatic result); `_grid` requires equal cell sizes,
aligned columns/rows, and only the last row may be short. Layout tags on the
root frame or on a baked image warn and fall back to absolute positions.
`_textbox` / `_input` on a frame applies to its first visible direct text child;
the drawn text becomes `PlaceholderText`, the field starts empty, bindings warn.

**B1. `_list` → `UIListLayout`**
- `convert.ts`: new `convertWithLayout()`. Detect direction from stacking axis,
  gap from spacing, alignment from a shared edge.
- Children move under a child `Frame` named `Items` (their convention) so
  runtime-added children fall into line.
- **Auto-detection:** three or more children with identical gaps and no tag
  become a list. `_nolist` opts out. Exact spacing only — a 1 px deviation keeps
  absolute positions (their rule).
- Uneven gaps → warning, keep positions.

**B2. `_grid` → `UIGridLayout`**
- Same container pattern. Infer `CellSize`, `CellPadding`, column count from the
  arrangement.
- Only the last row may be shorter; strongly irregular → warning + absolute.
- `_scroll_grid`: `_grid` on an inner group inside a `_scroll` frame.

**B3. `_textbox` / `_input` → `TextBox`**
- On a text layer, or inherited by the first visible direct text child of a
  tagged frame.
- Drawn text → `PlaceholderText`; field starts empty; keep font/size/colour;
  `ClearTextOnFocus = false`.
- **Not** compatible with `{Attr}` bindings (their rule) — warn.

### Phase C — Interaction

**Status: Phase C done.** `_open` now shows a panel (it no longer toggles);
`_toggle:Name` toggles; `_close:Name` hides a named panel; `_exit` disables the
ScreenGui. Tabs and pages pair by their nearest `_tabgroup`; bare `_tab` /
`_page` work inside one. State layers are hidden at import and driven by a
generated controller; `_select` tweens a `UIStroke` and exposes `FWSelected`;
`_lean` / `_magnet` follow the pointer; `_nopointer` and `_nodim` opt out of
hover effects, and other buttons dim on hover by default.

**C1. Parameterised actions** — `_toggle:Name`, `_close:Name`, `_exit` alias.
- `tags.ts`: extend `BehaviorKind`; keep `_open` requiring its parameter.
- `behaviors.luau`: extend the generated controller.

**C2. `_tabgroup`**
- Replaces the current **order-based** tab↔page pairing, which is fragile.
- Each `_tab:Name` belongs to its nearest `_tabgroup`; without one, the root.
- First tab in each group selected initially.

**C3. State variants** — `_hover`, `_clicked`, `_default`, `_disabled`, `_active`.
- These are *layers inside their owning button*. Converter marks them hidden and
  records which button owns them.
- Runtime swaps visibility on `MouseEnter`/`MouseLeave`/`InputBegan`/`InputEnded`,
  and watches `Interactable` for `_disabled`.
- `_disabled` also follows the `figrbxDisabled` attribute. `Active` is **not**
  used: it defaults to false on GuiObjects and would mark every button disabled.
- `_default` hides whenever any variant shows.

**C4. `_select`** — one live choice at a time; outline animates in; expose
`FWSelected` on the parent and per-button.

**C5. `_lean`, `_magnet`, `_nopointer`** — pointer-reactive, need the runtime.

### Phase D — Live data

**Status: Phase D done.** Bindings resolve against the local player, prefer
`leaderstats`, and keep the ScreenGui-attribute fallback so existing imports
keep working. `_bind:path` replaces the whole label; dotted paths poll every
half second because arbitrary descendants have no change signal.

**D1. Binding grammar**

| Pattern | Source |
| --- | --- |
| `{Coins}` | `leaderstats.Coins` |
| `{attr:Rank}` | local player attribute |
| `{PlayerName}` / `{Player}` | `Player.Name` |
| `{DisplayName}` | `Player.DisplayName` |

- `tags.ts`: parse the pattern kinds; keep the existing `%s` format-string path.
- `behaviors.luau`: resolve each pattern against the local player; subscribe to
  `leaderstats` `ChildAdded`/`GetPropertyChangedSignal('Value')` and
  `GetAttributeChangedSignal`.
- **Breaking change:** `{Coins}` currently reads a ScreenGui attribute. That must
  keep working or existing imports break — support both, preferring
  `leaderstats` when present.

**D2. `_bind:path`** — replace the entire label with a dotted path from the local
player. Auto-updates only for direct `leaderstats` values and attributes; other
paths resolve on refresh.

### Phase E — Placement hosts

**Status: E1–E3 done, with one deviation.** The importer creates an invisible
anchor `Part` under `Workspace/figrbx` at a fixed `(0, 5, -10)` and adorns a
StarterGui-copied GUI to it. Self-contained mode (GUI parented to the Part) was
not implemented because a `LocalScript` inside a Workspace GUI does not run;
Adornee-from-StarterGui is the only placement where the generated controller
works. Widths come from the tag (`_billboard:12`); `_prompt` uses a
`BillboardGui` with a custom-style prompt, and `_hold` sweeps a gradient on the
target stroke over the prompt's hold time.

The root frame may currently only become a `ScreenGui`. Add a root-host
selector driven by a root tag.

**E1. `_billboard`** → `BillboardGui` on an anchor `Part`.
- Width in studs, `AlwaysOnTop`, `MaxDistance`; height from aspect ratio.
- Two modes: self-contained (UI travels with the Part) vs `Adornee` from
  `StarterGui` (needed for buttons/hover).

**E2. `_surface`** → `SurfaceGui` on a Part's front face.
- Canvas = design size; width in studs; `Adornee` so buttons work.

**E3. `_prompt`** → anchor Part + `ProximityPrompt` (`Style = Custom`), plus
`_hold` filling a stroke left-to-right over the hold time.
- Line of sight deliberately off.
- `_hold` repaints an existing stroke through a gradient, so rounded corners
  come free.

Only one root host tag may be used; warn otherwise.

### Phase F — Pipeline

**Status: not started. F2 first.**

**F1. Group uploads**
- `ImageUploader.creatorField()` returns `{ groupId }` when configured.
- Config gains a group id; the UI needs a "upload to group" selector.
- Background: Roblox OAuth authenticates the *user*, not their groups. Group
  uploads need an Open Cloud key whose creator is that group. Document it.

**F2. Re-import must not destroy user work**
- Current behaviour: `Materialize.run` destroys the whole `ScreenGui`.
- Target: reuse the existing ScreenGui, patch by `figrbxId`, preserve
  user-added children and user-modified properties.
- This requires tracking which properties the importer last wrote — store a
  serialized "applied" map as an attribute, or diff against the previous spec.

**F3. Live pairing code** — `L-XXXXXX`, 10-minute TTL, links Figma to one Studio
session so Live sends do not need a typed import code.

**F4. Auto-sync** — Studio polls the last imported code automatically instead of
requiring the manual toggle.

**F5. Delivery confirmation** — Studio POSTs back that it applied the design;
Figma shows "delivered" rather than "sent".

**F6. Roblox → Figma (reverse)** — largest single feature.
- Studio sends the selected `ScreenGui`/`Frame`; Figma creates a fresh
  1920×1080 frame on the current page.
- Needs: a reverse serializer (Roblox instances → ODT), a new bridge endpoint,
  and a Figma-side `figma.createFrame()` writer.
- Geometry, text, colours, corners, outlines, gradients, tile textures.
  Inaccessible private images remain placeholders.

### Phase G — Animation runtime

**Status: not started.** `_lean`, `_magnet`, and `_hold` from the old plan are
already implemented in the interaction phase; the rest below is open.

This is where most of the commercial product's perceived value lives, and it is
the largest chunk by far. Every tag generates a `LocalScript` and every tag has
tuning parameters.

Group them so each batch shares test infrastructure:

| Batch | Tags | Shared mechanism |
| --- | --- | --- |
| Entrances | `_pop`, `_reveal`, `_swing`, `_drop`, `_cascade`, `_fadein` | run once on becoming visible |
| Idle | `_float`, `_drift`, `_spin`, `_blink`, `_pulse`, `_jelly`, `_wiggle`, `_shake`, `_glow`, `_rays`, `_pixels` | looping tween |
| Press | `_smooth`, `_squish`, `_ripple`, `_burst`, `_up`, `_turn`, `_magnet`, `_lean` | `MouseEnter`/`InputBegan` |
| Shader-ish | `_shiny`, `_beam`, `_glint`, `_gleam`, `_flow`, `_stroke` | moving a gradient / clipping a strip |
| Text | `_type` | `MaxVisibleGraphemes` |
| Particles | `_sparkle`, `_fall` | pooled instances |
| 3D | `_3d`, `_tilt` | move the layer onto a world surface |
| Overlay | `_card`, `_pointer` | screen-space follow |

Shadows are not animation: Figma drop and inner shadows now map to real
`UIShadow` instances, done with Phase A because it removed a
currently-always-dropped effect. Text layers use `ApplyShadowMode.Text`; inner
text shadows are skipped with a warning because inset has no effect in that
mode.

**Design requirement:** the generated controller must stay readable and
regenerable. `behaviors.luau` builds source text today; keep that approach
(one generated script, clearly delimited sections) rather than shipping a
shared runtime module, so imports stay self-contained.

### Phase H — Authoring UX

**Status: not started.**

Lower priority, but these are what make the product feel finished.

- **Effects inspector** in the Figma plugin: sliders, numeric entry, live
  preview, per-tag reset, auto-save.
- **Design tab:** custom contours (Cut corners, Step, Tab, Ribbon, Arrow,
  Hexagon, Slant, Ticket, Badge, Bubble), per-corner radii, 9-slice.
- **Gradient editor:** 2–18 stops with per-stop alpha, editable in-plugin.
- **Studio UI Tools:** drag/resize, anchor snapping, class conversion with
  children preserved, `Ctrl+Z`.
- **Placement mode:** `Fit & centre` vs `Exact artboard`.
- Localisation (EN/RU) if desired.

### Explicitly out of scope

Trial/licence gating, paid image libraries, and cloud storage sync. Those serve a
subscription business figrbx does not have.

---

## 5. Decisions to settle before starting

**D1 — `TextScaled` default. Settled: match the commercial product.**
Text layers now emit `TextSize = fontSize` with `TextScaled = false`; `_fit`
opts into `TextScaled`. The commercial product does the same, and the reasoning
is sound — an auto-width label has no box to fit, and `TextScaled` silently
changes typography. This changes how existing imports look.

**D2 — Iframe size.**
`manifest.json` has `"id": "figrbx-figma-plugin"`, a placeholder. Figma assigns
numeric ids. Delete the line before publishing if it errors.

**D3 — Bridge packaging.**
`bun build --compile` would produce a single executable and remove the
"install Node" step. Also consider letting the Studio plugin upload images
directly via `HttpService` (no CORS there), which would make the bridge optional
for everything except codes and live sync.

---

## 6. Commands

```bash
# every change
pnpm test                 # 114 core + 23 bridge
pnpm typecheck
pnpm lint                 # biome
pnpm build                # core, bridge, figma plugin

# studio plugin
pnpm build:studio         # rojo build → studio-plugin/figrbx.rbxm

# luau verification (the ~/.rokit/bin shims do not work here)
~/.rokit/tool-storage/kampfkarren/selene/0.31.0/selene.exe studio-plugin/src
~/.rokit/tool-storage/lune-org/lune/0.10.5/lune.exe run tests/behaviors/generate.luau
~/.rokit/tool-storage/kampfkarren/selene/0.31.0/selene.exe tests/behaviors/generated_controller.luau

# run the bridge (prints the token)
node packages/bridge/dist/cli.js
```

Bridge config: `~/.figrbx/config.json`. This machine uses Open Cloud API-key
mode (`apiKey` + `creatorUserId`), not OAuth.

Manual verification loop:
1. `pnpm build` and `pnpm build:studio`.
2. Figma → Plugins → Development → reimport `packages/figma-plugin/manifest.json`
   after manifest changes; otherwise just close and reopen the plugin.
3. Bridge running; paste token; **Test** → green *Online*.
4. Export a frame; paste the code into the Studio plugin
   (**Studio Settings → Security → Allow HTTP Requests** must be on).
5. Press **Play** in Studio to test anything runtime-driven.

---

## 7. Conventions that hold the project together

- **No silent degradation.** Every approximation produces a warning string.
- **Data-only conversion.** No layer may execute document content.
- **Allow-list on the Studio side.** `props.luau` refuses classes outside its
  list and applies every property with `pcall`.
- **Tests next to the behaviour.** Conversion rules → `packages/core/test`;
  ready-made invariants live in `geometry.test.ts`.
- **Warnings must be actionable.** Say what happened, what will render instead,
  and how to fix it. The bake warning is the reference example.
