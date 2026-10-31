import { expect, it } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@particle-academy/prism-mcp';
import { InMemoryTransport, Server, ToolDefinition, type JsonObject, type TransportRequest } from '../src/index.js';

const VERSION = 'io.modelcontextprotocol/protocolVersion';
const CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
const SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
const identity = { name: '@particle-academy/prism-mcp-server', version: '0.4.0' };

function request(method: string, clientInfo = true): TransportRequest {
  return { method, params: { name: 'echo', _meta: {
    [VERSION]: LATEST_PROTOCOL_VERSION, [CAPABILITIES]: {},
    ...(clientInfo ? { [CLIENT_INFO]: { name: 'protocol-test', version: '1' } } : {}),
  } } };
}

async function setup(isError = false) {
  const transport = new InMemoryTransport();
  const server = new Server({ server: 'fixture', transport });
  server.register(new ToolDefinition('echo', '', {}), () => ({ text: 'served', isError }));
  await server.listen();
  return { server, transport };
}

it.each(['tools/list', 'tools/call'])('serves %s when clientInfo is omitted', async (method) => {
  const { server, transport } = await setup();
  try {
    const result = await transport.request(request(method, false)) as JsonObject;
    if (method === 'tools/list') expect(result.tools).toHaveLength(1);
    else expect(result.content).toEqual([{ type: 'text', text: 'served' }]);
  } finally { await server.close(); }
});

it('answers server/discover with only the supported version and implemented capabilities', async () => {
  const { server, transport } = await setup();
  try {
    const raw = request('server/discover');
    delete raw.params!.name;
    expect(await transport.request(raw)).toMatchObject({
      supportedVersions: ['2026-07-28'], capabilities: { tools: {} },
      resultType: 'complete', ttlMs: 0, cacheScope: 'private',
    });
    const result = await transport.request(raw) as JsonObject;
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result._meta).toEqual({ [SERVER_INFO]: identity });
    expect(result).not.toHaveProperty('sessionId');
    // Discovery is optional; this new server accepts a tool call without a probe.
    const fresh = await setup();
    try {
      expect(await fresh.transport.request(request('tools/call'))).toMatchObject({ isError: false });
    } finally { await fresh.server.close(); }
  } finally { await server.close(); }
});

it.each([
  ['tools/list', false], ['tools/call', false], ['tools/call', true],
] as const)('includes serverInfo in every successful %s result (isError=%s)', async (method, isError) => {
  const { server, transport } = await setup(isError);
  try {
    const result = await transport.request(request(method)) as JsonObject;
    expect(result._meta).toEqual({ [SERVER_INFO]: identity });
    expect(result.resultType).toBe('complete');
    if (method === 'tools/call') expect(result.isError).toBe(isError);
    else expect(result).toMatchObject({ ttlMs: 0, cacheScope: 'private' });
  } finally { await server.close(); }
});

it('does not retain client identity or caller mutations between results', async () => {
  const { server, transport } = await setup();
  try {
    const first = await transport.request(request('server/discover')) as JsonObject;
    ((first._meta as JsonObject)[SERVER_INFO] as JsonObject).name = 'mutated';
    (first.capabilities as JsonObject).resources = {};
    const second = await transport.request(request('server/discover', false)) as JsonObject;
    expect(second._meta).toEqual({ [SERVER_INFO]: identity });
    expect(second.capabilities).toEqual({ tools: {} });
  } finally { await server.close(); }
});

it.each(['tools/list', 'tools/call'].flatMap((method) =>
  [undefined, 'wrong', '2025-11-25'].map((version) => ({ method, version }))))(
  'still refuses protocolVersion $version for $method without clientInfo', async ({ method, version }) => {
  const { server, transport } = await setup();
  try {
    const raw = request(method, false);
    if (version === undefined) delete (raw.params!._meta as JsonObject)[VERSION];
    else (raw.params!._meta as JsonObject)[VERSION] = version;
    await expect(transport.request(raw)).rejects.toMatchObject({ code: 'unsupported_protocol_version' });
  } finally { await server.close(); }
});

it.each(['tools/list', 'tools/call'])('still requires clientCapabilities for %s without clientInfo', async (method) => {
  const { server, transport } = await setup();
  try {
    const raw = request(method, false);
    delete (raw.params!._meta as JsonObject)[CAPABILITIES];
    await expect(transport.request(raw)).rejects.toMatchObject({ code: 'protocol_failure' });
  } finally { await server.close(); }
});

it.each([
  ['no params', undefined], ['empty params', {}], ['no _meta', { name: 'ignored' }],
  ['empty _meta', { _meta: {} }],
  ['older version', { _meta: { [VERSION]: '2025-11-25' } }],
  ['unknown version', { _meta: { [VERSION]: 'unknown' } }],
  ['no capabilities', { _meta: { [VERSION]: LATEST_PROTOCOL_VERSION } }],
] as const)('answers discovery before negotiation: %s', async (_name, params) => {
  const { server, transport } = await setup();
  try {
    const before = await transport.request(request('tools/list'));
    const probe: TransportRequest = { method: 'server/discover', ...(params === undefined ? {} : { params }) };
    expect(await transport.request(probe)).toEqual({
      supportedVersions: ['2026-07-28'], capabilities: { tools: {} },
      resultType: 'complete', ttlMs: 0, cacheScope: 'private', _meta: { [SERVER_INFO]: identity },
    });
    expect(await transport.request(request('tools/list'))).toEqual(before);
  } finally { await server.close(); }
});
