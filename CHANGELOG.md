# Changelog

## Unreleased

- **Breaking:** re-exported `TrustPolicy.allowing([])` now raises
  `server_not_trusted`; a `ResultGuard` you construct without `maxBytes` now
  defaults to 262,144 bytes. The server's own default guard keeps 65,536.
- When constructing a custom guard, pass `maxBytes: 65_536` to retain
  its previous limit. An explicitly supplied server guard remains caller-controlled.
- Update the exact client dependency from 0.3.0 to 0.4.0. The server uses
  `ResultGuard` directly; it does not call `Client.callTool`. Handler result
  flags must still be booleans. Trust policy is not applied to inbound calls.
