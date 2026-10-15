import {
  KNOWN_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  McpError,
  MirroredParameters,
  ResultGuard,
  ToolDefinition,
  allowAll,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type McpErrorCode,
  type McpToolResult,
  type ToolGate,
  type TransportRequest,
} from '@particle-academy/prism-mcp';

// TrustPolicy is a CLIENT defence against a hostile server's definitions.
// It does not apply inbound: the embedder owns registration; ToolGate admits calls.
export { TrustPolicy } from '@particle-academy/prism-mcp';
export { McpError, MirroredParameters, ResultGuard, ToolDefinition, allowAll };
export type { JsonObject, JsonValue, McpErrorCode, McpToolResult, ToolGate, TransportRequest };
export { LoopbackHttpTransport, type LoopbackHttpOptions } from './http.js';

export type ToolHandler = (
  args: JsonObject,
  context: { server: string; tool: string; headers: Record<string, string> },
) => McpToolResult | Promise<McpToolResult>;

export interface ServerTransport {
  listen(handler: (request: TransportRequest) => Promise<JsonValue>): Promise<{ url: string; token: string | null }>;
  close(): Promise<void>;
}

export interface ServerOptions {
  server: string;
  transport: ServerTransport;
  gate?: ToolGate;
  guard?: ResultGuard;
}

const VERSION = 'io.modelcontextprotocol/protocolVersion';
const CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
const SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
const PREFIX = 'mcp-param-';
const SERVER_NAME = '@particle-academy/prism-mcp-server';
const SERVER_VERSION = '0.2.0';

// The handshake revisions, served for clients that open with `initialize`
// (Codex's MCP client always does: prism-mcp-server-ts#1). Newest first; an
// unknown requested revision is answered with the first, as the spec says.
const CLASSIC_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
const STATELESS_KEYS = [VERSION, CAPABILITIES, CLIENT_INFO];

interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
  mirrored: MirroredParameters;
}

/** Stateless tool serving. Network/security framing belongs to ServerTransport. */
export class Server {
  readonly #tools = new Map<string, RegisteredTool>();
  readonly #refused = new Set<string>();
  readonly #gate: ToolGate;
  readonly #guard: ResultGuard;
  #closed = false;

  constructor(readonly options: ServerOptions) {
    this.#gate = options.gate ?? allowAll;
    // The client frames provenance. Server defaults preserve text identity and cap bytes.
    this.#guard = options.guard ?? new ResultGuard({ frameProvenance: false });
  }

  register(definition: ToolDefinition, handler: ToolHandler): void {
    this.#assertOpen();
    if (this.#tools.has(definition.name) || this.#refused.has(definition.name)) {
      throw new McpError('protocol_failure', 'A tool with this name is already registered or refused.');
    }
    // Snapshot caller-owned schema/annotations so later mutation cannot silently
    // change the pin material or bypass the mirrored-parameter validation.
    const snapshot = ToolDefinition.fromPayload(payloadOf(definition));
    let mirrored: MirroredParameters;
    try {
      mirrored = MirroredParameters.fromSchema(snapshot.name, snapshot.inputSchema);
    } catch (error) {
      if (error instanceof McpError && error.code === 'mirrored_parameter_refused') {
        this.#refused.add(snapshot.name);
      }
      throw error;
    }
    this.#tools.set(snapshot.name, { definition: snapshot, handler, mirrored });
  }

  listen(): Promise<{ url: string; token: string | null }> {
    this.#assertOpen();
    return this.options.transport.listen((request) => this.handle(request));
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.options.transport.close();
  }

  async handle(request: TransportRequest): Promise<JsonValue> {
    this.#assertOpen();
    // Discovery precedes version selection: it cannot require the metadata of
    // an agreed revision. HTTP bearer/Origin checks still run in the transport.
    if (request.method === 'server/discover') {
      return complete({ supportedVersions: [LATEST_PROTOCOL_VERSION], capabilities: { tools: {} },
        ttlMs: 0, cacheScope: 'private' });
    }
    const params = request.params ?? {};
    // A request carrying ANY stateless metadata key is a stateless request and
    // is held to the stateless rules; only one with none of them is classic. A
    // half-formed stateless request must not fall through to the classic path.
    const classic = !(isJsonObject(params._meta) && STATELESS_KEYS.some((key) => Object.hasOwn(params._meta as JsonObject, key)));
    if (classic) return this.#classic(request, params);
    assertProtocol(params);
    if (request.method === 'tools/list') {
      return complete({ tools: this.#listed(), ttlMs: 0, cacheScope: 'private' });
    }
    if (request.method !== 'tools/call') {
      throw new McpError('protocol_failure', 'Only server/discover, tools/list and tools/call are supported on the stateless revision.');
    }
    return complete(await this.#call(request, params));
  }

  /**
   * The handshake protocol, for clients that open with `initialize`. Stateless
   * per request, which the streamable-HTTP transport permits: no session id is
   * issued, so nothing is bound to one. Authentication is the transport's, and
   * the registry, gate, mirrors and result guard are the stateless path's own.
   */
  async #classic(request: TransportRequest, params: JsonObject): Promise<JsonValue> {
    if (request.method.startsWith('notifications/')) return null;
    if (request.method === 'initialize') return initialize(params);
    const header = request.headers?.['mcp-protocol-version'];
    if (header !== undefined && !CLASSIC_VERSIONS.some((version) => version === header)) {
      throw new McpError('unsupported_protocol_version',
        `Protocol version [${header}] is not served on the handshake path; expected one of [${CLASSIC_VERSIONS.join(', ')}].`);
    }
    if (request.method === 'ping') return {};
    // The spec types title as an optional string, so a null is omitted rather
    // than sent to a client that may deserialize strictly. The stateless payload
    // is untouched: tool digests are computed over it.
    if (request.method === 'tools/list') {
      return { tools: this.#listed().map((tool) => Object.fromEntries(Object.entries(tool).filter(([, value]) => value !== null))) };
    }
    if (request.method === 'tools/call') return this.#call(request, params);
    throw new McpError('protocol_failure', 'Only initialize, ping, tools/list and tools/call are supported.');
  }

  #listed(): JsonObject[] {
    return [...this.#tools.values()].map(({ definition }) => payloadOf(definition));
  }

  async #call(request: TransportRequest, params: JsonObject): Promise<JsonObject> {
    if (typeof params.name !== 'string' || params.name === '') {
      throw new McpError('protocol_failure', 'tools/call requires a tool name.');
    }
    if (this.#refused.has(params.name)) {
      throw new McpError('mirrored_parameter_refused', 'The tool has invalid mirrored-parameter annotations.');
    }
    const tool = this.#tools.get(params.name);
    if (!tool) throw new McpError('tool_call_failed', 'The requested tool is not registered.');
    if (params.arguments !== undefined && !isJsonObject(params.arguments)) {
      throw new McpError('protocol_failure', 'Tool arguments must be an object.');
    }
    const args = cloneObject(params.arguments ?? {});
    const headers = mirroredHeaders(request.headers ?? {});
    resolveMirrors(tool.mirrored, headers, args);
    if (!(await this.#gate(this.options.server, tool.definition.name, args))) {
      throw new McpError('tool_denied', 'The gate refused this tool call.');
    }
    this.#assertOpen();
    let result: McpToolResult;
    try {
      result = await tool.handler(args, { server: this.options.server, tool: tool.definition.name, headers });
    } catch (error) {
      // Exception messages may carry credentials or prompts: only the shared
      // category survives, never arbitrary handler diagnostic text.
      const code: McpErrorCode = error instanceof McpError ? error.code : 'tool_call_failed';
      throw new McpError(code, 'The tool handler could not complete the request.');
    }
    if (!isJsonObject(result) || typeof result.text !== 'string' || typeof result.isError !== 'boolean') {
      throw new McpError('protocol_failure', 'The handler must return McpToolResult.');
    }
    const text = this.#guard.guard(this.options.server, tool.definition.name, result.text);
    return { content: [{ type: 'text', text }], isError: result.isError };
  }

  #assertOpen(): void {
    if (this.#closed) throw new McpError('protocol_failure', 'The server is closed.');
  }
}

function assertProtocol(params: JsonObject): void {
  if (!isJsonObject(params) || !isJsonObject(params._meta)) {
    throw new McpError('protocol_failure', 'Stateless requests require per-request _meta.');
  }
  const version = params._meta[VERSION];
  if (version !== LATEST_PROTOCOL_VERSION) {
    const known = KNOWN_PROTOCOL_VERSIONS.some((entry) => entry === version);
    throw new McpError('unsupported_protocol_version',
      `Protocol ${known ? 'revision' : 'version'} [${typeof version === 'string' ? version : 'missing'}] is unsupported; expected [${LATEST_PROTOCOL_VERSION}].`);
  }
  if (!isJsonObject(params._meta[CAPABILITIES])) {
    throw new McpError('protocol_failure', 'Requests require client capabilities in _meta.');
  }
  if (Object.hasOwn(params._meta, CLIENT_INFO) && !isJsonObject(params._meta[CLIENT_INFO])) {
    throw new McpError('protocol_failure', 'Client info must be an object when supplied.');
  }
}

function initialize(params: JsonObject): JsonObject {
  if (typeof params.protocolVersion !== 'string'
    || (params.capabilities !== undefined && !isJsonObject(params.capabilities))
    || (params.clientInfo !== undefined && !isJsonObject(params.clientInfo))) {
    throw new McpError('protocol_failure', 'initialize requires a protocolVersion, and object capabilities and clientInfo.');
  }
  const requested = params.protocolVersion;
  const protocolVersion = CLASSIC_VERSIONS.find((version) => version === requested) ?? CLASSIC_VERSIONS[0];
  return { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } };
}

function complete(result: JsonObject): JsonObject {
  // Identify the serving software, independently of the embedder's gate/context
  // label. Fresh objects prevent callers from mutating subsequent responses.
  return { ...result, resultType: 'complete', _meta: {
    [SERVER_INFO]: { name: SERVER_NAME, version: SERVER_VERSION },
  } };
}

function cloneObject(value: JsonObject): JsonObject {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonObject;
  } catch {
    throw new McpError('protocol_failure', 'Expected JSON-serializable data.');
  }
}

function payloadOf(tool: ToolDefinition): JsonObject {
  return cloneObject({ name: tool.name, description: tool.description,
    inputSchema: tool.inputSchema, title: tool.title, annotations: tool.annotations });
}

function mirroredHeaders(raw: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(raw)) {
    if (!name.toLowerCase().startsWith(PREFIX)) continue;
    const key = name.slice(PREFIX.length).toLowerCase();
    if (typeof value !== 'string' || Object.hasOwn(headers, key)) {
      throw new McpError('protocol_failure', 'Mirrored headers must have unambiguous string values.');
    }
    headers[key] = value;
  }
  // Never pass Authorization, Cookie, Origin or any other unnamespaced header.
  return headers;
}

function resolveMirrors(mirrored: MirroredParameters, headers: Record<string, string>, args: JsonObject): void {
  for (const [name, { path, type }] of Object.entries(mirrored.parameters)) {
    const raw = headers[name.toLowerCase()];
    if (raw === undefined) continue;
    let value: JsonValue = raw;
    if (type === 'boolean') {
      if (raw !== 'true' && raw !== 'false') throw new McpError('protocol_failure', 'Invalid mirrored boolean.');
      value = raw === 'true';
    } else if (type === 'integer') {
      if (!/^-?(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        throw new McpError('protocol_failure', 'Invalid mirrored integer.');
      }
      value = Number(raw);
    }
    let target = args;
    for (const segment of path.slice(0, -1)) {
      if (!Object.hasOwn(target, segment)) defineOwn(target, segment, {});
      const nested = target[segment];
      if (!isJsonObject(nested)) throw new McpError('protocol_failure', 'Mirrored path conflicts with tool arguments.');
      target = nested;
    }
    const leaf = path[path.length - 1];
    if (Object.hasOwn(target, leaf) && target[leaf] !== value) {
      throw new McpError('protocol_failure', 'Mirrored header conflicts with tool arguments.');
    }
    // Schema property names such as __proto__ are data, never prototype setters.
    defineOwn(target, leaf, value);
  }
}

function defineOwn(target: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** In-process test/embedder transport. No socket, HTTP authentication or timers. */
export class InMemoryTransport implements ServerTransport {
  #handler?: (request: TransportRequest) => Promise<JsonValue>;
  #closed = false;
  readonly #pending = new Set<(error: McpError) => void>();

  async listen(handler: (request: TransportRequest) => Promise<JsonValue>): Promise<{ url: string; token: string | null }> {
    if (this.#closed || this.#handler) throw new McpError('protocol_failure', 'Transport is closed or already listening.');
    this.#handler = handler;
    return { url: 'memory://prism-mcp-server', token: null };
  }

  readonly request = (request: TransportRequest): Promise<JsonValue> => {
    const handler = this.#handler;
    if (this.#closed || !handler) return Promise.reject(new McpError('protocol_failure', 'Transport is not listening.'));
    return new Promise<JsonValue>((resolve, reject) => {
      this.#pending.add(reject);
      // Attach both outcomes so a handler rejecting after close is not unhandled.
      Promise.resolve().then(() => {
        if (this.#closed) throw new McpError('protocol_failure', 'Transport is closed.');
        return handler(request);
      }).then(resolve, reject).finally(() => this.#pending.delete(reject));
    });
  };

  async close(): Promise<void> {
    this.#closed = true;
    this.#handler = undefined;
    for (const reject of this.#pending) reject(new McpError('protocol_failure', 'Transport closed during request.'));
    this.#pending.clear();
  }
}
