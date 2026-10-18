--!strict
-- figrbx Studio plugin entry point.
-- Fetches conversion specs from the local bridge and builds native GUI
-- instances under StarterGui.

local HttpService = game:GetService("HttpService")

local Http = require(script.http)
local Ui = require(script.ui)
local Materialize = require(script.materialize)

local DEFAULT_BRIDGE = "http://localhost:17341"

local toolbar = plugin:CreateToolbar("figrbx")
local toolbarButton = toolbar:CreateButton("figrbx", "Import a Figma frame", "")
toolbarButton.ClickableWhenViewportHidden = true

local widgetInfo = DockWidgetPluginGuiInfo.new(
	Enum.InitialDockState.Right,
	false,
	false,
	340,
	560,
	300,
	400
)
-- CreateDockWidgetPluginGuiAsync is the current API; the synchronous form is
-- kept as a fallback for older Studio builds.
local widget = nil
if typeof((plugin :: any).CreateDockWidgetPluginGuiAsync) == "function" then
	widget = (plugin :: any):CreateDockWidgetPluginGuiAsync("figrbx", widgetInfo)
else
	-- selene: allow(deprecated)
	widget = plugin:CreateDockWidgetPluginGui("figrbx", widgetInfo)
end
widget.Title = "figrbx"
widget.Name = "figrbx"

local settings = {
	bridgeUrl = plugin:GetSetting("figrbx.bridgeUrl") or DEFAULT_BRIDGE,
	token = plugin:GetSetting("figrbx.token") or "",
	liveSync = plugin:GetSetting("figrbx.liveSync") or false,
}

local recent = plugin:GetSetting("figrbx.recent") or {}

local lastCode: string? = nil
local lastRevision = 0
local liveTokenId = 0
local liveThread: thread? = nil

local ui: any

local function normalizeBase(url: string): string
	local trimmed = string.match(url, "^%s*(.-)%s*$") or url
	if trimmed == "" then
		return DEFAULT_BRIDGE
	end
	if not string.match(trimmed, "^https?://") then
		trimmed = "http://" .. trimmed
	end
	return (string.gsub(trimmed, "/+$", ""))
end

local function persist()
	plugin:SetSetting("figrbx.bridgeUrl", settings.bridgeUrl)
	plugin:SetSetting("figrbx.token", settings.token)
	plugin:SetSetting("figrbx.liveSync", settings.liveSync)
end

local function setStatus(message: string, isError: boolean?)
	if ui then
		ui.setStatus(message, isError)
	end
end

local function setBridgeStatus(message: string, ok: boolean?)
	if ui then
		ui.setBridgeStatus(message, ok)
	end
end

local function remember(code: string, name: string)
	table.insert(recent, 1, { code = code, name = name })
	while #recent > 6 do
		table.remove(recent)
	end
	plugin:SetSetting("figrbx.recent", recent)
	if ui then
		ui.setRecent(recent)
	end
end

local function stopLive()
	liveTokenId += 1
	if liveThread then
		pcall(task.cancel, liveThread)
		liveThread = nil
	end
end

local function startLive(code: string)
	stopLive()
	local myToken = liveTokenId
	liveThread = task.spawn(function()
		while liveTokenId == myToken do
			task.wait(2)
			if liveTokenId ~= myToken then
				break
			end
			local response, data = Http.request(
				settings.bridgeUrl,
				"/api/spec/" .. code .. "?since=" .. tostring(lastRevision),
				"GET",
				settings.token
			)
			if response and response.StatusCode == 200 and data and data.revision then
				local revision = tonumber(data.revision) or 0
				if revision > lastRevision then
					lastRevision = revision
					local ok, err = pcall(function()
						local report = Materialize.run(data.spec, code)
						setStatus(
							string.format("Live sync updated %s · %d nodes", code, report.created),
							false
						)
					end)
					if not ok then
						setStatus("Live sync failed: " .. tostring(err), true)
					end
				end
			end
		end
	end)
end

local function importSpec(code: string, fromLive: boolean): boolean
	setStatus("Fetching " .. code .. "…", false)
	local response, data = Http.request(
		settings.bridgeUrl,
		"/api/spec/" .. code,
		"GET",
		settings.token
	)
	if not response then
		setStatus("Bridge unreachable: " .. tostring(data), true)
		return false
	end
	if response.StatusCode == 401 then
		setStatus("The bridge rejected the token. Copy it from the bridge output.", true)
		return false
	end
	if response.StatusCode == 404 then
		setStatus("Unknown or expired code.", true)
		return false
	end
	if not response.Success or not data or not data.spec then
		setStatus("Import failed (HTTP " .. tostring(response.StatusCode) .. ").", true)
		return false
	end

	local ok, reportOrError = pcall(function()
		return Materialize.run(data.spec, code)
	end)
	if not ok then
		setStatus("Could not build the interface: " .. tostring(reportOrError), true)
		return false
	end

	local report = reportOrError :: any
	lastCode = code
	lastRevision = tonumber(data.revision) or 0

	local message = string.format("Imported %d nodes from %s.", report.created, code)
	if #report.skipped > 0 then
		message ..= string.format(" %d unsupported nodes skipped.", #report.skipped)
	end
	if #report.propFailures > 0 then
		message ..= string.format(" %d properties approximated.", #report.propFailures)
	end
	if report.controller == false then
		message ..= " Enable script injection to use behavior tags."
	end
	setStatus(message, false)

	if not fromLive then
		local screenName = data.spec.screenGui and data.spec.screenGui.name or code
		remember(code, screenName)
		if settings.liveSync then
			startLive(code)
		end
	end

	return true
end

local function testBridge()
	setBridgeStatus("Checking…", false)
	local response, data = Http.request(settings.bridgeUrl, "/api/health", "GET", "")
	if response and response.Success and data then
		local auth = data.auth or {}
		if auth.connected then
			setBridgeStatus("Online · " .. tostring(auth.userName or "Roblox"), true)
		else
			setBridgeStatus("Online · Roblox not connected", true)
		end
	else
		setBridgeStatus("Bridge unreachable", false)
		setStatus("Start the bridge with `npx figrbx`.", true)
	end
end

local function importJson(text: string)
	local trimmed = string.match(text, "^%s*(.-)%s*$") or text
	if trimmed == "" then
		setStatus("Paste a JSON bundle first.", true)
		return
	end

	local decodedOk, bundle = pcall(function()
		return HttpService:JSONDecode(trimmed)
	end)
	if not decodedOk then
		setStatus("That is not valid JSON.", true)
		return
	end

	local odt = bundle.odt or bundle
	if type(odt) ~= "table" or odt.root == nil then
		setStatus("The bundle has no design tree.", true)
		return
	end

	-- Upload any embedded images through the bridge before converting.
	local byRef: { [string]: any } = {}
	for _, image in ipairs(odt.images or {}) do
		if image.ref then
			byRef[image.ref] = image
		end
	end
	for _, image in ipairs(bundle.images or {}) do
		if image.dataBase64 and image.ref and byRef[image.ref] and not byRef[image.ref].assetId then
			setStatus("Uploading image " .. tostring(image.name or image.ref) .. "…", false)
			local response, data = Http.request(
				settings.bridgeUrl,
				"/api/images",
				"POST",
				settings.token,
				{ name = image.name, mime = image.mime, dataBase64 = image.dataBase64 }
			)
			if response and response.Success and data and data.assetId then
				byRef[image.ref].assetId = tostring(data.assetId)
			else
				setStatus("Image upload failed: " .. tostring(data and data.error or "unknown"), true)
				return
			end
		end
	end

	setStatus("Converting…", false)
	local response, data = Http.request(
		settings.bridgeUrl,
		"/api/convert",
		"POST",
		settings.token,
		{ odt = odt }
	)
	if not response or not response.Success or not data or not data.code then
		local reason = data and data.error or (response and ("HTTP " .. tostring(response.StatusCode)) or "bridge unreachable")
		setStatus("Conversion failed: " .. tostring(reason), true)
		return
	end
	importSpec(tostring(data.code), false)
end

ui = Ui.create(widget, {
	onTest = function()
		testBridge()
	end,
	onImport = function(code: string)
		importSpec(code, false)
	end,
	onLiveToggle = function(current: boolean): boolean
		settings.liveSync = not current
		persist()
		if settings.liveSync and lastCode then
			startLive(lastCode)
			setStatus("Live sync on.", false)
		else
			stopLive()
			setStatus("Live sync off.", false)
		end
		return settings.liveSync
	end,
	onImportJson = function(text: string)
		importJson(text)
	end,
	onUrlChanged = function(url: string)
		settings.bridgeUrl = normalizeBase(url)
		persist()
		testBridge()
	end,
	onTokenChanged = function(token: string)
		settings.token = token
		persist()
		testBridge()
	end,
}, settings)

ui.setRecent(recent)
testBridge()

toolbarButton.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)
