-- This file should show a "C" badge in the Explorer (client-only script).
-- Type "GetEntityCoords" or "IsControlPressed" below to see native completion/hover.

local coords = GetEntityCoords(PlayerPedId())
print(('Player coords: %f %f %f'):format(coords.x, coords.y, coords.z))

-- Intentional misuse for testing diagnostics: DropPlayer is server-only.
-- Perfect FiveM should underline this with a warning.
DropPlayer(1, 'testing wrong-side native diagnostics')

RegisterCommand('testlib', function()
  -- Type "exports['test_lib']:" to see exports IntelliSense from ../test_lib/init.lua
  local result = exports['test_lib']:add(2, 3)
  print('2 + 3 =', result)
end, false)

RegisterNetEvent('test:pong')
AddEventHandler('test:pong', function()
  print('Got pong from server')
end)

-- Type a quote inside TriggerServerEvent( below to see event-name completion ("test:ping").
TriggerServerEvent('test:ping')


ExecuteCommand("testlib")
