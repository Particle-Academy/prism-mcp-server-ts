import http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@particle-academy/prism-mcp';
import { LoopbackHttpTransport, Server, ToolDefinition, type JsonObject, type McpToolResult, type ToolProgress } from '../src/index.js';

const servers: Server[] = [], clients: http.ClientRequest[] = [];
afterEach(async () => { for (const client of clients.splice(0)) client.destroy(); await Promise.all(servers.splice(0).map(server => server.close())); vi.useRealTimers(); vi.restoreAllMocks(); });
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function fixture(options: ConstructorParameters<typeof LoopbackHttpTransport>[0] = {}) {
  const transport = new LoopbackHttpTransport(options), server = new Server({ server: 'fixture', transport }); servers.push(server);
  let finish!: (value: McpToolResult) => void, report: ToolProgress | undefined, begin!: () => void;
  let signal: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { begin = resolve; });
  server.register(new ToolDefinition('wait', '', {}), (_args, context) => {
    report = context.progress; signal = context.signal; begin(); return new Promise(resolve => { finish = resolve; });
  });
  const endpoint = await server.listen();
  return { server, ...endpoint, started, signal: () => signal, finish: (value: McpToolResult = { text: 'complete', isError: false }) => finish(value), progress: (message: string, amount?: number, total?: number) => report?.(message, amount, total) };
}

function call(url: string, token: string | null, accept = 'application/json, text/event-stream', progressToken: unknown = 'progress-fixture', extra: http.OutgoingHttpHeaders = {}, meta: JsonObject = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name: 'wait', arguments: {},
    ...(progressToken === undefined ? {} : { _meta: { ...meta, progressToken } }) } });
  let text = '', headers: http.IncomingHttpHeaders = {}, status: number | undefined, opened!: () => void;
  const first = new Promise<void>(resolve => { opened = resolve; });
  let request!: http.ClientRequest;
  const done = new Promise<string>((resolve, reject) => {
    request = http.request(url, { method: 'POST', agent: false, headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Accept: accept, ...extra } }, response => {
      headers = response.headers; status = response.statusCode; response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; opened(); });
      response.once('end', () => resolve(text)); response.once('error', reject);
    });
    request.once('error', reject); request.end(body); clients.push(request);
  });
  void done.catch(() => {});
  return { first, done, request, text: () => text, headers: () => headers, status: () => status };
}

function messages(text: string): JsonObject[] {
  return text.split('\n\n').filter(part => part.startsWith('event: message\n')).map(part => JSON.parse(part.slice('event: message\ndata: '.length)) as JsonObject);
}

it.each([70000, 330000, 960000, 2100000])('streams immediately and keeps a %i ms tool alive with only heartbeat comments', async duration => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  const f = await fixture(), wire = call(f.url, f.token); await f.started;
  expect(await Promise.race([wire.first.then(() => true), delay(500).then(() => false)])).toBe(true);
  expect(wire.headers()['content-type']).toBe('text/event-stream'); expect(wire.text()).toContain(': open\n\n');
  await vi.advanceTimersByTimeAsync(duration); f.finish(); const text = await wire.done;
  expect(text.match(/: heartbeat\n\n/g)).toHaveLength(duration / 10000);
  expect(messages(text)).toEqual([
    { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'progress-fixture', progress: 0, message: 'Tool call started.' } },
    { jsonrpc: '2.0', id: 'call', result: { content: [{ type: 'text', text: 'complete' }], isError: false } },
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

it('forwards bounded, increasing token progress without injecting SSE fields', async () => {
  const f = await fixture(), wire = call(f.url, f.token); await f.started; await wire.first;
  f.progress('first', 1, 10); f.progress('stale', 1); f.progress('invalid', Number.NaN); f.progress('bad-total', 2, 1);
  f.progress('😀'.repeat(10000), 2, 10); f.progress('automatic'); f.progress('small\n\nevent: forged\ndata: {}', 4); f.finish();
  const events = messages(await wire.done), progress = events.filter(event => event.method === 'notifications/progress').map(event => event.params as JsonObject);
  expect(progress.map(value => value.progress)).toEqual([0, 1, 2, 3, 4]);
  expect(progress.every(value => value.progressToken === 'progress-fixture')).toBe(true);
  expect(Buffer.byteLength(progress[2].message as string)).toBeLessThanOrEqual(4096);
  expect(events.at(-1)).toHaveProperty('result');
  expect(events).toHaveLength(6);
  const before = wire.text(); expect(() => f.progress('late', 5)).not.toThrow(); await delay(5); expect(wire.text()).toBe(before);
});

it.each([undefined, null, true, 1.5])('omits progress for missing/invalid token %s while still streaming the result', async token => {
  const f = await fixture(), wire = call(f.url, f.token, 'text/event-stream', token === undefined ? Symbol('missing') : token); await f.started; await wire.first;
  expect(() => f.progress('ignored', 1)).not.toThrow(); f.finish();
  expect(messages(await wire.done)).toHaveLength(1);
});

it.each(['application/json', 'application/json, text/event-stream;q=0', '*/*'])('preserves exact classic JSON with Accept %s', async accept => {
  const f = await fixture(), wire = call(f.url, f.token, accept); await f.started;
  expect(() => f.progress('no stream', 1)).not.toThrow(); f.finish();
  expect(await wire.done).toBe('{"jsonrpc":"2.0","id":"call","result":{"content":[{"type":"text","text":"complete"}],"isError":false}}');
  expect(wire.headers()['content-type']).toBe('application/json');
});

it.each(['application/json', 'text/event-stream'])('cleans heartbeat timers on %s disconnect and ignores late output by default', async accept => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  const f = await fixture(), wire = call(f.url, f.token, accept); await f.started;
  if (accept === 'text/event-stream') await wire.first;
  expect(vi.getTimerCount()).toBe(accept === 'text/event-stream' ? 1 : 0); wire.request.destroy(); await delay(20);
  expect(vi.getTimerCount()).toBe(0); expect(f.signal()?.aborted).toBe(false); expect(() => f.progress('disconnected', 1)).not.toThrow(); f.finish();
});

it('ends SSE cleanly on shutdown and releases its timer without waiting for the handler', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  const f = await fixture(), wire = call(f.url, f.token); await f.started; await wire.first;
  await f.server.close(); expect(await wire.done).toContain(': open'); expect(vi.getTimerCount()).toBe(0);
  expect(() => f.progress('closed', 1)).not.toThrow(); f.finish();
});

it('sends final JSON-RPC errors without private handler diagnostics', async () => {
  const transport = new LoopbackHttpTransport(), server = new Server({ server: 'fixture', transport }); servers.push(server);
  server.register(new ToolDefinition('wait', '', {}), () => { throw new Error('private diagnostic'); });
  const endpoint = await server.listen(), wire = call(endpoint.url, endpoint.token);
  const text = await wire.done; expect(text).not.toContain('private diagnostic');
  expect(messages(text).at(-1)).toEqual({ jsonrpc: '2.0', id: 'call', error: { code: -32000, message: 'MCP request refused.', data: { code: 'tool_call_failed' } } });
});

it('keeps handler success when a custom progress channel throws', async () => {
  const server = new Server({ server: 'fixture', transport: { listen: async () => ({ url: 'memory:', token: null }), close: async () => {} } }); servers.push(server);
  server.register(new ToolDefinition('wait', '', {}), (_args, context) => { context.progress?.('test'); return { text: 'complete', isError: false }; });
  expect(await server.handle({ method: 'tools/call', params: { name: 'wait' }, progress: () => { throw new Error('private'); } })).toEqual({ content: [{ type: 'text', text: 'complete' }], isError: false });
});

function cancel(url: string, token: string | null, requestId: unknown = 'call', notification = true, headers: http.OutgoingHttpHeaders = {}): Promise<number> {
  const data = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason: 'private cancellation detail' }, ...(notification ? {} : { id: 'not-notification' }) });
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST', agent: false, headers: { Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Accept: 'application/json', ...headers } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode!)); });
    request.once('error', reject); request.end(data); clients.push(request);
  });
}

it.each(['application/json', 'text/event-stream'])('signals explicit cancellation for %s and drops late results', async accept => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  const f = await fixture(), wire = call(f.url, f.token, accept); await f.started;
  if (accept === 'text/event-stream') await wire.first;
  expect(f.signal()).toBeInstanceOf(AbortSignal); expect(f.signal()?.aborted).toBe(false);
  expect(await cancel(f.url, f.token)).toBe(202); expect(f.signal()?.aborted).toBe(true);
  const text = await wire.done; expect(text).not.toContain('private cancellation detail'); expect(messages(text).some(event => event.id === 'call')).toBe(false);
  expect(vi.getTimerCount()).toBe(0); f.finish({ text: 'late result must be dropped', isError: false });
  await delay(5); expect(wire.text()).toBe(text);
});

it.each(['application/json', 'text/event-stream'])('aborts a disconnected %s handler only when opted in', async accept => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  const f = await fixture({ abortOnDisconnect: true }), wire = call(f.url, f.token, accept); await f.started;
  if (accept === 'text/event-stream') await wire.first;
  wire.request.destroy(); await delay(20); expect(f.signal()?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  f.finish(); expect(() => f.progress('late', 1)).not.toThrow();
});

it('ignores unauthenticated, malformed, unknown and request-shaped cancellations', async () => {
  const f = await fixture(), wire = call(f.url, f.token); await f.started; await wire.first;
  expect(await cancel(f.url, 'wrong')).toBe(401);
  expect(await cancel(f.url, f.token, 'call', true, { Origin: 'https://attacker.example' })).toBe(403);
  for (const target of [undefined, null, {}, true, 'unknown']) { expect(await cancel(f.url, f.token, target === undefined ? Symbol('missing') : target)).toBe(202); expect(f.signal()?.aborted).toBe(false); }
  expect(await cancel(f.url, f.token, 'call', false)).toBe(200); expect(f.signal()?.aborted).toBe(false);
  f.finish(); expect(messages(await wire.done).at(-1)).toHaveProperty('result');
});

it('does not choose another caller when concurrent clients reuse a request id', async () => {
  const transport = new LoopbackHttpTransport(), server = new Server({ server: 'fixture', transport }); servers.push(server);
  const signals: AbortSignal[] = [], finishes: ((value: McpToolResult) => void)[] = [], reports = new Map<string, ToolProgress>();
  server.register(new ToolDefinition('wait', '', {}), (_args, context) => { signals.push(context.signal!); reports.set(context.headers.client, context.progress!); return new Promise(resolve => finishes.push(resolve)); });
  const endpoint = await server.listen(), a = call(endpoint.url, endpoint.token, 'text/event-stream', 'a-token', { 'Mcp-Param-client': 'a' }), b = call(endpoint.url, endpoint.token, 'text/event-stream', 'b-token', { 'Mcp-Param-client': 'b' }); await Promise.all([a.first, b.first]);
  expect(await cancel(endpoint.url, endpoint.token)).toBe(202); expect(signals.map(signal => signal.aborted)).toEqual([false, false]);
  reports.get('a')!('only-a', 1); reports.get('b')!('only-b', 1);
  for (const finish of finishes) finish({ text: 'done', isError: false }); await Promise.all([a.done, b.done]);
  expect(a.text()).not.toContain('only-b'); expect(b.text()).not.toContain('only-a');
  expect(messages(a.text()).filter(event => event.method === 'notifications/progress').every(event => (event.params as JsonObject).progressToken === 'a-token')).toBe(true);
  expect(messages(b.text()).filter(event => event.method === 'notifications/progress').every(event => (event.params as JsonObject).progressToken === 'b-token')).toBe(true);
});

it('never starts a tool cancelled while its gate was pending', async () => {
  let allow!: (value: boolean) => void, entered!: () => void, calls = 0;
  const gated = new Promise<void>(resolve => { entered = resolve; }), transport = new LoopbackHttpTransport();
  const server = new Server({ server: 'fixture', transport, gate: () => { entered(); return new Promise(resolve => { allow = resolve; }); } }); servers.push(server);
  server.register(new ToolDefinition('wait', '', {}), () => { calls++; return { text: 'wrong', isError: false }; });
  const endpoint = await server.listen(), wire = call(endpoint.url, endpoint.token); await gated;
  expect(await cancel(endpoint.url, endpoint.token)).toBe(202); allow(true); await wire.done; expect(calls).toBe(0);
});

it('honors a text media wildcard without returning an unacceptable JSON body', async () => {
  const f = await fixture(), wire = call(f.url, f.token, 'text/*'); await f.started; await wire.first;
  expect(wire.headers()['content-type']).toBe('text/event-stream'); f.finish(); expect(messages(await wire.done).at(-1)).toHaveProperty('result');
});

it('uses the configured heartbeat cadence and refuses invalid options', async () => {
  for (const heartbeatIntervalMs of [0, -1, 1.5, Number.NaN, 2147483648]) expect(() => new LoopbackHttpTransport({ heartbeatIntervalMs })).toThrow();
  expect(() => new LoopbackHttpTransport({ abortOnDisconnect: 'true' as unknown as boolean })).toThrow();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  const f = await fixture({ heartbeatIntervalMs: 5000 }), wire = call(f.url, f.token); await f.started; await wire.first;
  await vi.advanceTimersByTimeAsync(15000); f.finish(); expect((await wire.done).match(/: heartbeat\n\n/g)).toHaveLength(3); expect(vi.getTimerCount()).toBe(0);
});

it('checks credentials and Origin before opening any SSE stream or handler', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  const f = await fixture();
  for (const token of [null, 'wrong', 'a'.repeat(64)]) {
    const wire = call(f.url, token); expect(await wire.done).not.toContain(': open'); expect(wire.status()).toBe(401); expect(wire.headers()['content-type']).toBe('application/json');
  }
  const wire = call(f.url, f.token, 'text/event-stream', 'token', { Origin: 'https://attacker.example' });
  expect(await wire.done).not.toContain(': open'); expect(wire.status()).toBe(403); expect(f.signal()).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
});

it('preserves stateless metadata inside the final SSE response', async () => {
  const f = await fixture(), wire = call(f.url, f.token, 'text/event-stream', 'stateless', {}, {
    'io.modelcontextprotocol/protocolVersion': LATEST_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
  }); await f.started; await wire.first; f.finish();
  expect(messages(await wire.done).at(-1)).toEqual({ jsonrpc: '2.0', id: 'call', result: {
    content: [{ type: 'text', text: 'complete' }], isError: false, resultType: 'complete',
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: '@particle-academy/prism-mcp-server', version: '0.4.0' } },
  } });
});

it.each(['', 0, -1, Number.MAX_SAFE_INTEGER])('echoes a valid string/integer progress token exactly: %s', async token => {
  const f = await fixture(), wire = call(f.url, f.token, 'text/event-stream', token); await f.started; await wire.first; f.progress('step', 1); f.finish();
  const notifications = messages(await wire.done).filter(event => event.method === 'notifications/progress');
  expect(notifications).toHaveLength(2); expect(notifications.map(event => (event.params as JsonObject).progressToken)).toEqual([token, token]);
});

it('honors output backpressure without queueing progress or heartbeats', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  const f = await fixture(), wire = call(f.url, f.token); await f.started; await wire.first;
  const drain = vi.spyOn(http.ServerResponse.prototype, 'writableNeedDrain', 'get').mockReturnValue(true);
  f.progress('blocked-message', 1); await vi.advanceTimersByTimeAsync(20000); drain.mockRestore();
  f.progress('resumed', 1); f.finish(); const text = await wire.done;
  expect(text).not.toContain('blocked-message'); expect(text).not.toContain(': heartbeat');
  expect(messages(text).filter(event => event.method === 'notifications/progress').map(event => (event.params as JsonObject).progress)).toEqual([0, 1]);
  expect(messages(text).at(-1)).toHaveProperty('result'); expect(vi.getTimerCount()).toBe(0);
});
