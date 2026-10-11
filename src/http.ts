import crypto from 'node:crypto';
import http, { type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { McpError, isJsonObject, type JsonValue, type TransportRequest } from '@particle-academy/prism-mcp';
import type { ServerTransport } from './index.js';

export interface LoopbackHttpOptions {
  port?: number;
  /** Omit to generate 256 random bits at listen(). Never log the returned token. */
  token?: string;
  /** Exact numeric loopback origins. Defaults to this listener's own origin. */
  allowedOrigins?: readonly string[];
  maxRequestBytes?: number;
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

/** POST-only, stateless JSON-RPC on a literal IPv4 loopback address. */
export class LoopbackHttpTransport implements ServerTransport {
  readonly #port: number;
  readonly #configuredToken?: string;
  readonly #configuredOrigins?: readonly string[];
  readonly #maxRequestBytes: number;
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
    if (!Number.isInteger(this.#port) || this.#port < 0 || this.#port > 65535
      || !Number.isSafeInteger(this.#maxRequestBytes) || this.#maxRequestBytes <= 0) {
      throw new McpError('protocol_failure', 'Invalid HTTP transport limits.');
    }
  }

  async listen(handler: (request: TransportRequest) => Promise<JsonValue>): Promise<{ url: string; token: string }> {
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
    handler: (request: TransportRequest) => Promise<JsonValue>,
    authorize: (request: IncomingMessage) => number | undefined): Promise<void> {
    const status = authorize(request);
    if (status) { send(response, status, rpcError(null, -32000)); return; }
    if (this.#closed) { send(response, 503, rpcError(null, -32000)); return; }
    if (request.url !== '/mcp') { send(response, 404, rpcError(null, -32600)); return; }
    if (request.method !== 'POST' || request.headers.upgrade !== undefined) {
      send(response, 405, rpcError(null, -32600)); return;
    }
    const accept = request.headers.accept;
    if (accept && !accept.split(',').some((entry) => /^(application\/json|\*\/\*)(?:\s*;|$)/i.test(entry.trim()))) {
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
    if (!isJsonObject(body) || body.jsonrpc !== '2.0'
      || !(typeof body.id === 'string' || (typeof body.id === 'number' && Number.isFinite(body.id)))
      || typeof body.method !== 'string' || (body.params !== undefined && !isJsonObject(body.params))) {
      send(response, 400, rpcError(null, -32600)); return;
    }
    if (this.#closed || response.destroyed) return;
    try {
      const result = await handler({ method: body.method, params: body.params, headers });
      if (!this.#closed && !response.destroyed) send(response, 200, { jsonrpc: '2.0', id: body.id, result });
    } catch (error) {
      if (!this.#closed && !response.destroyed) {
        send(response, 200, rpcError(body.id, -32000, error instanceof McpError ? error.code : 'protocol_failure'));
      }
    }
  }

  close(): Promise<void> {
    this.#closed = true;
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      await this.#starting?.catch(() => {});
      await new Promise<void>((resolve) => {
        const server = this.#server;
        if (!server) { resolve(); return; }
        server.close(() => resolve());
        // closeAllConnections omits upgraded sockets; track and end every socket.
        for (const socket of this.#sockets) socket.destroy();
      });
    })();
    return this.#closing;
  }
}

function rpcError(id: JsonValue, code: number, category?: string): JsonValue {
  return { jsonrpc: '2.0', id, error: { code, message: 'MCP request refused.',
    ...(category ? { data: { code: category } } : {}) } };
}

function send(response: ServerResponse, status: number, body: JsonValue): void {
  const data = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
    'Connection': 'close', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(data);
}
