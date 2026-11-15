# Changelog

## 0.7.0

- `ServerOptions.instructions`: the server's natural-language guidance for a client's model. Sent in the
  `initialize` result (handshake revisions) and the `server/discover` result (2026-07-28). Embedder configuration
  only, fixed at construction; a non-empty string of at most 16 KiB.
- `SUPPORTED_PROTOCOL_VERSIONS` lists every MCP protocol version served, newest first: 2026-07-28 (stateless),
  2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05 (handshake). `protocol-versions.json` publishes the same list.
- No breaking changes.

## 0.6.0

- **Breaking:** re-exported `TrustPolicy.allowing([])` now raises
  `server_not_trusted`; a `ResultGuard` you construct without `maxBytes` now
  defaults to 262,144 bytes. The server's own default guard keeps 65,536.
- When constructing a custom guard, pass `maxBytes: 65_536` to retain
  its previous limit. An explicitly supplied server guard remains caller-controlled.
- Update the exact client dependency from 0.3.0 to 0.4.0. The server uses
  `ResultGuard` directly; it does not call `Client.callTool`. Handler result
  flags must still be booleans. Trust policy is not applied to inbound calls.
