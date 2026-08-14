-- Simple fly script
local Player = game.Players.LocalPlayer
local Character = Player.Character
local Root = Character and Character:FindFirstChild("HumanoidRootPart")
if not Root then return end

local flySpeed = 50
local flying = true

-- Fly implementation