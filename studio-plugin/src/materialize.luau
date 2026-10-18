--!strict
-- Turns a conversion spec into live Studio instances.

local Props = require(script.Parent.props)
local Behaviors = require(script.Parent.behaviors)

local Materialize = {}

export type Report = {
	created: number,
	skipped: { string },
	propFailures: { Props.Failure },
	screen: ScreenGui?,
	controller: boolean,
}

local function applyMetadata(instance: Instance, spec: any)
	instance:SetAttribute("figrbxId", spec.figmaId)
	if spec.behaviors then
		local kinds = {}
		for _, behavior in ipairs(spec.behaviors) do
			table.insert(kinds, behavior.kind)
			if behavior.kind == "panel" then
				instance:SetAttribute("figrbxPanel", true)
			elseif behavior.kind == "tab" and behavior.target then
				instance:SetAttribute("figrbxTabGroup", behavior.target)
			elseif behavior.kind == "page" and behavior.target then
				instance:SetAttribute("figrbxPageGroup", behavior.target)
			end
		end
		instance:SetAttribute("figrbxBehavior", table.concat(kinds, ","))
	end
	if spec.bindings then
		instance:SetAttribute("figrbxBindings", table.concat(spec.bindings, ","))
	end
	if spec.textFormat then
		instance:SetAttribute("figrbxFormat", spec.textFormat)
	end
end

local function create(spec: any, parent: Instance, report: Report): Instance?
	if not Props.isAllowed(spec.className) then
		table.insert(report.skipped, tostring(spec.className) .. " (" .. tostring(spec.name) .. ")")
		return nil
	end

	local instance = Instance.new(spec.className)
	instance.Name = spec.name
	local failures = Props.apply(instance, spec.props or {})
	for _, failure in ipairs(failures) do
		table.insert(report.propFailures, failure)
	end
	applyMetadata(instance, spec)
	instance.Parent = parent
	report.created += 1

	for _, child in ipairs(spec.children or {}) do
		create(child, instance, report)
	end
	return instance
end

-- Imports a spec, replacing any previous import that used the same code.
function Materialize.run(spec: any, code: string): Report
	local report: Report = {
		created = 0,
		skipped = {},
		propFailures = {},
		screen = nil,
		controller = false,
	}

	local starterGui = game:GetService("StarterGui")
	for _, child in ipairs(starterGui:GetChildren()) do
		if child:IsA("ScreenGui") and child:GetAttribute("figrbxCode") == code then
			child:Destroy()
		end
	end

	local screen = create(spec.screenGui, starterGui, report)
	if screen and screen:IsA("ScreenGui") then
		report.screen = screen
		screen:SetAttribute("figrbxCode", code)

		local source = Behaviors.generate(spec.screenGui)
		if source then
			local controller = Instance.new("LocalScript")
			controller.Name = "figrbx_controller"
			local ok = pcall(function()
				controller.Source = source
			end)
			controller.Parent = screen
			report.controller = ok
		end
	end

	return report
end

return Materialize
