--!strict
-- Typed property decoding for the instance spec produced by @figrbx/core.

local Props = {}

local ALLOWED_CLASSES = {
	ScreenGui = true,
	BillboardGui = true,
	SurfaceGui = true,
	ProximityPrompt = true,
	Frame = true,
	TextLabel = true,
	TextButton = true,
	TextBox = true,
	ImageLabel = true,
	ImageButton = true,
	ScrollingFrame = true,
	CanvasGroup = true,
	UICorner = true,
	UIStroke = true,
	UIGradient = true,
	UIShadow = true,
	UIListLayout = true,
	UIGridLayout = true,
	UIAspectRatioConstraint = true,
}

export type Failure = { node: string, property: string, reason: string }

local function color3(values: { number }): Color3
	return Color3.new(values[1], values[2], values[3])
end

local function decode(value: any): any
	local kind = value.t
	if kind == "udim2" then
		local v = value.v
		return UDim2.new(v[1], v[2], v[3], v[4])
	elseif kind == "udim" then
		local v = value.v
		return UDim.new(v[1], v[2])
	elseif kind == "color3" then
		return color3(value.v)
	elseif kind == "number" or kind == "string" or kind == "boolean" then
		return value.v
	elseif kind == "vector2" then
		return Vector2.new(value.v[1], value.v[2])
	elseif kind == "vector3" then
		return Vector3.new(value.v[1], value.v[2], value.v[3])
	elseif kind == "enum" then
		local enumType = Enum[value.enum]
		assert(enumType, "unknown enum " .. tostring(value.enum))
		local item = enumType[value.name]
		assert(item, "unknown enum item " .. tostring(value.enum) .. "." .. tostring(value.name))
		return item
	elseif kind == "font" then
		local font = Enum.Font[value.name]
		assert(font, "unknown font " .. tostring(value.name))
		return font
	elseif kind == "colorsequence" then
		local keypoints = {}
		for _, point in ipairs(value.v) do
			table.insert(keypoints, ColorSequenceKeypoint.new(point.t, color3(point.color)))
		end
		return ColorSequence.new(keypoints)
	elseif kind == "numbersequence" then
		local keypoints = {}
		for _, point in ipairs(value.v) do
			table.insert(keypoints, NumberSequenceKeypoint.new(point.t, point.value))
		end
		return NumberSequence.new(keypoints)
	end
	error("unknown property type " .. tostring(kind))
end

function Props.isAllowed(className: string): boolean
	return ALLOWED_CLASSES[className] == true
end

-- Applies every property with pcall so one bad value cannot abort the import.
-- Returns the failures for the import report.
function Props.apply(instance: Instance, values: { [string]: any }): { Failure }
	local failures: { Failure } = {}
	for name, value in pairs(values) do
		local ok, err = pcall(function()
			(instance :: any)[name] = decode(value)
		end)
		if not ok then
			table.insert(failures, {
				node = instance.Name,
				property = name,
				reason = tostring(err),
			})
		end
	end
	return failures
end

function Props.decode(value: any): any
	return decode(value)
end

return Props
