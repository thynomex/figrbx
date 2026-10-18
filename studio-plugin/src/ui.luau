--!strict
-- Dock-widget UI. Built in code so the plugin ships as a single model.

local Ui = {}

type Callbacks = {
	onTest: () -> (),
	onImport: (string) -> (),
	onLiveToggle: (boolean) -> boolean,
	onImportJson: (string) -> (),
	onUrlChanged: (string) -> (),
	onTokenChanged: (string) -> (),
}

local COLORS = {
	bg = Color3.fromRGB(13, 11, 18),
	panel = Color3.fromRGB(22, 19, 30),
	panelAlt = Color3.fromRGB(29, 25, 41),
	line = Color3.fromRGB(45, 39, 64),
	text = Color3.fromRGB(239, 236, 246),
	muted = Color3.fromRGB(142, 134, 163),
	accent = Color3.fromRGB(139, 92, 246),
	accentStrong = Color3.fromRGB(109, 63, 242),
	good = Color3.fromRGB(74, 222, 128),
	bad = Color3.fromRGB(248, 113, 113),
}

local function corner(instance: Instance, radius: number)
	local uiCorner = Instance.new("UICorner")
	uiCorner.CornerRadius = UDim.new(0, radius)
	uiCorner.Parent = instance
end

local function padding(instance: Instance, amount: number)
	local uiPadding = Instance.new("UIPadding")
	local value = UDim.new(0, amount)
	uiPadding.PaddingTop = value
	uiPadding.PaddingBottom = value
	uiPadding.PaddingLeft = value
	uiPadding.PaddingRight = value
	uiPadding.Parent = instance
end

local function label(parent: Instance, text: string, order: number, size: number?, color: Color3?): TextLabel
	local instance = Instance.new("TextLabel")
	instance.LayoutOrder = order
	instance.Size = UDim2.new(1, 0, 0, size or 16)
	instance.BackgroundTransparency = 1
	instance.Font = Enum.Font.GothamMedium
	instance.TextSize = 12
	instance.TextColor3 = color or COLORS.muted
	instance.TextXAlignment = Enum.TextXAlignment.Left
	instance.Text = text
	instance.TextWrapped = true
	instance.Parent = parent
	return instance
end

local function titleLabel(parent: Instance, text: string, order: number): TextLabel
	local instance = label(parent, text, order, 18, COLORS.text)
	instance.Font = Enum.Font.GothamBold
	instance.TextSize = 13
	return instance
end

local function card(parent: Instance, order: number, height: number, spacing: number): Frame
	local frame = Instance.new("Frame")
	frame.LayoutOrder = order
	frame.Size = UDim2.new(1, 0, 0, height)
	frame.BackgroundColor3 = COLORS.panel
	frame.BorderSizePixel = 0
	frame.Parent = parent
	corner(frame, 10)
	padding(frame, 10)

	local layout = Instance.new("UIListLayout")
	layout.Padding = UDim.new(0, spacing)
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Parent = frame
	return frame
end

local function textBox(parent: Instance, order: number, placeholder: string, text: string, height: number?): TextBox
	local instance = Instance.new("TextBox")
	instance.LayoutOrder = order
	instance.Size = UDim2.new(1, 0, 0, height or 30)
	instance.BackgroundColor3 = COLORS.panelAlt
	instance.BorderSizePixel = 0
	instance.Font = Enum.Font.GothamMedium
	instance.TextSize = 12
	instance.TextColor3 = COLORS.text
	instance.PlaceholderText = placeholder
	instance.PlaceholderColor3 = COLORS.muted
	instance.Text = text
	instance.TextXAlignment = Enum.TextXAlignment.Left
	instance.ClearTextOnFocus = false
	instance.Parent = parent
	corner(instance, 7)
	return instance
end

local function button(parent: Instance, order: number, text: string, primary: boolean?): TextButton
	local instance = Instance.new("TextButton")
	instance.LayoutOrder = order
	instance.Size = UDim2.new(1, 0, 0, 30)
	instance.BackgroundColor3 = if primary then COLORS.accentStrong else COLORS.panelAlt
	instance.BorderSizePixel = 0
	instance.Font = Enum.Font.GothamBold
	instance.TextSize = 12
	instance.TextColor3 = COLORS.text
	instance.Text = text
	instance.AutoButtonColor = true
	instance.Parent = parent
	corner(instance, 7)
	return instance
end

local function row(parent: Instance, order: number, height: number): Frame
	local frame = Instance.new("Frame")
	frame.LayoutOrder = order
	frame.Size = UDim2.new(1, 0, 0, height)
	frame.BackgroundTransparency = 1
	frame.Parent = parent
	local layout = Instance.new("UIListLayout")
	layout.FillDirection = Enum.FillDirection.Horizontal
	layout.Padding = UDim.new(0, 8)
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.VerticalAlignment = Enum.VerticalAlignment.Center
	layout.Parent = frame
	return frame
end

function Ui.create(widget: DockWidgetPluginGui, callbacks: Callbacks, initial: { bridgeUrl: string, token: string, liveSync: boolean })
	local root = Instance.new("ScrollingFrame")
	root.Name = "Root"
	root.Size = UDim2.fromScale(1, 1)
	root.BackgroundColor3 = COLORS.bg
	root.BackgroundTransparency = 0
	root.BorderSizePixel = 0
	root.ScrollBarThickness = 4
	root.AutomaticCanvasSize = Enum.AutomaticSize.Y
	root.CanvasSize = UDim2.fromScale(0, 0)
	root.Parent = widget
	padding(root, 12)

	local layout = Instance.new("UIListLayout")
	layout.Padding = UDim.new(0, 10)
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Parent = root

	local header = Instance.new("Frame")
	header.LayoutOrder = 1
	header.Size = UDim2.new(1, 0, 0, 30)
	header.BackgroundTransparency = 1
	header.Parent = root

	local brand = Instance.new("TextLabel")
	brand.Size = UDim2.new(1, 0, 0, 20)
	brand.BackgroundTransparency = 1
	brand.Font = Enum.Font.GothamBlack
	brand.TextSize = 15
	brand.TextColor3 = COLORS.text
	brand.TextXAlignment = Enum.TextXAlignment.Left
	brand.Text = "figrbx"
	brand.Parent = header

	local subtitle = Instance.new("TextLabel")
	subtitle.Position = UDim2.fromOffset(0, 18)
	subtitle.Size = UDim2.new(1, 0, 0, 12)
	subtitle.BackgroundTransparency = 1
	subtitle.Font = Enum.Font.RobotoMono
	subtitle.TextSize = 10
	subtitle.TextColor3 = COLORS.muted
	subtitle.TextXAlignment = Enum.TextXAlignment.Left
	subtitle.Text = "figma → roblox studio"
	subtitle.Parent = header

	-- Bridge
	local bridgeCard = card(root, 2, 140, 6)
	titleLabel(bridgeCard, "Bridge", 1)
	local urlBox = textBox(bridgeCard, 2, "http://localhost:17341", initial.bridgeUrl)
	local tokenBox = textBox(bridgeCard, 3, "Bridge token", initial.token)
	local bridgeRow = row(bridgeCard, 4, 26)
	local testButton = Instance.new("TextButton")
	testButton.Size = UDim2.new(0, 60, 1, 0)
	testButton.BackgroundColor3 = COLORS.panelAlt
	testButton.BorderSizePixel = 0
	testButton.Font = Enum.Font.GothamBold
	testButton.TextSize = 11
	testButton.TextColor3 = COLORS.text
	testButton.Text = "Test"
	testButton.Parent = bridgeRow
	corner(testButton, 6)
	local bridgeStatus = Instance.new("TextLabel")
	bridgeStatus.Size = UDim2.new(1, -68, 1, 0)
	bridgeStatus.BackgroundTransparency = 1
	bridgeStatus.Font = Enum.Font.GothamMedium
	bridgeStatus.TextSize = 10
	bridgeStatus.TextColor3 = COLORS.muted
	bridgeStatus.TextXAlignment = Enum.TextXAlignment.Left
	bridgeStatus.TextTruncate = Enum.TextTruncate.AtEnd
	bridgeStatus.Text = "Not checked"
	bridgeStatus.Parent = bridgeRow

	-- Import
	local importCard = card(root, 3, 128, 6)
	titleLabel(importCard, "Transfer code", 1)
	local codeBox = textBox(importCard, 2, "ABC123", "", 34)
	codeBox.Font = Enum.Font.RobotoMono
	codeBox.TextSize = 16
	codeBox.TextXAlignment = Enum.TextXAlignment.Center
	local importButton = button(importCard, 3, "Import into StarterGui", true)
	local liveButton = button(importCard, 4, if initial.liveSync then "Live sync: on" else "Live sync: off", false)
	liveButton.TextSize = 11

	-- Recent
	local recentCard = card(root, 4, 74, 6)
	titleLabel(recentCard, "Recent", 1)
	local recentList = Instance.new("ScrollingFrame")
	recentList.LayoutOrder = 2
	recentList.Size = UDim2.new(1, 0, 0, 38)
	recentList.BackgroundTransparency = 1
	recentList.BorderSizePixel = 0
	recentList.ScrollBarThickness = 3
	recentList.AutomaticCanvasSize = Enum.AutomaticSize.Y
	recentList.CanvasSize = UDim2.fromScale(0, 0)
	recentList.Parent = recentCard
	local recentLayout = Instance.new("UIListLayout")
	recentLayout.Padding = UDim.new(0, 4)
	recentLayout.Parent = recentList

	-- JSON
	local jsonCard = card(root, 5, 132, 6)
	titleLabel(jsonCard, "Import JSON bundle", 1)
	local jsonBox = textBox(jsonCard, 2, "Paste the file downloaded by the Figma plugin", "", 58)
	jsonBox.TextWrapped = true
	jsonBox.TextYAlignment = Enum.TextYAlignment.Top
	jsonBox.Font = Enum.Font.RobotoMono
	jsonBox.TextSize = 10
	local jsonButton = button(jsonCard, 3, "Import JSON", false)

	-- Status
	local statusLabel = Instance.new("TextLabel")
	statusLabel.LayoutOrder = 6
	statusLabel.Size = UDim2.new(1, 0, 0, 34)
	statusLabel.BackgroundTransparency = 1
	statusLabel.Font = Enum.Font.GothamMedium
	statusLabel.TextSize = 11
	statusLabel.TextColor3 = COLORS.muted
	statusLabel.TextXAlignment = Enum.TextXAlignment.Left
	statusLabel.TextYAlignment = Enum.TextYAlignment.Top
	statusLabel.TextWrapped = true
	statusLabel.Text = "Waiting for a code."
	statusLabel.Parent = root

	local liveEnabled = initial.liveSync

	urlBox.FocusLost:Connect(function()
		callbacks.onUrlChanged(urlBox.Text)
	end)
	tokenBox.FocusLost:Connect(function()
		callbacks.onTokenChanged(tokenBox.Text)
	end)
	testButton.Activated:Connect(function()
		callbacks.onTest()
	end)
	importButton.Activated:Connect(function()
		local code = string.upper(string.gsub(codeBox.Text, "%s", ""))
		if #code ~= 6 then
			statusLabel.TextColor3 = COLORS.bad
			statusLabel.Text = "A transfer code is six characters."
			return
		end
		callbacks.onImport(code)
	end)
	liveButton.Activated:Connect(function()
		liveEnabled = callbacks.onLiveToggle(liveEnabled)
		liveButton.Text = if liveEnabled then "Live sync: on" else "Live sync: off"
	end)
	jsonButton.Activated:Connect(function()
		callbacks.onImportJson(jsonBox.Text)
	end)

	local api = {
		setStatus = function(message: string, isError: boolean?)
			statusLabel.TextColor3 = if isError then COLORS.bad else COLORS.muted
			statusLabel.Text = message
		end,
		setBridgeStatus = function(message: string, ok: boolean?)
			bridgeStatus.TextColor3 = if ok then COLORS.good else COLORS.muted
			bridgeStatus.Text = message
			testButton.Text = if ok then "Online" else "Test"
		end,
		setRecent = function(entries: { { code: string, name: string } })
			for _, child in ipairs(recentList:GetChildren()) do
				if child:IsA("GuiObject") then
					child:Destroy()
				end
			end
			if #entries == 0 then
				local empty = Instance.new("TextLabel")
				empty.Size = UDim2.new(1, 0, 0, 20)
				empty.BackgroundTransparency = 1
				empty.Font = Enum.Font.GothamMedium
				empty.TextSize = 10
				empty.TextColor3 = COLORS.muted
				empty.TextXAlignment = Enum.TextXAlignment.Left
				empty.Text = "No imports yet."
				empty.Parent = recentList
				return
			end
			for index, entry in ipairs(entries) do
				if index > 6 then break end
				local item = Instance.new("TextButton")
				item.Size = UDim2.new(1, 0, 0, 22)
				item.BackgroundColor3 = COLORS.panelAlt
				item.BorderSizePixel = 0
				item.Font = Enum.Font.RobotoMono
				item.TextSize = 10
				item.TextColor3 = COLORS.text
				item.TextXAlignment = Enum.TextXAlignment.Left
				item.TextTruncate = Enum.TextTruncate.AtEnd
				item.Text = string.format("  %s   %s", entry.code, entry.name)
				item.Parent = recentList
				corner(item, 5)
				item.Activated:Connect(function()
					callbacks.onImport(entry.code)
				end)
			end
		end,
	}

	return api
end

return Ui
