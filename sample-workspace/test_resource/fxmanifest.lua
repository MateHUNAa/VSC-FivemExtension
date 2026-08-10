fx_version 'cerulean'
game 'gta5'

author 'Perfect FiveM sample'
description 'Sample resource for manually testing the Perfect FiveM extension'
version '1.0.0'

shared_scripts {
  'shared/*.lua'
}

client_scripts {
  'client/*.lua'
}

server_scripts {
  '@test_lib/init.lua', -- exercises @resource/path import detection
  'server/*.lua'
}
