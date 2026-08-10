-- Not listed anywhere in fxmanifest.lua. Reached only via server/main.lua's
-- require('server.modules.kick_reason') call - should get the "R" (required) badge.

local KickReason = {}

function KickReason.get()
  return 'Testing Perfect FiveM'
end

return KickReason
