-- This file should show an "S" badge in the Explorer (server-only script).

RegisterNetEvent('test:ping')
AddEventHandler('test:ping', function(source)
  print(('Got ping from client %s'):format(source))
  TriggerClientEvent('test:pong', source)
end)

RegisterCommand('kickall', function()
  for _, playerId in ipairs(GetPlayers()) do
    DropPlayer(playerId, 'Testing Perfect FiveM')
  end
end, true)

-- Intentional misuse for testing diagnostics: DrawRect is client-only.
-- Perfect FiveM should underline this with a warning.
DrawRect(0.5, 0.5, 0.1, 0.1, 0, 0, 0, 100, false)
