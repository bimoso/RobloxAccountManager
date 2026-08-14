-- Simple noclip script
local Player = game.Players.LocalPlayer
local RunService = game:GetService("RunService")

local Connection
Connection = RunService.Stepped:Connect(function()
    local Character = Player.Character
    if not Character then return end
    for _, part in ipairs(Character:GetDescendants()) do
        if part:IsA("BasePart") then
            part.CanCollide = false
        end
    end
end)

-- To disable, run: Connection:Disconnect()