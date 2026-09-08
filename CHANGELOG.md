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

### Credits

The connection handling fixes are based on
[nils5002/homebridge-ct200-revived](https://github.com/nils5002/homebridge-ct200-revived).
