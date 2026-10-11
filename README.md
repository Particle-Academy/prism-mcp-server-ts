# @particle-academy/prism-mcp-server

Phase 1: stateless MCP tool registration and dispatch over a consumer-supplied
`ServerTransport`, with an in-memory implementation. Node 22+, ESM. No HTTP
listener, sockets, stdio, handshake, sessions, push, resources or prompts.

The sole runtime dependency is `@particle-academy/prism-mcp`; there are **zero
third-party runtime dependencies**. Shared definitions, errors, gates and guards
come from that package. The official MCP SDK is dev-only, reserved for phase 3
reference-client tests; production code does not import it.

```ts
import { Server, InMemoryTransport, ToolDefinition } from '@particle-academy/prism-mcp-server';

const transport = new InMemoryTransport();
const server = new Server({ server: 'example', transport });
server.register(new ToolDefinition('echo', 'Echo text', {
  type: 'object', properties: { text: { type: 'string' } },
}), (args, context) => ({ text: String(args.text ?? ''), isError: false }));
await server.listen();
// An embedder calls transport.request with the same TransportRequest shape
// as the client half, including params._meta for each stateless request.
await server.close();
```

`register(definition, handler)` accepts the shared `ToolDefinition`. The exact
handler contract is `(args: JsonObject, context: { server: string; tool: string;
headers: Record<string, string> }) => McpToolResult | Promise<McpToolResult>`.
Definitions are snapshotted; duplicate names fail. Invalid mirrored annotations
throw `mirrored_parameter_refused`, are absent from `tools/list`, and cannot run.
Listed definitions preserve the client's digest, including nested schemas/title.

`ToolGate` defaults to **allowAll on the server**, unlike the client's
deny-by-default trust posture. Registering a tool is the embedder's explicit
choice to serve it; a custom gate can refuse individual calls before execution.
`TrustPolicy` applies only to clients trusting server definitions, not inbound
calls. Default outbound `ResultGuard` caps UTF-8 text at 64 KiB, including
`isError` results, without provenance framing; clients apply that framing once.
Custom guards may intentionally transform results.

Only `Mcp-Param-*` request headers reach handlers: the prefix is required and
stripped case-insensitively, and context header keys are lowercase. Raw
`Authorization`, `Cookie`, `Origin` and other non-parameter headers stay private.
Shared `MirroredParameters` annotations resolve these headers into arguments
before gating; nested string/integer/boolean fields are supported. Ambiguous
headers, invalid primitive encodings and conflicting body/header values fail
closed. Handlers validate the rest of their own application arguments.

Every request requires `params._meta` with
`io.modelcontextprotocol/protocolVersion: '2026-07-28'`,
`io.modelcontextprotocol/clientCapabilities: {}` and
`io.modelcontextprotocol/clientInfo: { name: 'example', version: '1' }`.
Older revisions fail with shared `unsupported_protocol_version`, naming both
revisions. Only `tools/list` and `tools/call` are dispatched. Successful wire
results use `{ content: [{ type: 'text', text }], isError }`; failures throw
shared `McpError` for the transport to map. Handler exception diagnostics are
not exposed; their shared error category is retained.

In-memory `listen()` returns a `memory://` identifier and empty token; these
are not HTTP credentials or a dialable URL. Requests have no fixed timeout.
`close()` releases pending request waiters immediately, rejects further work
and is idempotent. JavaScript promises cannot forcibly stop application code;
the embedder remains responsible for its handler-owned background work.
Phase 2 will implement loopback binding, Origin checks and bearer authorization;
phase 3 will add SDK conformance and consumer acceptance tests.

Local gates: `npm run typecheck`, `npm run build`, `npm test`. Test sources are
typechecked too. No remote, publishing workflow or tag is configured here.
