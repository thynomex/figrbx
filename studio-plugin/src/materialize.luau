--!strict
-- Turns a conversion spec into live Studio instances.

local Props = require(script.Parent.props)
local Behaviors = require(script.Parent.behaviors)

local Materialize = {}

export type Report = {
	created: number,
	skipped: { string },
	propFailures: { Props.Failure },
	screen: LayerCollector?,
	-- screen, billboard, surface, or prompt.
	host: string,
	-- Name of the anchor part for world hosts.
	anchor: string?,
	controller: boolean,
}

local HOST_FOLDER = "figrbx"

local function worldPoint(values: { number }?): Vector3
	if not values then
		return Vector3.new(0, 5, -10)
	end
	return Vector3.new(values[1] or 0, values[2] or 5, values[3] or -10)
end

local function worldSize(values: { number }?): Vector3
	if not values then
		return Vector3.new(1, 1, 1)
	end
	return Vector3.new(values[1] or 1, values[2] or 1, values[3] or 1)
end

-- Anchors live under one Workspace folder so re-imports can find and replace
-- them without touching anything the user made.
local function anchorFolder(): Folder
	local workspace = game:GetService("Workspace")
	local folder = workspace:FindFirstChild(HOST_FOLDER)
	if folder and folder:IsA("Folder") then
		return folder
	end
	folder = Instance.new("Folder")
	folder.Name = HOST_FOLDER
	folder.Parent = workspace
	return folder
end

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
	if spec.bindPath then
		instance:SetAttribute("figrbxBindPath", spec.bindPath)
	end
	if spec.controls then
		instance:SetAttribute("figrbxControls", table.concat(spec.controls, ","))
	end
end

local function create(spec: any, parent: Instance, report: Report): Instance?
	if not Props.isAllowed(spec.className) then
		table.insert(report.skipped, tostring(spec.className) .. " (" .. tostring(spec.name) .. ")")
		return nil
	end

	-- New UI classes (UIShadow, layout objects) ship with newer Studio
	-- versions. A missing class skips that node instead of aborting the import.
	local ok, instance = pcall(Instance.new, spec.className)
	if not ok or not instance then
		table.insert(report.skipped, tostring(spec.className) .. " (" .. tostring(spec.name) .. ")")
		return nil
	end
	instance = instance :: Instance

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
		host = spec.host and spec.host.kind or "screen",
		anchor = nil,
		controller = false,
	}

	local starterGui = game:GetService("StarterGui")
	for _, child in ipairs(starterGui:GetChildren()) do
		if
			(child:IsA("ScreenGui") or child:IsA("BillboardGui") or child:IsA("SurfaceGui"))
			and child:GetAttribute("figrbxCode") == code
		then
			child:Destroy()
		end
	end

	local screen = create(spec.screenGui, starterGui, report)
	if screen and screen:IsA("LayerCollector") then
		local collectorGui = screen :: LayerCollector
		report.screen = collectorGui
		screen:SetAttribute("figrbxCode", code)

		if report.host ~= "screen" then
			local anchorSpec = spec.host and spec.host.anchor
			local folder = anchorFolder()
			for _, existing in ipairs(folder:GetChildren()) do
				if existing:GetAttribute("figrbxAnchor") and existing:GetAttribute("figrbxCode") == code then
					existing:Destroy()
				end
			end

			local part = Instance.new("Part")
			part.Name = anchorSpec and anchorSpec.name or (spec.screenGui.name .. " Anchor")
			part.Anchored = true
			part.CanCollide = false
			part.CanTouch = false
			part.CastShadow = false
			part.Transparency = 1
			part.Material = Enum.Material.SmoothPlastic
			part.Size = worldSize(anchorSpec and anchorSpec.size)
			part.CFrame = CFrame.new(worldPoint(anchorSpec and anchorSpec.position))
			part:SetAttribute("figrbxAnchor", true)
			part:SetAttribute("figrbxCode", code)
			part.Parent = folder
			report.anchor = part.Name

			-- Adornee from StarterGui is what lets buttons and the generated
			-- LocalScript work: PlayerGui copies are where LocalScripts run.
			local collector = screen :: any
			collector.Adornee = part

			if spec.host and spec.host.prompt then
				create(spec.host.prompt, part, report)
			end
		end

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
