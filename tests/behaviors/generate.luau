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
			behaviors = { { kind = "button" }, { kind = "lean" }, { kind = "magnet" } },
			children = {
				{
					figmaId = "button-default",
					className = "Frame",
					name = "Idle",
					behaviors = { { kind = "default" } },
					children = {},
				},
				{
					figmaId = "button-hover",
					className = "Frame",
					name = "Glow",
					behaviors = { { kind = "hover" } },
					children = {},
				},
				{
					figmaId = "button-clicked",
					className = "Frame",
					name = "Press",
					behaviors = { { kind = "clicked" } },
					children = {},
				},
				{
					figmaId = "button-disabled",
					className = "Frame",
					name = "Lock",
					behaviors = { { kind = "disabled" } },
					children = {},
				},
				{
					figmaId = "button-active",
					className = "Frame",
					name = "Chosen",
					behaviors = { { kind = "active" } },
					children = {},
				},
			},
		},
		{
			figmaId = "open",
			className = "TextButton",
			name = "OpenShop",
			behaviors = { { kind = "open", target = "ShopPanel" } },
			children = {},
		},
		{
			figmaId = "toggle",
			className = "TextButton",
			name = "ToggleShop",
			behaviors = { { kind = "toggle", target = "ShopPanel" } },
			children = {},
		},
		{
			figmaId = "close-named",
			className = "TextButton",
			name = "CloseShop",
			behaviors = { { kind = "close", target = "ShopPanel" } },
			children = {},
		},
		{
			figmaId = "exit",
			className = "TextButton",
			name = "Exit",
			behaviors = { { kind = "exit" } },
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
			figmaId = "select-panel",
			className = "Frame",
			name = "Options",
			children = {
				{
					figmaId = "option-a",
					className = "TextButton",
					name = "OptionA",
					behaviors = { { kind = "select" } },
					children = {},
				},
				{
					figmaId = "option-b",
					className = "TextButton",
					name = "OptionB",
					behaviors = { { kind = "select" } },
					children = {},
				},
			},
		},
		{
			figmaId = "settings-group",
			className = "Frame",
			name = "Settings",
			behaviors = { { kind = "tabgroup" } },
			children = {
				{
					figmaId = "settings-tab-a",
					className = "TextButton",
					name = "AudioTab",
					behaviors = { { kind = "tab" } },
					children = {},
				},
				{
					figmaId = "settings-tab-b",
					className = "TextButton",
					name = "VideoTab",
					behaviors = { { kind = "tab" } },
					children = {},
				},
				{
					figmaId = "settings-page-a",
					className = "Frame",
					name = "AudioPage",
					behaviors = { { kind = "page" } },
					children = {},
				},
				{
					figmaId = "settings-page-b",
					className = "Frame",
					name = "VideoPage",
					behaviors = { { kind = "page" } },
					children = {},
				},
			},
		},
		{
			figmaId = "hold-ring",
			className = "Frame",
			name = "Ring",
			behaviors = { { kind = "hold", target = "1.5" } },
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
		{
			figmaId = "rank",
			className = "TextLabel",
			name = "RankLabel",
			bindings = { "attr:Rank" },
			textFormat = "Rank: %s",
			children = {},
		},
		{
			figmaId = "greeting",
			className = "TextLabel",
			name = "Greeting",
			bindings = { "PlayerName" },
			textFormat = "Hi %s",
			children = {},
		},
		{
			figmaId = "bind-score",
			className = "TextLabel",
			name = "Score",
			behaviors = { { kind = "bind", target = "leaderstats.Coins" } },
			bindPath = "leaderstats.Coins",
			children = {},
		},
		{
			figmaId = "pointer-off",
			className = "TextButton",
			name = "Quiet",
			behaviors = { { kind = "button" }, { kind = "nopointer" } },
			children = {},
		},
	},
}

local source = Behaviors.generate(screenGui)
assert(source, "expected a controller for this fixture")
assert(string.find(source, "figrbxId", 1, true), "controller should resolve nodes by attribute")
assert(string.find(source, "Coins: %s", 1, true), "controller should keep the format string")
assert(string.find(source, 'action = "open"', 1, true), "controller should open a named panel")
assert(string.find(source, 'action = "toggle"', 1, true), "controller should toggle a named panel")
assert(string.find(source, 'action = "exit"', 1, true), "controller should support exit")
assert(string.find(source, "panel.Visible = true", 1, true), "open should show, not toggle")
assert(
	string.find(source, 'group = "settings-group"', 1, true),
	"bare tabs should take the nearest _tabgroup as their group"
)
assert(string.find(source, "settings-page-a", 1, true), "tabgroup pages should be paired")
assert(string.find(source, "firstTab", 1, true), "the first tab should start active")
assert(string.find(source, 'button = "button"', 1, true), "state layers should bind to their button")
assert(string.find(source, 'hover = "button-hover"', 1, true), "hover state should be recorded")
assert(string.find(source, 'default = "button-default"', 1, true), "default state should be recorded")
assert(
	string.find(source, 'GetAttributeChangedSignal("figrbxActive")', 1, true),
	"active state should follow figrbxActive"
)
assert(string.find(source, 'id = "option-a"', 1, true), "select buttons should be collected")
assert(string.find(source, 'group = "select-panel"', 1, true), "select buttons group by parent")
assert(string.find(source, 'SetAttribute("FWSelected"', 1, true), "select should expose FWSelected")
assert(string.find(source, 'leaderstat(name)', 1, true), "bindings should prefer leaderstats")
assert(string.find(source, 'name == "PlayerName"', 1, true), "player name bindings should resolve")
assert(string.find(source, 'string.sub(name, 6)', 1, true), "attr: bindings should strip the prefix")
assert(string.find(source, "local pointerTargets", 1, true), "lean and magnet should generate a runtime")
assert(string.find(source, "lean = true", 1, true), "lean should be recorded")
assert(string.find(source, "magnet = true", 1, true), "magnet should be recorded")
assert(string.find(source, "local binds = {", 1, true), "bind: should generate a path binding")
assert(string.find(source, 'path = "leaderstats.Coins"', 1, true), "bind: should keep its path")
assert(string.find(source, "local function valueAtPath", 1, true), "bind: should resolve paths")
assert(string.find(source, "setDim", 1, true), "buttons should dim on hover")
assert(
	not string.find(source, '"pointer-off"', 1, true),
	"_nopointer buttons should not be dimmed"
)
assert(string.find(source, 'local holds = {', 1, true), "_hold should generate a prompt runtime")
assert(string.find(source, '"hold-ring"', 1, true), "_hold should reference its layer")
assert(
	string.find(source, "PromptButtonHoldBegan", 1, true),
	"_hold should listen for the prompt hold"
)

-- Lune resolves filesystem paths from the working directory, so run
-- this from the repo root.
local path = "tests/behaviors/generated_controller.luau"
fs.writeFile(path, source)

print(string.format("wrote %d bytes to %s", #source, path))

local empty = { figmaId = "screen", className = "ScreenGui", name = "Static", children = {} }
assert(Behaviors.generate(empty) == nil, "documents without tags must not emit a script")
print("no-tag document correctly emits no controller")
