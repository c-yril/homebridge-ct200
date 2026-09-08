# Changelog

## [3.0.0]

Homebridge 2 support. This release requires **Node.js 22.10+** and drops support for
older Node versions.

### Added

- Homebridge 2 support (tested against Homebridge 2.4.0 / HAP 2.2.2); the plugin still
  runs on Homebridge 1.8+.
- Graceful shutdown: refresh timers are cleared and the XMPP client is closed when
  Homebridge stops.
- `minStep` of 0.5 °C on the target temperature, matching what the Bosch API accepts.
- Type declarations for `bosch-xmpp`, so the client is no longer untyped `any`.
- Published to npm as `@c-yril/homebridge-ct200`, so the plugin is installable from the
  Homebridge UI plugin browser.
- Release workflow: a merge to `master` publishes to npm (with provenance) and opens a
  GitHub release whenever `package.json` carries a version npm hasn't seen yet.
- Dependabot config for npm dependencies and GitHub Actions.

### Changed

- `bosch-xmpp` upgraded to 2.x, which replaces the abandoned `node-xmpp-client` with
  `@xmpp/client`. This is what makes the plugin work on current Node versions.
- HomeKit reads are answered from cached state instead of issuing a request each time,
  and the auxiliary refresh now also covers away state and per-zone target/mode.
- Bosch requests are serialised into a single queue; the backend only accepts one
  in-flight request at a time.
- Accessories are registered from the config before connecting, so HomeKit stays
  populated while the backend is unreachable.
- Writes are dispatched without blocking the HomeKit handler, which would otherwise
  time out whenever the shared request queue is busy.
- Toolchain updated: TypeScript 5.9, ESLint 10 flat config, ES2022 target, CI on
  Node 22/24.

### Fixed

- The plugin no longer calls `process.exit()` on a bad config or a failed connection.
  Under Homebridge 2 that turned into a (child) bridge restart loop; it now logs the
  problem and stays idle, retrying the connection every 30s.
- A permanent `error` listener is attached to the XMPP client. Without one, any socket
  error after the initial connect was an unhandled `error` event that killed the process.
- Auto-reconnect is re-enabled after the first connect (`bosch-xmpp` stops it and never
  restarts it), and the client is rebuilt when the stream becomes unusable.
- The full JID is refreshed on every `online` event. Its resource part changes on
  reconnect, and a stale value made every subsequent request time out.
- Setting away mode no longer throws when the request returned no response.
- No more `characteristic value 0 is not contained in valid values array` warning at
  startup for the target heating/cooling state.
- Auto-reconnect is no longer delegated to `@xmpp/reconnect`, whose fixed 1s delay
  turned any outage into one connection attempt per second. Recovery goes through the
  same cooldown and retry delay as the initial connection.
- `bosch-xmpp`'s keepalive timer is stopped when a client is discarded; it reschedules
  itself indefinitely and `end()` does not clear it, so every reconnect leaked a timer.

### Security

- `NODE_TLS_REJECT_UNAUTHORIZED` is restored after the Bosch handshake. `bosch-xmpp`
  sets it to `0` in its constructor to accept Bosch's self-signed certificate, and
  that variable is process-global, so it was silently disabling certificate
  validation for every other plugin sharing the Homebridge process.
- The Bosch serial number is no longer published as the HomeKit `SerialNumber`
  characteristic. It is one of the three login credentials, and that value is
  persisted to `cachedAccessories` and readable by every paired controller.
- The access key and password are marked as password fields in the config UI, and
  the issue templates now name the three values to redact instead of a generic
  "remove sensitive information".
- The build workflow declares `permissions: contents: read` and pins its actions to
  commit SHAs.

Reviewed with a security pass over the 3.0.0 changes; the `qs`/`express` advisories
reported by `npm audit` come from `bosch-xmpp`'s CLI bridge, which this plugin never
loads.

### Credits

The connection handling fixes are based on
[nils5002/homebridge-ct200-revived](https://github.com/nils5002/homebridge-ct200-revived).
