import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@particle-academy/prism-mcp';
import { LoopbackHttpTransport, McpError, Server, ToolDefinition, type JsonObject, type McpToolResult } from '../src/index.js';

const transports: LoopbackHttpTransport[] = [];
afterEach(async () => { await Promise.all(transports.map((transport) => transport.close())); transports.length = 0; vi.restoreAllMocks(); });

function rpc(method = 'tools/list', params: JsonObject = {}): JsonObject {
  return { jsonrpc: '2.0', id: 'http-test', method, params: { ...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': LATEST_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'http-test', version: '1' },
  } } };
}

async function setup(options: ConstructorParameters<typeof LoopbackHttpTransport>[0] = {}) {
  const transport = new LoopbackHttpTransport(options); transports.push(transport);
  const server = new Server({ server: 'fixture', transport });
  const endpoint = await server.listen();
  expect(typeof endpoint.token).toBe('string');
  return { server, transport, url: endpoint.url, token: endpoint.token as string };
}

function send(url: string, token?: string, headers: http.OutgoingHttpHeaders = {}, body: unknown = rpc(), method = 'POST', deadline = 3000): Promise<{ status: number; body: JsonObject; headers: http.IncomingHttpHeaders }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, agent: false, headers: { 'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data), ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }), ...headers } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.once('end', () => resolve({ status: response.statusCode!, body: text ? JSON.parse(text) as JsonObject : {}, headers: response.headers }));
      response.once('error', reject);
    });
    const expiry = setTimeout(() => request.destroy(new Error('Test request exceeded deadline.')), deadline);
    request.once('close', () => clearTimeout(expiry));
    request.once('connect', (response, socket) => { socket.destroy(); resolve({ status: response.statusCode!, body: {}, headers: response.headers }); });
    request.once('error', reject);
    request.end(data);
  });
}

it.each(['tools/list', 'tools/call'])('serves %s without clientInfo over HTTP while preserving security checks', async (method) => {
  const { server, url, token } = await setup();
  const handler = vi.fn(() => ({ text: 'served', isError: false }));
  server.register(new ToolDefinition('echo', '', {}), handler);
  const body = rpc(method, method === 'tools/call' ? { name: 'echo' } : {});
  const meta = (body.params as JsonObject)._meta as JsonObject;
  delete meta['io.modelcontextprotocol/clientInfo'];
  for (const candidate of [undefined, '', `${token[0] === 'a' ? 'b' : 'a'}${token.slice(1)}`]) {
    expect((await send(url, candidate, {}, body)).status).toBe(401);
  }
  expect((await send(url, token, { Origin: 'https://attacker.example' }, body)).status).toBe(403);
  for (const version of [undefined, 'wrong', '2025-11-25']) {
    if (version === undefined) delete meta['io.modelcontextprotocol/protocolVersion'];
    else meta['io.modelcontextprotocol/protocolVersion'] = version;
    expect((await send(url, token, {}, body)).body.error).toMatchObject({ data: { code: 'unsupported_protocol_version' } });
  }
  meta['io.modelcontextprotocol/protocolVersion'] = LATEST_PROTOCOL_VERSION;
  delete meta['io.modelcontextprotocol/clientCapabilities'];
  expect((await send(url, token, {}, body)).body.error).toMatchObject({ data: { code: 'protocol_failure' } });
  meta['io.modelcontextprotocol/clientCapabilities'] = {};
  expect(handler).not.toHaveBeenCalled();
  const reply = await send(url, token, { Origin: new URL(url).origin }, body);
  expect(reply.status).toBe(200);
  expect(reply.headers).not.toHaveProperty('mcp-session-id');
  expect(reply.body.result).toMatchObject({ resultType: 'complete', _meta: {
    'io.modelcontextprotocol/serverInfo': { name: '@particle-academy/prism-mcp-server', version: '0.5.0' },
  } });
  if (method === 'tools/list') expect((reply.body.result as JsonObject).tools).toHaveLength(1);
  else { expect((reply.body.result as JsonObject).content).toEqual([{ type: 'text', text: 'served' }]); expect(handler).toHaveBeenCalledOnce(); }
});

it.each([
  ['no params', undefined], ['empty params', {}], ['no _meta', { name: 'ignored' }],
  ['empty _meta', { _meta: {} }],
  ['older version', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } }],
  ['unknown version', { _meta: { 'io.modelcontextprotocol/protocolVersion': 'unknown' } }],
  ['no capabilities', { _meta: { 'io.modelcontextprotocol/protocolVersion': LATEST_PROTOCOL_VERSION } }],
] as const)('answers HTTP discovery before negotiation while requiring bearer and Origin: %s', async (_name, params) => {
  const { url, token } = await setup();
  const body = { jsonrpc: '2.0', id: 'probe', method: 'server/discover', ...(params === undefined ? {} : { params }) };
  const different = `${token[0] === 'a' ? 'b' : 'a'}${token.slice(1)}`;
  for (const candidate of [undefined, '', 'wrong', different]) expect((await send(url, candidate, {}, body)).status).toBe(401);
  expect((await send(url, token, { Origin: 'https://attacker.example' }, body)).status).toBe(403);
  const reply = await send(url, token, { Origin: new URL(url).origin }, body);
  expect(reply.status).toBe(200);
  expect(reply.headers).not.toHaveProperty('mcp-session-id');
  expect(reply.body).toEqual({ jsonrpc: '2.0', id: 'probe', result: {
    resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} },
    ttlMs: 0, cacheScope: 'private', _meta: {
      'io.modelcontextprotocol/serverInfo': { name: '@particle-academy/prism-mcp-server', version: '0.5.0' },
    },
  } });
});

it('binds literal 127.0.0.1 and is unreachable on every non-loopback IPv4 interface', async () => {
  const listen = vi.spyOn(http.Server.prototype, 'listen');
  const { url, token } = await setup();
  expect(listen).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.1' }), expect.any(Function));
  expect(new URL(url).hostname).toBe('127.0.0.1');
  expect((await send(url, token)).status).toBe(200);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      await expect(send(url.replace('127.0.0.1', entry.address), token, {}, rpc(), 'POST', 1000)).rejects.toThrow();
    }
  }
}, 20000);

it('generates fresh 256-bit tokens at startup and never puts them in the URL', async () => {
  const first = await setup(), second = await setup();
  expect(first.token).toMatch(/^[0-9a-f]{64}$/);
  expect(second.token).not.toBe(first.token);
  expect(first.url).not.toContain(first.token);
  expect((await send(first.url, second.token)).status).toBe(401);
});

it.each(['', ' ', '\t\r\n', ' padded ', 'bad token', 'valid\n'])('refuses to listen with an invalid configured token %#', async (token) => {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const transport = new LoopbackHttpTransport({ token, port }); transports.push(transport);
  const listen = vi.spyOn(http.Server.prototype, 'listen');
  await expect(transport.listen(async () => ({}))).rejects.toBeInstanceOf(McpError);
  expect(listen).not.toHaveBeenCalled();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(port, '127.0.0.1', resolve); });
  await new Promise<void>((resolve) => listener.close(() => resolve()));
});

it('refuses absent, wrong, one-byte-different, empty and ambiguous credentials before dispatch', async () => {
  const { server, url, token } = await setup();
  const handler = vi.fn(() => ({ text: 'authorized', isError: false }));
  server.register(new ToolDefinition('run', '', {}), handler);
  const call = rpc('tools/call', { name: 'run' });
  const different = `${token[0] === 'a' ? 'b' : 'a'}${token.slice(1)}`;
  for (const candidate of [undefined, 'wrong', different, '', ' ']) {
    expect((await send(url, candidate, {}, call)).status).toBe(401);
  }
  expect((await send(url, undefined, { Authorization: [`Bearer ${token}`, `Bearer ${token}`] }, call)).status).toBe(401);
  expect(handler).not.toHaveBeenCalled();
  expect((await send(url, token, {}, call)).status).toBe(200);
  expect(handler).toHaveBeenCalledOnce();
});

it('checks equal-size digests with the constant-time primitive for every credential length', async () => {
  const compare = vi.spyOn(crypto, 'timingSafeEqual');
  const { url, token } = await setup();
  for (const candidate of [token, 'x', 'x'.repeat(100)]) await send(url, candidate);
  expect(compare).toHaveBeenCalledTimes(3);
  for (const [left, right] of compare.mock.calls) {
    expect(left.byteLength).toBe(32); expect(right.byteLength).toBe(32);
  }
});

it.each(['https://hostile.example', 'http://127.0.0.1.evil.example', 'http://localhost:1234', 'http://127.0.0.2:1234', 'null', '', 'http://127.0.0.1:1234'])('refuses browser Origin %s before dispatch', async (origin) => {
  const { server, url, token } = await setup();
  const handler = vi.fn(() => ({ text: 'secret', isError: false }));
  server.register(new ToolDefinition('run', '', {}), handler);
  expect((await send(url, token, { Origin: origin }, rpc('tools/call', { name: 'run' }))).status).toBe(403);
  expect(handler).not.toHaveBeenCalled();
});

it('admits its own Origin and only explicitly allow-listed additional loopback Origins', async () => {
  const own = await setup();
  expect((await send(own.url, own.token, { Origin: new URL(own.url).origin })).status).toBe(200);
  const configured = await setup({ allowedOrigins: ['http://127.0.0.1:1234', 'https://[::1]:4567'] });
  for (const Origin of ['http://127.0.0.1:1234', 'https://[::1]:4567']) {
    expect((await send(configured.url, configured.token, { Origin })).status).toBe(200);
  }
  expect((await send(configured.url, configured.token, { Origin: new URL(configured.url).origin })).status).toBe(403);
});

it.each(['http://evil.example', 'http://0.0.0.0:1', 'http://127.1:1', 'http://localhost:1', 'http://127.0.0.1:70000', 'http://127.0.0.1:1/path'])('rejects non-loopback/malformed Origin configuration %s before startup', async (origin) => {
  const transport = new LoopbackHttpTransport({ allowedOrigins: [origin] }); transports.push(transport);
  await expect(transport.listen(async () => ({}))).rejects.toMatchObject({ code: 'protocol_failure' });
});

it('refuses GET/SSE, upgrades, CONNECT and SSE-only POSTs, including unauthenticated attempts', async () => {
  const { url, token } = await setup();
  for (const candidate of [undefined, token]) {
    for (const [method, headers] of [
      ['GET', { Accept: 'text/event-stream' }],
      ['GET', { Connection: 'Upgrade', Upgrade: 'websocket' }],
      ['CONNECT', {}],
    ] as const) expect((await send(url, candidate, headers, rpc(), method)).status).toBe(candidate ? 405 : 401);
  }
  expect((await send(url, token, { Accept: 'text/event-stream' })).status).toBe(406);
  expect((await send(url, token, { Accept: 'application/json, text/event-stream' })).status).toBe(200);
});

it('checks credentials and Origin before 100 Continue, unusual methods and expectations', async () => {
  const { url, token } = await setup();
  for (const method of ['POST', 'TRACE']) {
    expect((await send(url, undefined, {}, rpc(), method)).status).toBe(401);
    expect((await send(url, token, { Origin: 'https://hostile.example' }, rpc(), method)).status).toBe(403);
  }
  expect((await send(url, undefined, { Expect: '100-continue' })).status).toBe(401);
  expect((await send(url, token, { Expect: '100-continue' })).status).toBe(200);
  expect((await send(url, undefined, { Expect: 'unrecognized' })).status).toBe(401);
  expect((await send(url, token, { Expect: 'unrecognized' })).status).toBe(417);
});

it('preserves pins, namespaced mirrors and credential isolation over real HTTP', async () => {
  const { server, url, token } = await setup();
  const tool = new ToolDefinition('mirror', '', { properties: { value: { type: 'string', 'x-mcp-header': 'authorization' } } });
  const handler = vi.fn((args: JsonObject, context: { headers: Record<string, string> }) => ({ text: JSON.stringify({ args, context }), isError: true }));
  server.register(tool, handler);
  const list = await send(url, token);
  const tools = (list.body.result as { tools: JsonObject[] }).tools;
  expect(ToolDefinition.fromPayload(tools[0]).digest()).toBe(tool.digest());
  for (const mirror of [false, true]) {
    const reply = await send(url, token, { Cookie: 'PRIVATE-COOKIE', ...(mirror ? { 'Mcp-Param-authorization': 'public' } : {}) }, rpc('tools/call', { name: 'mirror' }));
    expect(handler.mock.calls.at(-1)![0]).toEqual(mirror ? { value: 'public' } : {});
    expect(handler.mock.calls.at(-1)![1].headers).toEqual(mirror ? { authorization: 'public' } : {});
    expect(JSON.stringify(reply.body)).not.toContain(token);
    expect(JSON.stringify(reply.body)).not.toContain('PRIVATE-COOKIE');
    expect((reply.body.result as JsonObject).isError).toBe(true);
  }
});

it('maps shared errors and caps oversized error results without exposing diagnostics', async () => {
  const { server, url, token } = await setup();
  server.register(new ToolDefinition('large', '', {}), () => ({ text: 'x'.repeat(65537), isError: true }));
  server.register(new ToolDefinition('throws', '', {}), () => { throw new Error(`PRIVATE-${token}`); });
  for (const [name, code] of [['large', 'result_too_large'], ['throws', 'tool_call_failed']]) {
    const reply = await send(url, token, {}, rpc('tools/call', { name }));
    expect(reply.status).toBe(200);
    expect(reply.body.error).toMatchObject({ data: { code } });
    expect(JSON.stringify(reply.body)).not.toContain(token);
  }
});

it('bounds body size and refuses malformed JSON-RPC, content types and duplicate mirrors', async () => {
  const { url, token } = await setup({ maxRequestBytes: 512 });
  expect((await send(url, token, {}, rpc('tools/list', { padding: 'x'.repeat(513) }))).status).toBe(413);
  for (const body of [[], {}, { jsonrpc: '2.0', id: true, method: 'tools/list' }, { ...rpc(), params: [] }]) {
    expect((await send(url, token, {}, body)).status).toBe(400);
  }
  expect((await send(url, token, { 'Content-Type': 'text/plain' })).status).toBe(415);
  expect((await send(url, token, { 'Mcp-Param-X': ['one', 'two'] })).status).toBe(400);
  expect((await send(url.replace('/mcp', '/other'), token)).status).toBe(404);
});

it('explicitly disables every Node request/header/socket/keepalive timeout', async () => {
  const create = vi.spyOn(http, 'createServer');
  const { url, token } = await setup();
  const native = create.mock.results[0].value as http.Server;
  expect(native.requestTimeout).toBe(0); expect(native.headersTimeout).toBe(0);
  expect(native.timeout).toBe(0); expect(native.keepAliveTimeout).toBe(0);
  let socketTimeout: number | undefined;
  native.once('connection', (socket) => { socketTimeout = socket.timeout; });
  await send(url, token); expect(socketTimeout ?? 0).toBe(0);
});

it('completes a real long-poll held past the 300-second Node default', async () => {
  const { server, url, token } = await setup();
  let started!: () => void, finish!: (result: McpToolResult) => void;
  const begun = new Promise<void>((resolve) => { started = resolve; });
  server.register(new ToolDefinition('receive', '', {}), () => { started(); return new Promise((resolve) => { finish = resolve; }); });
  const pending = send(url, token, {}, rpc('tools/call', { name: 'receive' }), 'POST', 330000);
  const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
  await begun;
  const before = performance.now();
  await new Promise((resolve) => setTimeout(resolve, 310000));
  expect(performance.now() - before).toBeGreaterThan(300000);
  finish({ text: 'long-poll-complete', isError: false });
  expect(await outcome).toMatchObject({ value: { status: 200, body: { result: { content: [{ type: 'text', text: 'long-poll-complete' }] } } } });
}, 340000);

it('close releases held long-polls and incomplete headers, and the exact port can be rebound', async () => {
  const { server, transport, url, token } = await setup();
  let started!: () => void, finish!: (result: McpToolResult) => void;
  const begun = new Promise<void>((resolve) => { started = resolve; });
  server.register(new ToolDefinition('receive', '', {}), () => { started(); return new Promise((resolve) => { finish = resolve; }); });
  const pending = send(url, token, {}, rpc('tools/call', { name: 'receive' }));
  const outcome = pending.then(() => 'unexpected success', () => 'closed');
  await begun;
  const idle = net.connect(Number(new URL(url).port), '127.0.0.1');
  idle.setTimeout(3000, () => idle.destroy());
  idle.on('error', (error: NodeJS.ErrnoException) => { expect(error.code).toBe('ECONNRESET'); });
  const idleClosed = new Promise<void>((resolve) => idle.once('close', () => resolve()));
  await new Promise<void>((resolve) => idle.once('connect', () => { idle.write('POST /mcp HTTP/1.1\r\n'); resolve(); }));
  await Promise.race([Promise.all([server.close(), transport.close()]), new Promise((_, reject) => setTimeout(() => reject(new Error('close stalled')), 2000).unref())]);
  expect(await outcome).toBe('closed'); await idleClosed;
  const rebound = net.createServer();
  await new Promise<void>((resolve, reject) => { rebound.once('error', reject); rebound.listen(Number(new URL(url).port), '127.0.0.1', resolve); });
  await new Promise<void>((resolve) => rebound.close(() => resolve()));
  await expect(transport.listen(async () => ({}))).rejects.toMatchObject({ code: 'protocol_failure' });
  finish({ text: 'late', isError: false });
});

it('close during startup also releases the port', async () => {
  const transport = new LoopbackHttpTransport(); transports.push(transport);
  const pending = transport.listen(async () => ({}));
  const outcome = pending.then(() => 'unexpected success', () => 'closed');
  await transport.close(); expect(await outcome).toBe('closed');
});
