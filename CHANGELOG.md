# Changelog

## Unreleased

- **Breaking:** headers that mirror the request body are now checked against it, per the 2026-07-28 Streamable
  HTTP transport. An `Mcp-Param-*` header no longer supplies an argument the body left out: the body is the only
  source of arguments, and such a header is refused. Each `Mcp-Param-*` header is decoded from the `=?base64?...?=`
  form and must equal its body value; integers compare by value. Undeclared, repeated, malformed and disagreeing
  headers are refused, and on 2026-07-28 over HTTP every mirrored body value needs its header. `Mcp-Method`,
  `Mcp-Name` and `MCP-Protocol-Version` must match the body when present.
- A mismatch is answered with HTTP 400 and JSON-RPC error `-32020` (`HeaderMismatch`), before the gate and the
  tool, and before a streamed call opens its stream. New exports: `HeaderMismatchError` and `HEADER_MISMATCH`.
- `ServerTransport.requiresMirroredHeaders` (default true) and an optional second `listen()` argument that runs
  the header checks alone. `InMemoryTransport` sets `requiresMirroredHeaders: false`.
- A tool handler's `context.headers` now carries decoded values.
- To migrate: send each mirrored value in `arguments` as well as in its header. The prism-mcp clients already do.

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
