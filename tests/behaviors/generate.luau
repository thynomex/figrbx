-- Generates the controller source for a fixture and writes it to a file, so
-- the generated Luau can be syntax-checked outside Studio.
-- Run with: lune run tests/behaviors/generate.luau

local fs = require("@lune/fs")

local Behaviors = require("../../studio-plugin/src/behaviors")

local screenGui = {
	figmaId = "screen",
	className = "ScreenGui",
	name = "Shop",
	children = {
		{
			figmaId = "button",
			className = "TextButton",
			name = "Buy",
			behaviors = { { kind = "button" } },
			children = {},
		},
		{
			figmaId = "open",
			className = "TextButton",
			name = "OpenShop",
			behaviors = { { kind = "open", target = "ShopPanel" } },
			children = {},
		},
		{
			figmaId = "panel",
			className = "Frame",
			name = "ShopPanel",
			behaviors = { { kind = "panel" } },
			children = {
				{
					figmaId = "close",
					className = "TextButton",
					name = "Close",
					behaviors = { { kind = "close" } },
					children = {},
				},
			},
		},
		{
			figmaId = "tab-a",
			className = "TextButton",
			name = "WeaponsTab",
			behaviors = { { kind = "tab", target = "Weapons" } },
			children = {},
		},
		{
			figmaId = "tab-b",
			className = "TextButton",
			name = "ItemsTab",
			behaviors = { { kind = "tab", target = "Weapons" } },
			children = {},
		},
		{
			figmaId = "page-a",
			className = "Frame",
			name = "WeaponsPage",
			behaviors = { { kind = "page", target = "Weapons" } },
			children = {},
		},
		{
			figmaId = "page-b",
			className = "Frame",
			name = "ItemsPage",
			behaviors = { { kind = "page", target = "Weapons" } },
			children = {},
		},
		{
			figmaId = "coins",
			className = "TextLabel",
			name = "CoinsLabel",
			bindings = { "Coins" },
			textFormat = "Coins: %s",
			children = {},
		},
	},
}

local source = Behaviors.generate(screenGui)
assert(source, "expected a controller for this fixture")
assert(string.find(source, "figrbxId", 1, true), "controller should resolve nodes by attribute")
assert(string.find(source, "Coins: %s", 1, true), "controller should keep the format string")

-- Lune resolves filesystem paths from the working directory, so run
-- this from the repo root.
local path = "tests/behaviors/generated_controller.luau"
fs.writeFile(path, source)

print(string.format("wrote %d bytes to %s", #source, path))

local empty = { figmaId = "screen", className = "ScreenGui", name = "Static", children = {} }
assert(Behaviors.generate(empty) == nil, "documents without tags must not emit a script")
print("no-tag document correctly emits no controller")
