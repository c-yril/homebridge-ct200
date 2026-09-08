# Homebridge CT200

## Homebridge plugin for Bosch EasyControl CT200

[![Build and Lint](https://github.com/lynxcs/homebridge-ct200/actions/workflows/build.yml/badge.svg)](https://github.com/lynxcs/homebridge-ct200/actions/workflows/build.yml)

### Introduction
This homebridge plugin exposes CT200 status allowing for heater control.

**Note:** The thermostat accessory in Home app shows a single button to change the control mode. On is the same as 'Auto' mode in the bosch EasyControl App. Off is the same as 'manual'.

Changing the temperature when set on 'Auto', only changes the setpoint until the next defined setpoint is reached.

### Requirements
- **Homebridge** 1.8 or later, including **Homebridge 2.x**
- **Node.js** 22.10, 24 or 26

### Compatibility
While I haven't tested this for myself, the plugin apparently also works with the Buderus TC100 v2 as well as bosch radiator valves, and probably other smart thermostats that make use of boschs' EasyControl API.

### Installation
To install homebridge ct200:
- Install the plugin through Homebridge Config UI X or manually by:
```
$ sudo npm -g i homebridge-ct200
```
- Configure within Homebridge Config UI X or edit `config.json` manually e.g:
```
"platforms": [
    {
        "access": "ACCESS_KEY",
        "serial": "SERIAL_KEY",
        "password": "PASSWORD",
        "zones": [
            {
                "index": 1,
                "name": "NAME1"
            },
            {
                "index": 2,
                "name": "NAME2"
            }
        ],
        "platform": "CT200"
    }
]
```
#### Configuration settings
- `access` is the access key (found in bosch EasyControl app)
- `serial` is the serial key (found in bosch EasyControl app)
- `password` is the password used to login.
For each device you want to control, add a zone, where:
- `index` is the zone id (from 1 to X)
- `name` is what will show up in the Home app.

##### Optional settings
- `away` if set to false, removes the `Away` mode switch. (default: true)
- `zoneInterval` how often to query all zones (in minutes, default: 2)
- `auxInterval` how often to refresh humidity, localization, away state and per-zone targets (in minutes, default: 5)

### How it talks to Bosch
The Bosch backend only accepts one request at a time and is regularly unreachable for
short periods, so the plugin:

- serialises every GET/PUT into a single queue;
- answers HomeKit reads from a cached state, refreshed on the intervals above, instead of
  hitting the network each time the Home app is opened;
- retries the initial connection instead of exiting, and rebuilds the XMPP client when the
  stream dies (timeouts, resets, destroyed streams).

A bad config or an unreachable backend therefore leaves the plugin loaded and idle rather
than restarting the (child) bridge in a loop — check the Homebridge log for the reason.

Bosch's XMPP server presents a self-signed certificate, so `bosch-xmpp` disables Node's
certificate validation by setting `NODE_TLS_REJECT_UNAUTHORIZED=0`. That setting is
process-wide, which would affect every other plugin in the same bridge, so this plugin
restores the previous value as soon as the Bosch handshake is done. If you want the
exemption confined to its own process entirely, run the plugin as a **child bridge**
(Homebridge UI, plugin menu, *Bridge Settings*).

#### Troubleshooting
List of problems you might encounter and how to fix them
- **"SyntaxError ... Double-check login details!"** If you encounter this error, then most likely you are using the wrong password. You need to set and use the password that is in 'Settings' -> 'Personal' -> 'Change Password', not the BOSCH ID password. More details [here](https://github.com/lynxcs/homebridge-ct200/issues/22).

#### Getting help
If you need help troubleshooting, create an issue and I'll try to help you fix it.

### Credits
The Homebridge 2 / modern Node connection handling (retry on startup, automatic reconnect,
JID refresh and request serialisation) is based on the work in
[nils5002/homebridge-ct200-revived](https://github.com/nils5002/homebridge-ct200-revived).
