--!strict
-- Generates the LocalScript that wires behavior tags and attribute bindings.
-- The script is emitted as source text because plugins can only hand Roblox an
-- actual Script instance through the Source property.

local Behaviors = {}

local function walk(node: any, visit: (any) -> ()): ()
	visit(node)
	for _, child in ipairs(node.children or {}) do
		walk(child, visit)
	end
end

local function quote(value: string): string
	return string.format("%q", value)
end

local function findBehavior(node: any, kind: string): any?
	for _, behavior in ipairs(node.behaviors or {}) do
		if behavior.kind == kind then
			return behavior
		end
	end
	return nil
end

local function hasBehavior(node: any, kind: string): boolean
	return findBehavior(node, kind) ~= nil
end

local BUTTON_CLASSES = {
	TextButton = true,
	ImageButton = true,
}

local function hasControl(node: any, name: string): boolean
	for _, control in ipairs(node.controls or {}) do
		if control == name then
			return true
		end
	end
	return false
end

-- First tag wins when a layer carries several state tags.
local STATE_ORDER = { "hover", "clicked", "disabled", "active", "default" }

-- Returns the Lua source for the controller, or nil when the document has no
-- behavior tags and no attribute bindings.
function Behaviors.generate(screenGui: any): string?
	local buttons: { { id: string, action: string, target: string? } } = {}
	local tabs: { { group: string, tab: string, page: string } } = {}
	local pagesByGroup: { [string]: { string } } = {}
	local tabsByGroup: { [string]: { string } } = {}
	local bindings: { { id: string, names: { string }, format: string } } = {}
	local states: { [string]: { [string]: string } } = {}
	local stateOrder: { string } = {}
	local selects: { { group: string, id: string } } = {}
	local binds: { { id: string, path: string } } = {}
	local pointers: { { id: string, lean: boolean, magnet: boolean } } = {}
	local dimButtons: { string } = {}
	local holds: { { id: string } } = {}

	-- Tabs and pages belong to their nearest _tabgroup ancestor; outside one
	-- they keep the older _tab:Group / _page:Group pairing.
	local function collect(node: any, tabGroup: string?, buttonId: string?, parentId: string?)
		local group = tabGroup
		if hasBehavior(node, "tabgroup") then
			group = node.figmaId
		end

		local owner = buttonId
		if BUTTON_CLASSES[node.className] then
			owner = node.figmaId
		end

		if hasBehavior(node, "select") then
			table.insert(selects, { group = parentId or screenGui.figmaId, id = node.figmaId })
		end

		local bind = findBehavior(node, "bind")
		if bind and bind.target then
			table.insert(binds, { id = node.figmaId, path = bind.target })
		end

		local lean = hasBehavior(node, "lean")
		local magnet = hasBehavior(node, "magnet")
		if (lean or magnet) and not hasBehavior(node, "nopointer") then
			-- Pointer effects live on the nearest button, so several tagged
			-- children collapse into one entry and cannot fight over a tween.
			local target = owner or node.figmaId
			local existing = nil
			for _, entry in ipairs(pointers) do
				if entry.id == target then
					existing = entry
					break
				end
			end
			if existing then
				existing.lean = existing.lean or lean
				existing.magnet = existing.magnet or magnet
			else
				table.insert(pointers, { id = target, lean = lean, magnet = magnet })
			end
		end

		if hasBehavior(node, "hold") then
			table.insert(holds, { id = node.figmaId })
		end

		if BUTTON_CLASSES[node.className] then
			local pointerOff = hasBehavior(node, "nopointer")
			local dimOff = pointerOff or hasControl(node, "nodim")
			if not dimOff then
				table.insert(dimButtons, node.figmaId)
			end
		end

		for _, kind in ipairs(STATE_ORDER) do
			if hasBehavior(node, kind) and owner then
				local entry = states[owner]
				if not entry then
					entry = {}
					states[owner] = entry
					table.insert(stateOrder, owner)
				end
				if not entry[kind] then
					entry[kind] = node.figmaId
				end
			end
		end

		local close = findBehavior(node, "close")
		local open = findBehavior(node, "open")
		local toggle = findBehavior(node, "toggle")
		local exit = findBehavior(node, "exit")
		local tab = findBehavior(node, "tab")
		local page = findBehavior(node, "page")

		if exit then
			table.insert(buttons, { id = node.figmaId, action = "exit", target = nil })
		end
		if close then
			table.insert(buttons, { id = node.figmaId, action = "close", target = close.target })
		end
		if open and open.target then
			table.insert(buttons, { id = node.figmaId, action = "open", target = open.target })
		end
		if toggle and toggle.target then
			table.insert(buttons, { id = node.figmaId, action = "toggle", target = toggle.target })
		end

		local tabKey = group or (tab and tab.target)
		if tab and tabKey then
			table.insert(tabs, { group = tabKey, tab = node.figmaId, page = "" })
			local groupTabs = tabsByGroup[tabKey] or {}
			table.insert(groupTabs, node.figmaId)
			tabsByGroup[tabKey] = groupTabs
		end
		local pageKey = group or (page and page.target)
		if page and pageKey then
			local groupPages = pagesByGroup[pageKey] or {}
			table.insert(groupPages, node.figmaId)
			pagesByGroup[pageKey] = groupPages
		end

		if node.bindings and #node.bindings > 0 and node.textFormat then
			table.insert(bindings, { id = node.figmaId, names = node.bindings, format = node.textFormat })
		end

		for _, child in ipairs(node.children or {}) do
			collect(child, group, owner, node.figmaId)
		end
	end
	collect(screenGui, nil, nil, nil)

	-- Pair tabs with pages by order inside each group.
	for group, groupTabs in pairs(tabsByGroup) do
		local groupPages = pagesByGroup[group] or {}
		for index, tabId in ipairs(groupTabs) do
			local pageId = groupPages[index]
			if pageId then
				for _, entry in ipairs(tabs) do
					if entry.tab == tabId then
						entry.page = pageId
					end
				end
			end
		end
	end

	local hasTabs = false
	for _, entry in ipairs(tabs) do
		if entry.page ~= "" then
			hasTabs = true
			break
		end
	end

	local hasStates = #stateOrder > 0
	local hasSelects = #selects > 0
	local hasBinds = #binds > 0
	local hasComplexPaths = false
	for _, entry in ipairs(binds) do
		if string.find(entry.path, ".", 1, true) then
			hasComplexPaths = true
			break
		end
	end
	local hasPointers = #pointers > 0
	local hasDim = #dimButtons > 0
	local hasHolds = #holds > 0

	if
		#buttons == 0
		and not hasTabs
		and #bindings == 0
		and not hasStates
		and not hasSelects
		and not hasBinds
		and not hasPointers
		and not hasDim
		and not hasHolds
	then
		return nil
	end

	local lines: { string } = {}
	local function push(line: string): ()
		table.insert(lines, line)
	end

	push("-- Generated by figrbx. Re-import replaces this script.")
	push("local screen = script.Parent")
	if hasSelects or hasDim or hasPointers or hasHolds then
		push("local TweenService = game:GetService(\"TweenService\")")
	end
	push("local map = {}")
	push("for _, descendant in ipairs(screen:GetDescendants()) do")
	push("\tlocal id = descendant:GetAttribute(\"figrbxId\")")
	push("\tif id then")
	push("\t\tmap[id] = descendant")
	push("\tend")
	push("end")
	push("")
	push("local function find(id)")
	push("\treturn map[id]")
	push("end")
	push("")

	if #buttons > 0 then
		push("local panels = {}")
		push("for _, descendant in ipairs(screen:GetDescendants()) do")
		push("\tif descendant:GetAttribute(\"figrbxPanel\") then")
		push("\t\tpanels[descendant.Name] = descendant")
		push("\tend")
		push("end")
		push("")
		push("local buttons = {")
		for _, entry in ipairs(buttons) do
			if entry.target then
				push(
					string.format(
						"\t{ id = %s, action = %s, target = %s },",
						quote(entry.id),
						quote(entry.action),
						quote(entry.target)
					)
				)
			else
				push(string.format("\t{ id = %s, action = %s },", quote(entry.id), quote(entry.action)))
			end
		end
		push("}")
		push("for _, entry in ipairs(buttons) do")
		push("\tlocal node = find(entry.id)")
		push("\tif node and node:IsA(\"GuiButton\") then")
		push("\t\tnode.Activated:Connect(function()")
		push("\t\t\tif entry.action == \"exit\" then")
		push("\t\t\t\tscreen.Enabled = false")
		push("\t\t\telseif entry.action == \"close\" then")
		push("\t\t\t\tif entry.target then")
		push("\t\t\t\t\tlocal panel = panels[entry.target]")
		push("\t\t\t\t\tif panel then")
		push("\t\t\t\t\t\tpanel.Visible = false")
		push("\t\t\t\t\tend")
		push("\t\t\t\telse")
		push("\t\t\t\t\tlocal current = node")
		push("\t\t\t\t\tlocal panel = nil")
		push("\t\t\t\t\twhile current and current ~= screen do")
		push("\t\t\t\t\t\tif current:GetAttribute(\"figrbxPanel\") then")
		push("\t\t\t\t\t\t\tpanel = current")
		push("\t\t\t\t\t\t\tbreak")
		push("\t\t\t\t\t\tend")
		push("\t\t\t\t\t\tcurrent = current.Parent")
		push("\t\t\t\t\tend")
		push("\t\t\t\t\tif panel then")
		push("\t\t\t\t\t\tpanel.Visible = false")
		push("\t\t\t\t\telse")
		push("\t\t\t\t\t\tscreen.Enabled = false")
		push("\t\t\t\t\tend")
		push("\t\t\t\tend")
		push("\t\t\telseif entry.action == \"open\" or entry.action == \"toggle\" then")
		push("\t\t\t\tlocal panel = panels[entry.target]")
		push("\t\t\t\tif panel then")
		push("\t\t\t\t\tif entry.action == \"open\" then")
		push("\t\t\t\t\t\tpanel.Visible = true")
		push("\t\t\t\t\telse")
		push("\t\t\t\t\t\tpanel.Visible = not panel.Visible")
		push("\t\t\t\t\tend")
		push("\t\t\t\tend")
		push("\t\t\tend")
		push("\t\tend)")
		push("\tend")
		push("end")
		push("")
	end

	if hasStates then
		push("local states = {")
		for _, owner in ipairs(stateOrder) do
			local entry = states[owner] :: any
			local fields = { string.format("button = %s", quote(owner)) }
			for _, kind in ipairs(STATE_ORDER) do
				if entry[kind] then
					table.insert(fields, string.format("%s = %s", kind, quote(entry[kind])))
				end
			end
			push(string.format("\t{ %s },", table.concat(fields, ", ")))
		end
		push("}")
		push("local function setStateVisible(entry, kind, visible)")
		push("\tlocal id = entry[kind]")
		push("\tif id then")
		push("\t\tlocal node = find(id)")
		push("\t\tif node then")
		push("\t\t\tnode.Visible = visible")
		push("\t\tend")
		push("\tend")
		push("end")
		push("for _, entry in ipairs(states) do")
		push("\tlocal button = find(entry.button)")
		push("\tif button and button:IsA(\"GuiButton\") then")
		push("\t\tlocal hovered = false")
		push("\t\tlocal pressed = false")
		push("\t\tlocal function refresh()")
		push("\t\t\t-- Active defaults to false on GuiObjects, so it cannot signal")
		push("\t\t\t-- disabled. Interactable and the explicit attribute can.")
		push("\t\t\tlocal disabled = button.Interactable == false")
		push("\t\t\t\tor button:GetAttribute(\"figrbxDisabled\") == true")
		push("\t\t\tlocal active = button:GetAttribute(\"figrbxActive\") == true")
		push("\t\t\tlocal clicking = pressed and not disabled")
		push("\t\t\tlocal hovering = hovered and not disabled and not pressed")
		push("\t\t\tsetStateVisible(entry, \"disabled\", disabled)")
		push("\t\t\tsetStateVisible(entry, \"clicked\", clicking)")
		push("\t\t\tsetStateVisible(entry, \"hover\", hovering)")
		push("\t\t\tsetStateVisible(entry, \"active\", active and not disabled and not pressed)")
		push("\t\t\tsetStateVisible(entry, \"default\", not disabled and not active and not hovering and not clicking)")
		push("\t\tend")
		push("\t\tbutton.MouseEnter:Connect(function()")
		push("\t\t\thovered = true")
		push("\t\t\trefresh()")
		push("\t\tend)")
		push("\t\tbutton.MouseLeave:Connect(function()")
		push("\t\t\thovered = false")
		push("\t\t\tpressed = false")
		push("\t\t\trefresh()")
		push("\t\tend)")
		push("\t\tbutton.InputBegan:Connect(function(input)")
		push("\t\t\tif input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then")
		push("\t\t\t\tpressed = true")
		push("\t\t\t\trefresh()")
		push("\t\t\tend")
		push("\t\tend)")
		push("\t\tbutton.InputEnded:Connect(function(input)")
		push("\t\t\tif input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then")
		push("\t\t\t\tpressed = false")
		push("\t\t\t\trefresh()")
		push("\t\t\tend")
		push("\t\tend)")
		push("\t\tbutton:GetPropertyChangedSignal(\"Interactable\"):Connect(refresh)")
		push("\t\tbutton:GetAttributeChangedSignal(\"figrbxDisabled\"):Connect(refresh)")
		push("\t\tbutton:GetAttributeChangedSignal(\"figrbxActive\"):Connect(refresh)")
		push("\t\trefresh()")
		push("\tend")
		push("end")
		push("")
	end

	if hasSelects then
		push("local selects = {")
		for _, entry in ipairs(selects) do
			push(
				string.format(
					"\t{ group = %s, id = %s },",
					quote(entry.group),
					quote(entry.id)
				)
			)
		end
		push("}")
		push("local selectGroups = {}")
		push("for _, entry in ipairs(selects) do")
		push("\tlocal group = selectGroups[entry.group]")
		push("\tif not group then")
		push("\t\tgroup = {}")
		push("\t\tselectGroups[entry.group] = group")
		push("\tend")
		push("\ttable.insert(group, entry.id)")
		push("end")
		push("local function setSelected(id, selected)")
		push("\tlocal node = find(id)")
		push("\tif not node then")
		push("\t\treturn")
		push("\tend")
		push("\tnode:SetAttribute(\"FWSelected\", selected)")
		push("\tnode:SetAttribute(\"figrbxActive\", selected)")
		push("\tlocal stroke = node:FindFirstChildOfClass(\"UIStroke\")")
		push("\tif stroke then")
		push("\t\t-- Keep the authored transparency so unselecting restores it.")
		push("\t\tlocal base = stroke:GetAttribute(\"figrbxBaseTransparency\")")
		push("\t\tif base == nil then")
		push("\t\t\tbase = stroke.Transparency")
		push("\t\t\tstroke:SetAttribute(\"figrbxBaseTransparency\", base)")
		push("\t\tend")
		push("\t\tlocal goal = selected and 0 or base")
		push("\t\tTweenService:Create(stroke, TweenInfo.new(0.15), { Transparency = goal }):Play()")
		push("\tend")
		push("end")
		push("for _, entry in ipairs(selects) do")
		push("\tlocal button = find(entry.id)")
		push("\tif button and button:IsA(\"GuiButton\") then")
		push("\t\tbutton.Activated:Connect(function()")
		push("\t\t\tlocal parent = find(entry.group)")
		push("\t\t\tfor _, id in ipairs(selectGroups[entry.group]) do")
		push("\t\t\t\tsetSelected(id, id == entry.id)")
		push("\t\t\tend")
		push("\t\t\tif parent then")
		push("\t\t\t\tparent:SetAttribute(\"FWSelected\", button.Name)")
		push("\t\t\tend")
		push("\t\tend)")
		push("\tend")
		push("end")
		push("")
	end

	if hasDim then
		push("local dimBase = {}")
		push("local function setDim(button, on)")
		push("\tlocal base = dimBase[button]")
		push("\tif not base then")
		push("\t\tbase = {")
		push("\t\t\tbackground = button.BackgroundColor3,")
		push("\t\t\timage = button.ImageColor3,")
		push("\t\t\ttext = button.TextColor3,")
		push("\t\t}")
		push("\t\tdimBase[button] = base")
		push("\tend")
		push("\tlocal factor = on and 0.88 or 1")
		push("\tlocal goal = {}")
		push("\tif button:IsA(\"ImageButton\") then")
		push("\t\tgoal.ImageColor3 = base.image * factor")
		push("\tend")
		push("\tif button:IsA(\"TextButton\") then")
		push("\t\tgoal.TextColor3 = base.text * factor")
		push("\tend")
		push("\tif button.BackgroundTransparency < 1 then")
		push("\t\tgoal.BackgroundColor3 = base.background * factor")
		push("\tend")
		push("\tTweenService:Create(button, TweenInfo.new(0.12), goal):Play()")
		push("end")
		push("for _, id in ipairs({")
		for _, id in ipairs(dimButtons) do
			push(string.format("\t%s,", quote(id)))
		end
		push("}) do")
		push("\tlocal button = find(id)")
		push("\tif button and button:IsA(\"GuiButton\") then")
		push("\t\tbutton.MouseEnter:Connect(function()")
		push("\t\t\tsetDim(button, true)")
		push("\t\tend)")
		push("\t\tbutton.MouseLeave:Connect(function()")
		push("\t\t\tsetDim(button, false)")
		push("\t\tend)")
		push("\tend")
		push("end")
		push("")
	end

	if hasPointers then
		push("local RunService = game:GetService(\"RunService\")")
		push("local UserInputService = game:GetService(\"UserInputService\")")
		push("local GuiService = game:GetService(\"GuiService\")")
		push("-- GetMouseLocation is screen-space; AbsolutePosition is GUI-space.")
		push("local mouseOffset = Vector2.new(0, 0)")
		push("if not screen.IgnoreGuiInset then")
		push("\tmouseOffset = GuiService:GetGuiInset()")
		push("end")
		push("local pointerTargets = {}")
		push("for _, entry in ipairs({")
		for _, entry in ipairs(pointers) do
			push(
				string.format(
					"\t{ id = %s, lean = %s, magnet = %s },",
					quote(entry.id),
					entry.lean and "true" or "false",
					entry.magnet and "true" or "false"
				)
			)
		end
		push("}) do")
		push("\tlocal button = find(entry.id)")
		push("\tif button and button:IsA(\"GuiButton\") then")
		push("\t\ttable.insert(pointerTargets, {")
		push("\t\t\tbutton = button,")
		push("\t\t\tlean = entry.lean,")
		push("\t\t\tmagnet = entry.magnet,")
		push("\t\t\tbaseRotation = button.Rotation,")
		push("\t\t\tbasePosition = button.Position,")
		push("\t\t\thovering = false,")
		push("\t\t})")
		push("\tend")
		push("end")
		push("local function resetPointer(target)")
		push("\ttarget.hovering = false")
		push("\tTweenService:Create(target.button, TweenInfo.new(0.2), {")
		push("\t\tRotation = target.baseRotation,")
		push("\t\tPosition = target.basePosition,")
		push("\t}):Play()")
		push("end")
		push("for _, target in ipairs(pointerTargets) do")
		push("\ttarget.button.MouseEnter:Connect(function()")
		push("\t\ttarget.hovering = true")
		push("\tend)")
		push("\ttarget.button.MouseLeave:Connect(function()")
		push("\t\tresetPointer(target)")
		push("\tend)")
		push("end")
		push("if #pointerTargets > 0 then")
		push("\tRunService.RenderStepped:Connect(function()")
		push("\t\tlocal raw = UserInputService:GetMouseLocation()")
		push("\t\tlocal mouse = Vector2.new(raw.X - mouseOffset.X, raw.Y - mouseOffset.Y)")
		push("\t\tfor _, target in ipairs(pointerTargets) do")
		push("\t\t\tif target.hovering then")
		push("\t\t\t\tlocal button = target.button")
		push("\t\t\t\tlocal size = button.AbsoluteSize")
		push("\t\t\t\tlocal position = button.AbsolutePosition")
		push("\t\t\t\tlocal dx = (mouse.X - (position.X + size.X / 2)) / math.max(size.X, 1)")
		push("\t\t\t\tlocal dy = (mouse.Y - (position.Y + size.Y / 2)) / math.max(size.Y, 1)")
		push("\t\t\t\tlocal rotation = target.baseRotation")
		push("\t\t\t\tlocal x = target.basePosition.X")
		push("\t\t\t\tlocal y = target.basePosition.Y")
		push("\t\t\t\tif target.lean then")
		push("\t\t\t\t\trotation = target.baseRotation - dx * 10")
		push("\t\t\t\tend")
		push("\t\t\t\tif target.magnet then")
		push("\t\t\t\t\tx = UDim.new(x.Scale, x.Offset + dx * 12)")
		push("\t\t\t\t\ty = UDim.new(y.Scale, y.Offset + dy * 12)")
		push("\t\t\t\tend")
		push("\t\t\t\tbutton.Rotation = rotation")
		push("\t\t\t\tbutton.Position = UDim2.new(x.Scale, x.Offset, y.Scale, y.Offset)")
		push("\t\t\tend")
		push("\t\tend")
		push("\tend)")
		push("end")
		push("")
	end

	if hasHolds then
		push("local holds = {")
		for _, entry in ipairs(holds) do
			push(string.format("\t%s,", quote(entry.id)))
		end
		push("}")
		push("-- The prompt lives on the anchor part; the design is adorned to it.")
		push("local adornee = nil")
		push("if screen:IsA(\"BillboardGui\") or screen:IsA(\"SurfaceGui\") then")
		push("\tadornee = screen.Adornee")
		push("end")
		push("local prompt = adornee and adornee:FindFirstChildOfClass(\"ProximityPrompt\")")
		push("if prompt then")
		push("\tlocal gradients = {}")
		push("\tfor _, id in ipairs(holds) do")
		push("\t\tlocal node = find(id)")
		push("\t\tlocal stroke = node and node:FindFirstChildOfClass(\"UIStroke\")")
		push("\t\tlocal gradient = stroke")
		push("\t\t\tand (stroke:FindFirstChild(\"HoldGradient\") or stroke:FindFirstChildOfClass(\"UIGradient\"))")
		push("\t\tif gradient then")
		push("\t\t\ttable.insert(gradients, gradient)")
		push("\t\t\tgradient.Offset = Vector2.new(1, 0)")
		push("\t\tend")
		push("\tend")
		push("\tlocal function sweep(offset, duration)")
		push("\t\tfor _, gradient in ipairs(gradients) do")
		push("\t\t\tTweenService:Create(gradient, TweenInfo.new(duration), { Offset = offset }):Play()")
		push("\t\tend")
		push("\tend")
		push("\tprompt.PromptButtonHoldBegan:Connect(function()")
		push("\t\tsweep(Vector2.new(0, 0), prompt.HoldDuration)")
		push("\tend)")
		push("\tprompt.PromptButtonHoldEnded:Connect(function()")
		push("\t\tsweep(Vector2.new(1, 0), 0.15)")
		push("\tend)")
		push("\tprompt.Triggered:Connect(function()")
		push("\t\tsweep(Vector2.new(0, 0), 0.05)")
		push("\t\ttask.delay(0.3, function()")
		push("\t\t\tsweep(Vector2.new(1, 0), 0.25)")
		push("\t\tend)")
		push("\tend)")
		push("end")
		push("")
	end

	if hasTabs then
		push("local tabs = {")
		for _, entry in ipairs(tabs) do
			if entry.page ~= "" then
				push(
					string.format(
						"\t{ group = %s, tab = %s, page = %s },",
						quote(entry.group),
						quote(entry.tab),
						quote(entry.page)
					)
				)
			end
		end
		push("}")
		push("local firstPage = {}")
		push("local firstTab = {}")
		push("for _, entry in ipairs(tabs) do")
		push("\tif not firstPage[entry.group] then")
		push("\t\tfirstPage[entry.group] = entry.page")
		push("\t\tfirstTab[entry.group] = entry.tab")
		push("\tend")
		push("end")
		push("for _, entry in ipairs(tabs) do")
		push("\tlocal page = find(entry.page)")
		push("\tif page then")
		push("\t\tpage.Visible = (entry.page == firstPage[entry.group])")
		push("\tend")
		push("\tlocal tab = find(entry.tab)")
		push("\tif tab then")
		push("\t\ttab:SetAttribute(\"figrbxActive\", entry.tab == firstTab[entry.group])")
		push("\tend")
		push("\tif tab and tab:IsA(\"GuiButton\") then")
		push("\t\ttab.Activated:Connect(function()")
		push("\t\t\tfor _, other in ipairs(tabs) do")
		push("\t\t\t\tif other.group == entry.group then")
		push("\t\t\t\t\tlocal otherPage = find(other.page)")
		push("\t\t\t\t\tlocal otherTab = find(other.tab)")
		push("\t\t\t\t\tif otherPage then")
		push("\t\t\t\t\t\totherPage.Visible = (other == entry)")
		push("\t\t\t\t\tend")
		push("\t\t\t\t\tif otherTab then")
		push("\t\t\t\t\t\totherTab:SetAttribute(\"figrbxActive\", other == entry)")
		push("\t\t\t\t\tend")
		push("\t\t\t\tend")
		push("\t\t\tend")
		push("\t\tend)")
		push("\tend")
		push("end")
		push("")
	end

	if #bindings > 0 or hasBinds then
		push("local bindings = {")
		for _, entry in ipairs(bindings) do
			local names = {}
			for _, name in ipairs(entry.names) do
				table.insert(names, quote(name))
			end
			push(
				string.format(
					"\t{ id = %s, names = { %s }, format = %s },",
					quote(entry.id),
					table.concat(names, ", "),
					quote(entry.format)
				)
			)
		end
		push("}")
		if hasBinds then
			push("local binds = {")
			for _, entry in ipairs(binds) do
				push(string.format("\t{ id = %s, path = %s },", quote(entry.id), quote(entry.path)))
			end
			push("}")
		end
		push("local function formatText(format, values)")
		push("\tlocal parts = string.split(format, \"%s\")")
		push("\tlocal out = parts[1] or \"\"")
		push("\tfor index = 2, #parts do")
		push("\t\tout = out .. (values[index - 1] or \"\") .. parts[index]")
		push("\tend")
		push("\treturn out")
		push("end")
		push("local Players = game:GetService(\"Players\")")
		push("local player = Players.LocalPlayer")
		push("local function leaderstat(name)")
		push("\tif not player then")
		push("\t\treturn nil")
		push("\tend")
		push("\tlocal stats = player:FindFirstChild(\"leaderstats\")")
		push("\tif not stats then")
		push("\t\treturn nil")
		push("\tend")
		push("\tlocal value = stats:FindFirstChild(name)")
		push("\tif value and value:IsA(\"ValueBase\") then")
		push("\t\treturn value")
		push("\tend")
		push("\treturn nil")
		push("end")
		push("local function resolveBinding(name)")
		push("\tif name == \"PlayerName\" or name == \"Player\" then")
		push("\t\tif player then")
		push("\t\t\treturn player.Name")
		push("\t\tend")
		push("\t\treturn \"\"")
		push("\tend")
		push("\tif name == \"DisplayName\" then")
		push("\t\tif player then")
		push("\t\t\treturn player.DisplayName")
		push("\t\tend")
		push("\t\treturn \"\"")
		push("\tend")
		push("\tlocal attributeName = name")
		push("\tlocal explicit = string.sub(name, 1, 5) == \"attr:\"")
		push("\tif explicit then")
		push("\t\tattributeName = string.sub(name, 6)")
		push("\tend")
		push("\tlocal stat = leaderstat(attributeName)")
		push("\tif stat then")
		push("\t\treturn tostring(stat.Value)")
		push("\tend")
		push("\tif explicit then")
		push("\t\tlocal value = player and player:GetAttribute(attributeName)")
		push("\t\tif value ~= nil then")
		push("\t\t\treturn tostring(value)")
		push("\t\tend")
		push("\t\treturn \"\"")
		push("\tend")
		push("\t-- Older imports bound {Coins} to a ScreenGui attribute.")
		push("\tlocal value = screen:GetAttribute(attributeName)")
		push("\tif value ~= nil then")
		push("\t\treturn tostring(value)")
		push("\tend")
		push("\treturn \"\"")
		push("end")
		if hasBinds then
			push("local function valueAtPath(path)")
			push("\tif not player then")
			push("\t\treturn \"\"")
			push("\tend")
			push("\tif path == \"PlayerName\" or path == \"Player\" then")
			push("\t\treturn player.Name")
			push("\tend")
			push("\tif path == \"DisplayName\" then")
			push("\t\treturn player.DisplayName")
			push("\tend")
			push("\tif string.sub(path, 1, 5) == \"attr:\" then")
			push("\t\tlocal value = player:GetAttribute(string.sub(path, 6))")
			push("\t\treturn value ~= nil and tostring(value) or \"\"")
			push("\tend")
			push("\tif string.find(path, \".\", 1, true) then")
			push("\t\tlocal current = player")
			push("\t\tfor segment in string.gmatch(path, \"[^.]+\") do")
			push("\t\t\tcurrent = current:FindFirstChild(segment)")
			push("\t\t\tif not current then")
			push("\t\t\t\treturn \"\"")
			push("\t\t\tend")
			push("\t\tend")
			push("\t\tif current:IsA(\"ValueBase\") then")
			push("\t\t\treturn tostring(current.Value)")
			push("\t\tend")
			push("\t\treturn current.Name")
			push("\tend")
			push("\tlocal stats = player:FindFirstChild(\"leaderstats\")")
			push("\tlocal stat = stats and stats:FindFirstChild(path)")
			push("\tif stat and stat:IsA(\"ValueBase\") then")
			push("\t\treturn tostring(stat.Value)")
			push("\tend")
			push("\tlocal attribute = player:GetAttribute(path)")
			push("\tif attribute ~= nil then")
			push("\t\treturn tostring(attribute)")
			push("\tend")
			push("\tlocal fallback = screen:GetAttribute(path)")
			push("\tif fallback ~= nil then")
			push("\t\treturn tostring(fallback)")
			push("\tend")
			push("\treturn \"\"")
			push("end")
		end
		push("local function refreshBindings()")
		push("\tfor _, entry in ipairs(bindings) do")
		push("\t\tlocal node = find(entry.id)")
		push("\t\tif node and (node:IsA(\"TextLabel\") or node:IsA(\"TextButton\")) then")
		push("\t\t\tlocal values = {}")
		push("\t\t\tfor _, name in ipairs(entry.names) do")
		push("\t\t\t\tvalues[#values + 1] = resolveBinding(name)")
		push("\t\t\tend")
		push("\t\t\tnode.Text = formatText(entry.format, values)")
		push("\t\tend")
		push("\tend")
		if hasBinds then
			push("\tfor _, entry in ipairs(binds) do")
			push("\t\tlocal node = find(entry.id)")
			push("\t\tif node and (node:IsA(\"TextLabel\") or node:IsA(\"TextButton\")) then")
			push("\t\t\tnode.Text = valueAtPath(entry.path)")
			push("\t\tend")
			push("\tend")
		end
		push("end")
		push("local function watchValue(value)")
		push("\tvalue:GetPropertyChangedSignal(\"Value\"):Connect(refreshBindings)")
		push("end")
		push("local function watchLeaderstats()")
		push("\tif not player then")
		push("\t\treturn")
		push("\tend")
		push("\tlocal stats = player:FindFirstChild(\"leaderstats\")")
		push("\tif stats then")
		push("\t\tfor _, value in ipairs(stats:GetChildren()) do")
		push("\t\t\tif value:IsA(\"ValueBase\") then")
		push("\t\t\t\twatchValue(value)")
		push("\t\t\tend")
		push("\t\tend")
		push("\t\tstats.ChildAdded:Connect(function(child)")
		push("\t\t\tif child:IsA(\"ValueBase\") then")
		push("\t\t\t\twatchValue(child)")
		push("\t\t\tend")
		push("\t\t\trefreshBindings()")
		push("\t\tend)")
		push("\tend")
		push("\tplayer.ChildAdded:Connect(function(child)")
		push("\t\tif child.Name == \"leaderstats\" then")
		push("\t\t\twatchLeaderstats()")
		push("\t\t\trefreshBindings()")
		push("\t\tend")
		push("\tend)")
		push("end")
		push("watchLeaderstats()")
		push("if player then")
		push("\tplayer.AttributeChanged:Connect(refreshBindings)")
		push("end")
		push("for _, entry in ipairs(bindings) do")
		push("\tfor _, name in ipairs(entry.names) do")
		push("\t\tscreen:GetAttributeChangedSignal(name):Connect(refreshBindings)")
		push("\t\tif string.sub(name, 1, 5) == \"attr:\" then")
		push("\t\t\tscreen:GetAttributeChangedSignal(string.sub(name, 6)):Connect(refreshBindings)")
		push("\t\tend")
		push("\tend")
		push("end")
		if hasBinds then
			push("for _, entry in ipairs(binds) do")
			push("\tif string.sub(entry.path, 1, 5) ~= \"attr:\" then")
			push("\t\tscreen:GetAttributeChangedSignal(entry.path):Connect(refreshBindings)")
			push("\tend")
			push("end")
		end
		if hasComplexPaths then
			push("-- Dotted paths are not signal-backed; poll them instead.")
			push("task.spawn(function()")
			push("\twhile true do")
			push("\t\ttask.wait(0.5)")
			push("\t\trefreshBindings()")
			push("\tend")
			push("end)")
		end
		push("refreshBindings()")
	end

	return table.concat(lines, "\n") .. "\n"
end

return Behaviors
