import crypto from 'node:crypto';
import http, { type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { McpError, isJsonObject, type JsonValue } from '@particle-academy/prism-mcp';
import type { ServerTransport, ServerTransportRequest, ToolProgress } from './index.js';

export interface LoopbackHttpOptions {
  port?: number;
  /** Omit to generate 256 random bits at listen(). Never log the returned token. */
  token?: string;
  /** Exact numeric loopback origins. Defaults to this listener's own origin. */
  allowedOrigins?: readonly string[];
  maxRequestBytes?: number;
  /** SSE comment cadence for opted-in tools/call requests. Defaults to ten seconds. */
  heartbeatIntervalMs?: number;
  /** Token-bearing SSE tool calls repeat progress at this cadence. Defaults to thirty seconds. */
  progressKeepaliveMs?: number;
  /** Opt in to cancelling work when its response connection drops. Default false. */
  abortOnDisconnect?: boolean;
}

const TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|\[::1\])(?::([1-9][0-9]{0,4}))?$/;

function validOrigin(origin: string): boolean {
  const match = LOOPBACK_ORIGIN.exec(origin);
  return !!match && match[0] === origin && (!match[2] || Number(match[2]) <= 65535);
}

function digest(token: string): Buffer {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

/** POST-only JSON-RPC on a literal IPv4 loopback address. No session is issued on either protocol. */
export class LoopbackHttpTransport implements ServerTransport {
  readonly #port: number;
  readonly #configuredToken?: string;
  readonly #configuredOrigins?: readonly string[];
  readonly #maxRequestBytes: number;
  readonly #heartbeatIntervalMs: number;
  readonly #progressKeepaliveMs: number;
  readonly #abortOnDisconnect: boolean;
  readonly #calls = new Map<string | number, Set<{ controller: AbortController; detach: () => void }>>();
  readonly #streams = new Set<{ response: ServerResponse; stop: () => void }>();
  readonly #sockets = new Set<Socket>();
  #server?: HttpServer;
  #starting?: Promise<void>;
  #closed = false;
  #closing?: Promise<void>;

  constructor(options: LoopbackHttpOptions = {}) {
    this.#port = options.port ?? 0;
    this.#configuredToken = options.token;
    this.#configuredOrigins = options.allowedOrigins?.slice();
    this.#maxRequestBytes = options.maxRequestBytes ?? 1024 * 1024;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10000;
    this.#progressKeepaliveMs = options.progressKeepaliveMs ?? 30000;
    this.#abortOnDisconnect = options.abortOnDisconnect ?? false;
    if (!Number.isInteger(this.#port) || this.#port < 0 || this.#port > 65535
      || !Number.isSafeInteger(this.#maxRequestBytes) || this.#maxRequestBytes <= 0
      || !Number.isSafeInteger(this.#heartbeatIntervalMs) || this.#heartbeatIntervalMs < 1 || this.#heartbeatIntervalMs > 2147483647
      || !Number.isSafeInteger(this.#progressKeepaliveMs) || this.#progressKeepaliveMs < 1 || this.#progressKeepaliveMs > 2147483647
      || typeof this.#abortOnDisconnect !== 'boolean') {
      throw new McpError('protocol_failure', 'Invalid HTTP transport limits.');
    }
  }

  async listen(handler: (request: ServerTransportRequest) => Promise<JsonValue>): Promise<{ url: string; token: string }> {
    if (this.#closed || this.#server) throw new McpError('protocol_failure', 'Transport is closed or already listening.');
    const token = this.#configuredToken === undefined ? crypto.randomBytes(32).toString('hex') : this.#configuredToken;
    // Validate before creating any listener; an empty credential must never match.
    if (typeof token !== 'string' || token.trim() !== token || !TOKEN.test(token)) {
      throw new McpError('protocol_failure', 'Bearer token must be non-empty and use bearer-token characters.');
    }
    if (this.#configuredOrigins?.some((origin) => !validOrigin(origin))) {
      throw new McpError('protocol_failure', 'Allowed origins must be exact numeric loopback origins.');
    }
    const expected = digest(token);
    let origins = new Set(this.#configuredOrigins);
    const authorize = (request: IncomingMessage): number | undefined => {
      const origin = request.headersDistinct.origin;
      if (origin && (origin.length !== 1 || !origins.has(origin[0]))) return 403;
      const authorization = request.headersDistinct.authorization;
      const match = authorization?.length === 1 ? /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization[0]) : null;
      if (!match || !crypto.timingSafeEqual(digest(match[1]), expected)) return 401;
      return undefined;
    };
    const server = http.createServer({ requestTimeout: 0, headersTimeout: 0, keepAliveTimeout: 0, maxHeaderSize: 16384 }, (request, response) => {
      void this.#respond(request, response, handler, authorize).catch(() => {
        // Transport failures never echo diagnostics, headers, arguments or tokens.
        if (!response.headersSent && !response.destroyed) send(response, 500, rpcError(null, -32603));
        else response.destroy();
      });
    });
    this.#server = server;
    server.timeout = 0;
    server.on('connection', (socket) => {
      if (this.#closed) { socket.destroy(); return; }
      socket.setTimeout(0);
      this.#sockets.add(socket);
      socket.once('close', () => this.#sockets.delete(socket));
    });
    const refuseTunnel = (request: IncomingMessage, socket: Socket): void => {
      const status = authorize(request) ?? 405;
      socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    server.on('upgrade', refuseTunnel);
    server.on('connect', refuseTunnel);
    // Do not send 100 Continue before checking credentials and Origin.
    server.on('checkContinue', (request, response) => {
      const status = authorize(request);
      if (status) send(response, status, rpcError(null, -32000));
      else { response.writeContinue(); server.emit('request', request, response); }
    });
    server.on('checkExpectation', (request, response) => {
      send(response, authorize(request) ?? 417, rpcError(null, -32000));
    });
    try {
      this.#starting = new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: this.#port, exclusive: true }, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      await this.#starting;
      if (this.#closed) { await this.close(); throw new McpError('protocol_failure', 'Transport closed during startup.'); }
      const address = server.address();
      if (!address || typeof address === 'string') throw new McpError('protocol_failure', 'No loopback listener.');
      const origin = `http://127.0.0.1:${address.port}`;
      if (this.#configuredOrigins === undefined) origins = new Set([origin]);
      return { url: `${origin}/mcp`, token };
    } catch {
      await this.close();
      throw new McpError('protocol_failure', 'Could not start loopback HTTP transport.');
    }
  }

  async #respond(request: IncomingMessage, response: ServerResponse,
    handler: (request: ServerTransportRequest) => Promise<JsonValue>,
    authorize: (request: IncomingMessage) => number | undefined): Promise<void> {
    const status = authorize(request);
    if (status) { send(response, status, rpcError(null, -32000)); return; }
    if (this.#closed) { send(response, 503, rpcError(null, -32000)); return; }
    if (request.url !== '/mcp') { send(response, 404, rpcError(null, -32600)); return; }
    if (request.method !== 'POST' || request.headers.upgrade !== undefined) {
      send(response, 405, rpcError(null, -32600)); return;
    }
    const accept = request.headers.accept;
    if (accept && !allows(accept, 'application/json') && !allows(accept, 'text/event-stream')) {
      send(response, 406, rpcError(null, -32600)); return;
    }
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      send(response, 415, rpcError(null, -32600)); return;
    }
    const headers: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [name, values] of Object.entries(request.headersDistinct)) {
      if (values?.length !== 1) { send(response, 400, rpcError(null, -32600)); return; }
      headers[name] = values[0];
    }
    if (headers['transfer-encoding']) { send(response, 400, rpcError(null, -32600)); return; }
    const length = headers['content-length'];
    if (!length || !/^(0|[1-9][0-9]*)$/.test(length)) { send(response, 411, rpcError(null, -32600)); return; }
    if (Number(length) > this.#maxRequestBytes) { send(response, 413, rpcError(null, -32600)); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > this.#maxRequestBytes) { send(response, 413, rpcError(null, -32600)); return; }
      chunks.push(bytes);
    }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { send(response, 400, rpcError(null, -32700)); return; }
    // A notification carries no id and gets no result; only `notifications/*`
    // methods may omit it (the classic `notifications/initialized` does).
    const notification = isJsonObject(body) && !Object.hasOwn(body, 'id')
      && typeof body.method === 'string' && body.method.startsWith('notifications/');
    if (!isJsonObject(body) || body.jsonrpc !== '2.0'
      || !(notification || typeof body.id === 'string' || (typeof body.id === 'number' && Number.isFinite(body.id)))
      || typeof body.method !== 'string' || (body.params !== undefined && !isJsonObject(body.params))) {
      send(response, 400, rpcError(null, -32600)); return;
    }
    if (accept && body.method !== 'tools/call' && !allows(accept, 'application/json')) {
      send(response, 406, rpcError(null, -32600)); return;
    }
    if (this.#closed || response.destroyed) return;
    if (notification) {
      // Streamable HTTP answers an accepted notification 202 with no body.
      if (body.method === 'notifications/cancelled') {
        const target = body.params?.requestId;
        if (typeof target === 'string' || (typeof target === 'number' && Number.isFinite(target))) {
          const matches = this.#calls.get(target);
          // No session identity exists here. Never pick a different caller when
          // authenticated concurrent clients happen to reuse a JSON-RPC id.
          if (matches?.size === 1) [...matches][0].controller.abort();
        }
        accepted(response); return;
      }
      try { await handler({ method: body.method, params: body.params, headers }); }
      catch { if (!this.#closed && !response.destroyed) send(response, 400, rpcError(null, -32600)); return; }
      if (!this.#closed && !response.destroyed) accepted(response);
      return;
    }
    // Validated above: every message that is not a notification has one.
    const id = body.id as string | number;
    const controller = body.method === 'tools/call' ? new AbortController() : undefined;
    const onDisconnect = (): void => {
      if (this.#abortOnDisconnect && !response.writableEnded) controller?.abort();
    };
    const onAbort = (): void => {
      if (response.destroyed || response.writableEnded) return;
      if (!response.headersSent) response.writeHead(204, { 'Connection': 'close', 'Cache-Control': 'no-store' });
      response.end();
    };
    const call = { controller: controller!, detach: (): void => {
      response.removeListener('close', onDisconnect);
      controller?.signal.removeEventListener('abort', onAbort);
    } };
    if (controller) {
      const active = this.#calls.get(id) ?? new Set(); active.add(call); this.#calls.set(id, active);
      response.once('close', onDisconnect); controller.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const request = { method: body.method, params: body.params, headers, ...(controller ? { signal: controller.signal } : {}) };
      const sse = allows(accept, 'text/event-stream', true)
        || (allows(accept, 'text/event-stream') && !allows(accept, 'application/json'));
      if (body.method === 'tools/call' && sse) { await this.#stream(response, request, id, handler); return; }
      const result = await handler(request);
      if (!this.#closed && !response.destroyed && !controller?.signal.aborted) send(response, 200, { jsonrpc: '2.0', id, result });
    } catch (error) {
      if (!this.#closed && !response.destroyed && !controller?.signal.aborted) {
        send(response, 200, rpcError(id, -32000, error instanceof McpError ? error.code : 'protocol_failure'));
      }
    } finally {
      call.detach();
      if (controller) { const active = this.#calls.get(id); active?.delete(call); if (active?.size === 0) this.#calls.delete(id); }
    }
  }

  async #stream(response: ServerResponse, request: ServerTransportRequest, id: string | number,
    handler: (request: ServerTransportRequest) => Promise<JsonValue>): Promise<void> {
    // POST SSE is a response to this authenticated request, never a GET push channel.
    // Open immediately: no held headers and no threshold timer racing a fast result.
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.flushHeaders();
    response.write(': open\n\n');
    let active = true, timer: ReturnType<typeof setInterval> | undefined;
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    let last = -1, lastNative = -1, warned = false;
    let native: { unit: string; message: string; progress?: number; total?: number } = { unit: 'native-work', message: 'working' };
    const stream = { response, stop: (): void => {
      active = false;
      if (timer !== undefined) { clearInterval(timer); timer = undefined; }
      if (progressTimer !== undefined) { clearInterval(progressTimer); progressTimer = undefined; }
      this.#streams.delete(stream);
      response.removeListener('close', stream.stop);
      request.signal?.removeEventListener('abort', onCancel);
    } };
    this.#streams.add(stream);
    response.once('close', stream.stop);
    const onCancel = (): void => { stream.stop(); if (!response.destroyed && !response.writableEnded) response.end(); };
    request.signal?.addEventListener('abort', onCancel, { once: true });
    const writable = (): boolean => active && !this.#closed && !response.destroyed && !response.writableEnded;
    const event = (value: JsonValue): void => { response.write(`event: message\ndata: ${JSON.stringify(value)}\n\n`); };
    const meta = request.params?._meta;
    const token = isJsonObject(meta) ? meta.progressToken : undefined;
    const hasToken = typeof token === 'string' || (typeof token === 'number' && Number.isFinite(token) && Number.isInteger(token));
    const warn = (): void => {
      // One generic diagnostic per stream: no token, message, arguments or numbers.
      if (warned) return; warned = true;
      try { process.emitWarning('Invalid, non-increasing or unrepresentable native tool progress was ignored for wire display.', { code: 'PRISM_MCP_PROGRESS_REJECTED' }); }
      catch { /* A diagnostic sink cannot fail the tool. */ }
    };
    const notify = (work: typeof native, origin: string): boolean => {
      if (!hasToken || !writable() || response.writableNeedDrain || last >= Number.MAX_SAFE_INTEGER) return false;
      const next = last + 1;
      let total: number | undefined;
      if (work.progress !== undefined && work.total !== undefined) {
        if (work.progress === 0) total = Number.MAX_VALUE;
        else if (work.progress >= work.total) total = next;
        else {
          const scaled = next / (work.progress / work.total);
          if (Number.isFinite(scaled) && scaled >= next) total = scaled;
          else warn(); // Preserve native metadata; an impossible finite ratio is indeterminate.
        }
      }
      const params: JsonValue = { progressToken: token as string | number, progress: next,
        ...(total === undefined ? {} : { total }), message: work.message,
        _meta: { 'particle-academy/progress': { unit: 'activity-notifications', origin, nativeWork: { ...work } } } };
      event({ jsonrpc: '2.0', method: 'notifications/progress', params }); last = next;
      return true;
    };
    const progress: ToolProgress = (message, amount, total): void => {
      try {
        if (!hasToken || !writable() || response.writableNeedDrain || typeof message !== 'string') return;
        if ((amount !== undefined && (!Number.isFinite(amount) || amount < 0 || amount <= lastNative))
          || (total !== undefined && (amount === undefined || !Number.isFinite(total) || total < 0))) { warn(); return; }
        const work = { unit: 'native-work', message: boundedMessage(message),
          ...(amount === undefined ? {} : { progress: amount }), ...(total === undefined ? {} : { total }) };
        if (notify(work, 'handler')) { native = work; if (amount !== undefined) lastNative = amount; }
      } catch { /* Best-effort progress never throws into a tool handler. */ }
    };
    try { notify(native, 'start'); } catch { /* Progress is best effort before handler dispatch too. */ }
    timer = setInterval(() => {
      if (!writable()) { stream.stop(); return; }
      if (!response.writableNeedDrain) response.write(': heartbeat\n\n');
    }, this.#heartbeatIntervalMs);
    timer.unref();
    if (hasToken) {
      progressTimer = setInterval(() => {
        if (!writable()) { stream.stop(); return; }
        try { notify(native, 'keepalive'); } catch { /* Closed or failed output never fails the handler. */ }
      }, this.#progressKeepaliveMs);
      progressTimer.unref();
    }
    try {
      const result = await handler({ ...request, progress });
      if (writable()) event({ jsonrpc: '2.0', id, result });
    } catch (error) {
      if (writable()) event(rpcError(id, -32000, error instanceof McpError ? error.code : 'protocol_failure'));
    } finally {
      const finish = writable(); stream.stop();
      if (finish) response.end();
    }
  }

  close(): Promise<void> {
    this.#closed = true;
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      await this.#starting?.catch(() => {});
      for (const calls of this.#calls.values()) for (const call of calls) call.detach();
      this.#calls.clear();
      await new Promise<void>((resolve) => {
        const server = this.#server;
        if (!server) { resolve(); return; }
        const streamingSockets = new Set<Socket>();
        for (const stream of [...this.#streams]) {
          if (stream.response.socket) streamingSockets.add(stream.response.socket);
          stream.stop(); stream.response.end();
        }
        // Let SSE responses finish normally; a stalled reader cannot hold shutdown.
        const expiry = streamingSockets.size ? setTimeout(() => {
          for (const socket of streamingSockets) socket.destroy();
        }, 100).unref() : undefined;
        server.close(() => { if (expiry) clearTimeout(expiry); resolve(); });
        // closeAllConnections omits upgraded sockets; track and end every socket.
        for (const socket of this.#sockets) if (!streamingSockets.has(socket)) socket.destroy();
      });
    })();
    return this.#closing;
  }
}

/** An explicit SSE media range opts in; wildcards retain the existing JSON choice. */
function allows(accept: string | undefined, media: string, explicit = false): boolean {
  if (accept === undefined) return !explicit;
  let quality = -1, specificity = -1;
  for (const entry of accept.split(',')) {
    const [range, ...parameters] = entry.trim().toLowerCase().split(';').map(value => value.trim());
    const rank = range === media ? 2 : !explicit && range === media.split('/')[0] + '/*' ? 1 : !explicit && range === '*/*' ? 0 : -1;
    if (rank < specificity || rank < 0) continue;
    const raw = parameters.find(value => value.startsWith('q='))?.slice(2);
    const next = raw === undefined ? 1 : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(raw) ? Number(raw) : 0;
    quality = rank === specificity ? Math.max(quality, next) : next; specificity = rank;
  }
  return quality > 0;
}

function boundedMessage(message: string): string {
  let result = '', bytes = 0;
  for (const char of message.slice(0, 4096)) {
    const next = Buffer.byteLength(char, 'utf8'); if (bytes + next > 4096) break;
    result += char; bytes += next;
  }
  return result;
}

function rpcError(id: JsonValue, code: number, category?: string): JsonValue {
  return { jsonrpc: '2.0', id, error: { code, message: 'MCP request refused.',
    ...(category ? { data: { code: category } } : {}) } };
}

function accepted(response: ServerResponse): void {
  response.writeHead(202, { 'Content-Length': 0, 'Connection': 'close', 'Cache-Control': 'no-store' });
  response.end();
}

function send(response: ServerResponse, status: number, body: JsonValue): void {
  const data = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
    'Connection': 'close', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(data);
}
