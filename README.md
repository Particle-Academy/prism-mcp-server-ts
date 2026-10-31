# @particle-academy/prism-mcp-server

MCP tool registration and dispatch over a consumer-supplied `ServerTransport`,
with in-memory and authenticated loopback HTTP implementations. Node 22+, ESM.
No stdio, sessions, independent GET push, resources or prompts.

Both protocols are served on the same transport and the same tool registry:

- **Stateless** (`2026-07-28`): `server/discover`, then `tools/list` and
  `tools/call`, each carrying its version and client capabilities in
  `params._meta`.
- **Handshake** (`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`):
  `initialize`, `notifications/initialized`, `ping`, `tools/list` and
  `tools/call`, for clients that always open with `initialize`, such as Codex.
  No session id is issued, so every request stands alone. An unknown requested
  revision is answered with `2025-11-25`.

A request carrying any stateless `_meta` key is held to the stateless rules.
Bearer and Origin checks, request limits, the gate and the result guard apply
to both protocols in the same way.

## Per-request tool visibility

`register(definition, handler, { visible })` takes an optional predicate that
decides, per request, whether the tool exists for this caller:

```ts
server.register(createAgent, handler, {
  visible: async ({ headers }) => (await registry.agentFor(headers['x-genie-agent']))?.isDefault === true,
});
```

The predicate receives the request's headers, without `authorization` or
`cookie`, and may be async. A hidden tool is absent from `tools/list` on both
protocols, and its `tools/call` is refused exactly as an unregistered tool's
(`tool_call_failed`), so a caller cannot tell that it exists. Anything but
`true`, including a throw or a rejection, hides the tool. A registration
without a predicate is visible to every caller.

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
headers: Record<string, string>; progress?: ToolProgress; signal?: AbortSignal })
=> McpToolResult | Promise<McpToolResult>`.
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

`tools/list` and `tools/call` require `params._meta` with
`io.modelcontextprotocol/protocolVersion: '2026-07-28'`,
`io.modelcontextprotocol/clientCapabilities: {}`.
`io.modelcontextprotocol/clientInfo: { name: 'example', version: '1' }` is optional.
Older revisions fail with shared `unsupported_protocol_version`, naming both
revisions. `server/discover`, `tools/list` and `tools/call` are dispatched.
Discovery advertises `supportedVersions: ['2026-07-28']` and `capabilities: { tools: {} }`
regardless of the probe's requested version, including absent, older or unknown
versions. The probe needs no `params`, `_meta`, capabilities or client identity,
creates no session, and does not change server state. It uses the same
HTTP bearer and Origin checks as tool requests. Every successful result includes
`resultType: 'complete'` and `_meta['io.modelcontextprotocol/serverInfo']` identifying
the serving software by package name and version.
Discovery and tool lists include `ttlMs: 0, cacheScope: 'private'`; callers re-fetch
to observe registration changes. Tool call results also carry
`{ content: [{ type: 'text', text }], isError }`; failures throw
shared `McpError` for the transport to map. Handler exception diagnostics are
not exposed; their shared error category is retained.

In-memory `listen()` returns a `memory://` identifier and `token: null`; these
are not HTTP credentials or a dialable URL. Requests have no fixed timeout.
`close()` releases pending request waiters immediately, rejects further work
and is idempotent. JavaScript promises cannot forcibly stop application code;
the embedder remains responsible for its handler-owned background work.
SDK conformance and consumer acceptance remain phase 3.

For HTTP, replace the transport with `new LoopbackHttpTransport()`:

```ts
import { LoopbackHttpTransport, Server } from '@particle-academy/prism-mcp-server';

const transport = new LoopbackHttpTransport();
const server = new Server({ server: 'example', transport });
// Register application tools, then start the listener.
const { url, token } = await server.listen();
// Give both values privately to the client. Each POST needs:
// Authorization: Bearer <token>, Content-Type: application/json
// Send a JSON-RPC 2.0 request with id, method and the per-request params._meta above.
// await server.close() when the embedder shuts down.
```

The HTTP URL is `http://127.0.0.1:<port>/mcp`. `port` defaults to `0` (an OS-chosen
port); the bind address is fixed to literal `127.0.0.1`. `token` is generated at
startup from 32 cryptographically random bytes, or may be supplied in the options.
Configured tokens must be non-empty bearer-token strings; whitespace is refused
before listening. HTTP always returns a real token; only memory returns `null`.
The URL alone does not authorize a client. Keep the token out of URLs and logs.
Every request requires `Authorization: Bearer <token>`; comparison uses fixed-size
SHA-256 digests and `timingSafeEqual`.

Requests without `Origin` may proceed with valid credentials. A browser `Origin`
must exactly match the listener's own origin by default. `allowedOrigins` replaces
that allow-list with explicit `http://127.0.0.1:<port>` / `https://[::1]:<port>`
origins (either scheme is supported); arbitrary hostnames, paths, wildcard origins
and non-loopback addresses are refused at startup. No browser CORS/preflight
support is provided. GET, upgrades and CONNECT are refused. JSON-only clients
keep JSON responses. A `tools/call` offering `text/event-stream` receives SSE;
an `Accept: */*` keeps the existing JSON choice. Other methods require JSON in
their accepted media types. A media range with `q=0` does not opt into SSE.

POSTs require `Content-Length` and JSON content; chunked uploads, batches,
and ambiguous duplicate headers are refused. Notifications receive 202 with no
body; authenticated `notifications/cancelled` can cancel a pending tool request.
`maxRequestBytes`
defaults to 1 MiB. Responses carry the same request id and either `result` or a
JSON-RPC `error` with the shared Prism category in `error.data.code`; arbitrary
diagnostic messages are withheld. HTTP refusal uses 401 for credentials and 403
for Origin. No request, header or socket deadline is imposed. `close()` releases
every socket, including incomplete HTTP headers and held long-polls, before
resolving; handler-owned application work still needs embedder cleanup.

## Long-running HTTP tools

SSE starts immediately after authentication and request validation with an
`: open` comment. A comment heartbeat follows every ten seconds; configure
`heartbeatIntervalMs` to change the positive interval. The final
`event: message` carries the same JSON-RPC result or error, then the stream ends.
No event IDs, sessions or reconnection replay are offered. Heartbeats carry no
application data. This follows MCP's [Streamable HTTP response contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

When the request supplies a string or integer `params._meta.progressToken`,
the stream sends an initial `notifications/progress` and repeats the latest
accepted handler message every thirty seconds while the call is running. Before
the handler reports anything, its message is `working`. Configure the positive
`progressKeepaliveMs` interval when needed; keep it below the client's idle limit.
These progress notifications keep clients active when comment heartbeats alone
do not reset their idle timer. Handlers can report more:

```ts
server.register(waitTool, async (args, { progress, signal }) => {
  progress?.('Waiting for approval', 1, 2);
  const answer = await applicationWait({ signal }); // Host code must cooperate.
  progress?.('Approval received', 2, 2);
  return { text: answer, isError: false };
});
```

**0.5.0 migration — BREAKING for consumers of raw progress numbers:** the wire
`progress` is now an activity-notification counter, starting at zero and strictly
increasing for every emitted handler update or keepalive. A keepalive cannot
repeat the numeric value: [MCP requires each notification to increase](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress).
Read original work numbers from
`params._meta['particle-academy/progress'].nativeWork` instead:

```json
{
  "unit": "activity-notifications",
  "origin": "handler",
  "nativeWork": { "unit": "native-work", "message": "Waiting for approval", "progress": 1, "total": 2 }
}
```

The metadata's native numbers are unchanged. With native `p > 0` and total `t`,
the wire total is `counter / (p / t)`, preserving the displayed `p/t` ratio within
floating-point precision. At or beyond the native total, the displayed ratio
clamps to one. With `p = 0`, a positive strictly increasing wire value cannot
have an exactly zero ratio against a finite total. The wire total is therefore
`Number.MAX_VALUE`, the largest finite total, giving the smallest positive ratio
for that counter: `counter / Number.MAX_VALUE`, always below `0.001` throughout
the safe-integer counter range. If an extreme positive native ratio would require
an infinite wire total or underflows, omit the wire total and preserve the exact
native metadata. Message-only updates also omit the total. The total is a
derived ratio display value, not the original native work-unit count.

Native numbers must be finite and nonnegative. Each numeric handler report must
strictly exceed the previous accepted numeric handler report, independently of
message-only updates and keepalives. Non-increasing or invalid reports are
rejected entirely; they do not replace the last message or metadata. A total
requires a numeric progress value. The handler's `progress()` returns `void`
and never throws, including for rejected reports. At most one generic
`PRISM_MCP_PROGRESS_REJECTED` warning per stream reports rejection or a ratio
that cannot be displayed; it contains no token, message or numeric payload.

Messages are limited to4096 UTF-8 bytes and JSON-escaped on their own request's
stream. Supply user-safe host text without credentials, raw arguments or private
diagnostics: keepalives repeat that text. Under backpressure, skip updates
without advancing the counter or buffering a queue. Exhausting the safe-integer
counter stops notifications while the handler continues. Missing or invalid
tokens retain comment heartbeats, and JSON-only requests receive no progress
notifications. Both timers stop on result, error, cancellation, disconnect or
shutdown. No progress is emitted after the call ends.

HTTP tool contexts receive an `AbortSignal`. An authenticated
`notifications/cancelled` with `params.requestId` signals the matching active
call and ends its response without a final result. Malformed, unknown or completed
IDs are ignored. This stateless listener shares one bearer principal and has no
client sessions: if simultaneous clients reuse an active ID, cancellation by that
ID is ignored rather than choosing another caller. Use unambiguous active IDs.
Cancellation reasons are not forwarded or logged. A tool still waiting on its
gate does not start after cancellation.

By default a disconnected connection stops heartbeats and drops late output
without aborting its handler, as [MCP cancellation semantics](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)
require. To abandon work whose listener has gone away, use
`new LoopbackHttpTransport({ abortOnDisconnect: true })`; then a dropped JSON or
SSE response also fires its own handler signal. This opts into cancellation on
connection loss, so a transient disconnect can cancel application work. Signals
are cooperative: handlers must observe them to stop pending approvals, subprocess
waits or other work. No JavaScript promise can forcibly interrupt arbitrary code.

No breaking changes to JSON-only classic responses are intended; their exact
response bytes and security headers are compared against the previous source.
The tests also cover classic requests that accept SSE, fake timers for 35-minute calls and
disconnect/explicit-cancellation cleanup. Consumer acceptance in an actual
Claude Code client remains a separate measurement.

Local gates: `npm run typecheck`, `npm run build`, `npm test`. Test sources are
typechecked too. CI runs the gates on Node 22, 24 and 26.
The complete suite includes a real 310-second HTTP long-poll and takes about
six minutes. SDK reference-client conformance is not part of this phase.
