--!strict
-- Minimal JSON-over-HTTP client for the local bridge.

local HttpService = game:GetService("HttpService")

local Http = {}

export type Response = {
	Success: boolean,
	StatusCode: number,
	StatusMessage: string,
}

-- Returns the raw response (or nil plus an error string) and the decoded body.
function Http.request(
	baseUrl: string,
	path: string,
	method: string,
	token: string,
	body: any?
): (Response?, any?)
	local headers: { [string]: string } = {
		["Content-Type"] = "application/json",
	}
	if token ~= "" then
		headers.Authorization = "Bearer " .. token
	end

	local options: { [string]: any } = {
		Url = baseUrl .. path,
		Method = method,
		Headers = headers,
	}
	if body ~= nil then
		options.Body = HttpService:JSONEncode(body)
	end

	local ok, response = pcall(function()
		return HttpService:RequestAsync(options)
	end)
	if not ok then
		return nil, tostring(response)
	end

	local decoded: any? = nil
	if response.Body and response.Body ~= "" then
		local decodedOk, value = pcall(function()
			return HttpService:JSONDecode(response.Body)
		end)
		if decodedOk then
			decoded = value
		end
	end

	return response :: Response, decoded
end

return Http
