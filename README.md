# Homebridge CT200

## Homebridge plugin for Bosch EasyControl CT200

[![Build and Lint](https://github.com/c-yril/homebridge-ct200/actions/workflows/build.yml/badge.svg)](https://github.com/c-yril/homebridge-ct200/actions/workflows/build.yml)
[![npm](https://img.shields.io/npm/v/@c-yril/homebridge-ct200)](https://www.npmjs.com/package/@c-yril/homebridge-ct200)

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
$ sudo npm -g i @c-yril/homebridge-ct200
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
- `access` is the access key, printed on the back of the device and shown in the bosch
  EasyControl app (16 letters)
- `serial` is the serial key, printed on the back of the device and shown in the bosch
  EasyControl app (9 digits)
- `password` is the device password. Set it in the EasyControl app under
  *Menu -> Settings -> Personal -> Change password*; it is **not** your Bosch SingleKey ID
  password.

Both keys are printed in dash-separated groups; the dashes are ignored, so either form
works.
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
- **A zone shows 0 °C, or stays unresponsive in the Home app.** Its `index` almost
  certainly doesn't match a zone on the CT200, or nothing is bound to that zone. On start
  the plugin logs the zones the device actually exposes (`Zones reported by the CT200: 1 =
  "Salon" (21.5), ...`); use one of those ids as `index`. You can also ask the device
  directly, see [Querying the device](#querying-the-device) below.
  With smart radiator valves each valve is a zone; the CT200 itself is the gateway and is
  not a zone of its own. A `temp` of `1000` means the CT200 has no reading for that zone.
- **"SyntaxError ... Double-check login details!"** If you encounter this error, then most likely you are using the wrong password. You need to set and use the password that is in 'Settings' -> 'Personal' -> 'Change Password', not the BOSCH ID password. More details [here](https://github.com/lynxcs/homebridge-ct200/issues/22).

#### Querying the device
`bosch-xmpp`, which the plugin uses to talk to Bosch, ships a CLI. Copy `.env.example` to
`.env` (gitignored) and fill in the three credentials, then:

```
$ npm run zones             # /zones/list: the ids, names and temperatures
$ npm run bosch -- get /gateway/versionFirmware
$ npm run bosch -- put /zones/zn1/manualTemperatureHeating '{"value":20.5}'
```

`npm run bosch` reads the local env file through dotenvx, stripping the dashes the serial
number and access key are printed with. A value containing `#`, a quote or a leading space
has to be quoted there, otherwise dotenv truncates it: `BOSCH_XMPP_PASSWORD="a#b"`.
A reply that fails to parse as JSON means the password is wrong - see the troubleshooting
note above. To pass the credentials directly instead:

```
$ BOSCH_XMPP_SERIAL_NUMBER=... BOSCH_XMPP_ACCESS_KEY=... BOSCH_XMPP_PASSWORD=... \
    npx bosch-xmpp easycontrol get /zones/list
```

Only one client can talk to the device at a time, so stop Homebridge (or the plugin's child
bridge) first if a request hangs.

#### Getting help
If you need help troubleshooting, create an issue and I'll try to help you fix it.

### Releasing (maintainers)
Merging to `master` runs `.github/workflows/release.yml`. It compares the `version` in
`package.json` with what is already on npm: if that exact version is unpublished it lints,
builds, runs `npm publish --provenance` and opens a GitHub release tagged `v<version>`.
Any other merge is a no-op, so releasing is just bumping the version in the merged commit
(`npm version patch|minor|major`) and updating `CHANGELOG.md`.

Authentication is [npm trusted publishing](https://docs.npmjs.com/trusted-publishers):
the workflow proves who it is with a short-lived OIDC token minted by GitHub from its
`id-token: write` permission. Once it is set up there is **no npm token to create, store
or rotate** — `GITHUB_TOKEN`, used to open the release, is provided by Actions
automatically.

Trusted publishing cannot create a package that does not exist yet, because it is
configured on the package's own settings page. So the very first publish needs a token,
and only that one:

1. **Bootstrap the package.** Either publish by hand from a clean checkout (`npm login`,
   then `npm publish` — `publishConfig.access` is already `public`), or add a granular
   access token as a repository secret named `NPM_TOKEN` and let the workflow do it. The
   token needs *Read and write* on the `@c-yril` scope, and **Bypass two-factor
   authentication** enabled if the account has 2FA — an unattended publish cannot answer
   an OTP prompt. The workflow uses the secret when it is present and OIDC when it is not.
2. Go to `https://www.npmjs.com/package/@c-yril/homebridge-ct200/access` — the setting is
   there, not on the account-wide packages page.
3. Under **Trusted Publisher**, choose GitHub Actions and fill in:
   - Organization or user: `c-yril`
   - Repository: `homebridge-ct200`
   - Workflow filename: `release.yml`
   - Environment: leave empty
   Every field is case-sensitive and must match exactly, `.yml` extension included; a
   mismatch surfaces at publish time as `Unable to authenticate`.
4. Optional, recommended once step 3 works: on the same page set the package to
   **Require two-factor authentication and disallow tokens**, which closes off token-based
   publishing entirely.
5. **Delete the `NPM_TOKEN` secret** once step 3 is in place. The workflow falls back to
   OIDC on its own, and leaving the token behind keeps a standing 2FA-bypassing credential
   in the repository for no reason — which is exactly what npm's own UI warns about when
   it points you at trusted publishing.

Every release after that is tokenless.

### Credits
The Homebridge 2 / modern Node connection handling (retry on startup, automatic reconnect,
JID refresh and request serialisation) is based on the work in
[nils5002/homebridge-ct200-revived](https://github.com/nils5002/homebridge-ct200-revived).
