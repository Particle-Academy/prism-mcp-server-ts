import http from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@particle-academy/prism-mcp';
import { LoopbackHttpTransport, Server, ToolDefinition, type JsonObject, type ToolGate } from '../src/index.js';

// prism-mcp-server-ts#1. Codex's MCP client opens with the classic `initialize`
// handshake and was refused before tools/list, so Genie's Codex agents got none
// of Genie's tools. The classic protocol is served on the same transport and the
// same registry; bearer, Origin, limits, the gate and the result guard apply to
// it exactly as they do to the stateless path.

const transports: LoopbackHttpTransport[] = [];
afterEach(async () => { await Promise.all(transports.map((transport) => transport.close())); transports.length = 0; });

async function setup(gate?: ToolGate) {
  const transport = new LoopbackHttpTransport(); transports.push(transport);
  const server = new Server({ server: 'fixture', transport, gate });
  server.register(new ToolDefinition('echo', 'Echo.', { type: 'object', properties: { text: { type: 'string' } } }),
    (args) => ({ text: `echo:${String(args.text)}`, isError: false }));
  const endpoint = await server.listen();
  return { url: endpoint.url, token: endpoint.token as string };
}

let id = 0;
function send(url: string, token: string | undefined, body: JsonObject, headers: http.OutgoingHttpHeaders = {}):
  Promise<{ status: number; body: JsonObject; text: string }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST', agent: false, headers: {
      'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(data),
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }), ...headers } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.once('end', () => resolve({ status: response.statusCode!, text, body: text ? JSON.parse(text) as JsonObject : {} }));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.end(data);
  });
}

const call = (method: string, params?: JsonObject): JsonObject =>
  ({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) });

const INITIALIZE = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: '0.156.1' } };

it('serves the classic initialize -> initialized -> tools/list -> tools/call exchange', async () => {
  const { url, token } = await setup();

  const init = await send(url, token, call('initialize', INITIALIZE));
  expect(init.status).toBe(200);
  expect(init.body.result).toEqual({
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: '@particle-academy/prism-mcp-server', version: '0.3.0' },
  });

  const initialized = await send(url, token, { jsonrpc: '2.0', method: 'notifications/initialized' });
  expect(initialized.status).toBe(202);
  expect(initialized.text).toBe('');

  const headers = { 'MCP-Protocol-Version': '2025-06-18' };
  const list = await send(url, token, call('tools/list'), headers);
  expect(list.body.result).toEqual({ tools: [{ name: 'echo', description: 'Echo.', annotations: {},
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });

  const result = await send(url, token, call('tools/call', { name: 'echo', arguments: { text: 'hi' } }), headers);
  expect(result.body.result).toEqual({ content: [{ type: 'text', text: 'echo:hi' }], isError: false });
});

it('answers a classic ping', async () => {
  const { url, token } = await setup();
  expect((await send(url, token, call('ping'))).body.result).toEqual({});
});

it.each([
  ['a revision it serves', '2025-03-26', '2025-03-26'],
  ['the newest classic revision', '2025-11-25', '2025-11-25'],
  ['a revision it does not know', '2099-01-01', '2025-11-25'],
])('negotiates %s', async (_name, requested, answered) => {
  const { url, token } = await setup();
  const init = await send(url, token, call('initialize', { ...INITIALIZE, protocolVersion: requested }));
  expect((init.body.result as JsonObject).protocolVersion).toBe(answered);
});

it('still requires the bearer token on the classic path', async () => {
  const { url, token } = await setup();
  for (const candidate of [undefined, 'wrong', `${token[0] === 'a' ? 'b' : 'a'}${token.slice(1)}`]) {
    expect((await send(url, candidate, call('initialize', INITIALIZE))).status).toBe(401);
    expect((await send(url, candidate, call('tools/call', { name: 'echo', arguments: { text: 'x' } }))).status).toBe(401);
    expect((await send(url, candidate, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(401);
  }
});

it('still refuses a foreign Origin on the classic path', async () => {
  const { url, token } = await setup();
  const reply = await send(url, token, call('initialize', INITIALIZE), { Origin: 'https://attacker.example' });
  expect(reply.status).toBe(403);
});

it('applies the gate to classic tool calls', async () => {
  let ran = false;
  const { url, token } = await setup(async () => { ran = true; return false; });
  const reply = await send(url, token, call('tools/call', { name: 'echo', arguments: { text: 'x' } }));
  expect(ran).toBe(true);
  expect(reply.body.error).toMatchObject({ data: { code: 'tool_denied' } });
});

it('refuses a classic request that names a revision it does not serve', async () => {
  const { url, token } = await setup();
  for (const version of ['2026-07-28', 'nonsense']) {
    const reply = await send(url, token, call('tools/list'), { 'MCP-Protocol-Version': version });
    expect(reply.body.error).toMatchObject({ data: { code: 'unsupported_protocol_version' } });
  }
});

it('does not let a half-formed stateless request fall through to the classic path', async () => {
  // Any stateless metadata key makes it a stateless request, held to the
  // stateless rules: a missing version is refused, not served as classic.
  const { url, token } = await setup();
  const reply = await send(url, token, call('tools/list', { _meta: { 'io.modelcontextprotocol/clientCapabilities': {} } }));
  expect(reply.body.error).toMatchObject({ data: { code: 'unsupported_protocol_version' } });
});

it('accepts only notifications without an id, and requires an id otherwise', async () => {
  const { url, token } = await setup();
  expect((await send(url, token, { jsonrpc: '2.0', method: 'tools/list' })).status).toBe(400);
});

it('refuses an initialize whose parameters are malformed', async () => {
  const { url, token } = await setup();
  for (const params of [{}, { protocolVersion: 7 }, { ...INITIALIZE, capabilities: [] }, { ...INITIALIZE, clientInfo: 'x' }]) {
    expect((await send(url, token, call('initialize', params))).body.error).toMatchObject({ data: { code: 'protocol_failure' } });
  }
});

it('leaves the stateless path unchanged (the control)', async () => {
  const { url, token } = await setup();
  const reply = await send(url, token, call('tools/list', { _meta: {
    'io.modelcontextprotocol/protocolVersion': LATEST_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
  } }));
  expect(reply.body.result).toMatchObject({ resultType: 'complete', tools: [{ name: 'echo' }] });
});
