import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Client, KNOWN_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION,
  ToolDefinition as ClientToolDefinition, TrustPolicy,
} from '@particle-academy/prism-mcp';
import {
  Server, InMemoryTransport, ToolDefinition, ResultGuard, McpError,
  type JsonObject, type McpToolResult, type ServerOptions, type ToolHandler, type TransportRequest,
} from '../src/index.js';

const VERSION = 'io.modelcontextprotocol/protocolVersion';
const CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
const RESULT_META = { resultType: 'complete', _meta: {
  'io.modelcontextprotocol/serverInfo': { name: '@particle-academy/prism-mcp-server', version: '0.3.1' },
} };

function request(method = 'tools/list', params: JsonObject = {}, headers: Record<string, string> = {}): TransportRequest {
  return { method, params: { ...params, _meta: {
    [VERSION]: LATEST_PROTOCOL_VERSION, [CAPABILITIES]: {},
    [CLIENT_INFO]: { name: 'phase-one-test', version: '1' },
  } }, headers };
}

function definition(name = 'echo', schema: JsonObject = {}): ToolDefinition {
  return new ToolDefinition(name, 'Echo a value', schema, 'Echo', { readOnlyHint: true });
}

const echo: ToolHandler = (args) => ({ text: JSON.stringify(args), isError: false });

async function setup(options: Partial<Omit<ServerOptions, 'transport'>> = {}): Promise<{ server: Server; transport: InMemoryTransport }> {
  const transport = new InMemoryTransport();
  const server = new Server({ server: 'fixture', ...options, transport });
  await server.listen();
  return { server, transport };
}

afterEach(() => vi.useRealTimers());

describe('shared definitions and registration', () => {
  const corpus = JSON.parse(readFileSync(new URL('./fixtures/mcp-tool-digest.json', import.meta.url), 'utf8')) as {
    cases: { id: string; payload: JsonObject; digest: { ts: string; py: string; php: string } }[];
  };
  it('uses the sibling runtime class and the entire recorded corpus', () => {
    expect(ToolDefinition).toBe(ClientToolDefinition);
    expect(corpus.cases).toHaveLength(13);
  });
  it.each(corpus.cases)('preserves digest through real tools/list: $id', async ({ payload, digest }) => {
    const { server, transport } = await setup();
    const tool = ToolDefinition.fromPayload(payload);
    server.register(tool, echo);
    const reply = await transport.request(request()) as { tools: JsonObject[] };
    const roundTrip = ToolDefinition.fromPayload(JSON.parse(JSON.stringify(reply.tools[0])) as JsonObject);
    expect(roundTrip.digest()).toBe(tool.digest());
    expect(roundTrip.digest()).toBe(digest.ts);
    expect(roundTrip.digest()).toBe(digest.py);
    expect(roundTrip.digest()).toBe(digest.php);
    await server.close();
  });
  it('snapshots definitions and list replies instead of keeping mutable schema references', async () => {
    const { server, transport } = await setup();
    const tool = definition('echo', { properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } });
    const digest = tool.digest();
    server.register(tool, echo);
    tool.inputSchema.properties = { unsafe: { type: 'array', 'x-mcp-header': 'Region' } };
    const first = await transport.request(request()) as { tools: JsonObject[] };
    first.tools[0].description = 'mutated reply';
    const second = await transport.request(request()) as { tools: JsonObject[] };
    expect(ToolDefinition.fromPayload(second.tools[0]).digest()).toBe(digest);
    expect(await transport.request(request('tools/call', { name: 'echo' }, { 'Mcp-Param-region': 'east' })))
      .toEqual({ content: [{ type: 'text', text: '{"region":"east"}' }], isError: false, ...RESULT_META });
    await server.close();
  });
  it('refuses duplicate registration without replacing the original handler', async () => {
    const { server, transport } = await setup();
    server.register(definition(), () => ({ text: 'original', isError: false }));
    expect(() => server.register(definition(), echo)).toThrow(McpError);
    expect(await transport.request(request('tools/call', { name: 'echo' })))
      .toEqual({ content: [{ type: 'text', text: 'original' }], isError: false, ...RESULT_META });
    await server.close();
  });
  const illegal: JsonObject[] = [
    { properties: { value: { type: 'string', 'x-mcp-header': '' } } },
    { properties: { value: { type: 'string', 'x-mcp-header': 'bad\r\nheader' } } },
    { properties: { value: { type: 'number', 'x-mcp-header': 'value' } } },
    { properties: { value: { type: 'array', 'x-mcp-header': 'value' } } },
    { properties: { value: { type: 'object', 'x-mcp-header': 'value' } } },
    { properties: { a: { type: 'string', 'x-mcp-header': 'Dup' }, b: { type: 'boolean', 'x-mcp-header': 'dup' } } },
  ];
  it.each(illegal)('refuses illegal mirrored annotations and excludes the tool: %#', async (schema) => {
    const { server, transport } = await setup();
    const handler = vi.fn(echo);
    expect(() => server.register(definition('bad', schema), handler)).toThrow(
      expect.objectContaining({ code: 'mirrored_parameter_refused' }),
    );
    server.register(definition('valid'), echo);
    const reply = await transport.request(request()) as { tools: JsonObject[] };
    expect(reply.tools.map((tool) => tool.name)).toEqual(['valid']);
    await expect(transport.request(request('tools/call', { name: 'bad' })))
      .rejects.toMatchObject({ code: 'mirrored_parameter_refused' });
    expect(handler).not.toHaveBeenCalled();
    await server.close();
  });
});

describe('mirrored headers and the credential boundary', () => {
  it.each(['authorization', 'cookie'])('never exposes the real %s header, with or without a mirror', async (name) => {
    const { server, transport } = await setup();
    const token = `Bearer ${randomBytes(32).toString('hex')}`;
    const cookie = 'session=PRIVATE-COOKIE-FIXTURE';
    const handler = vi.fn(echo);
    server.register(definition('mirror', { properties: { value: { type: 'string', 'x-mcp-header': name } } }), handler);
    for (const mirrored of [false, true]) {
      const headers: Record<string, string> = { Authorization: token, Cookie: cookie, Origin: 'https://untrusted.example' };
      if (mirrored) headers[`mCp-PaRaM-${name.toUpperCase()}`] = 'public-mirrored-value';
      const reply = await transport.request(request('tools/call', { name: 'mirror' }, headers));
      const [args, context] = handler.mock.calls[handler.mock.calls.length - 1];
      expect(args).toEqual(mirrored ? { value: 'public-mirrored-value' } : {});
      expect(context).toEqual({ server: 'fixture', tool: 'mirror', headers: mirrored ? { [name]: 'public-mirrored-value' } : {} });
      for (const observed of [args, context, reply]) {
        expect(JSON.stringify(observed)).not.toContain(token);
        expect(JSON.stringify(observed)).not.toContain(cookie);
      }
    }
    await server.close();
  });
  it('resolves nested primitive values before gating without mutating caller arguments', async () => {
    const gate = vi.fn(() => true);
    const { server, transport } = await setup({ gate });
    server.register(definition('nested', { properties: { options: { type: 'object', properties: {
      region: { type: 'string', 'x-mcp-header': 'Region' },
      count: { type: 'integer', 'x-mcp-header': 'Count' },
      enabled: { type: 'boolean', 'x-mcp-header': 'Enabled' },
    } } } }), echo);
    const args = { other: 'untouched' };
    const reply = await transport.request(request('tools/call', { name: 'nested', arguments: args }, {
      'Mcp-Param-Region': 'east', 'MCP-PARAM-COUNT': '0', 'mcp-param-enabled': 'false',
    }));
    expect(gate).toHaveBeenCalledWith('fixture', 'nested', { other: 'untouched', options: { region: 'east', count: 0, enabled: false } });
    expect(args).toEqual({ other: 'untouched' });
    expect(reply).toEqual({ content: [{ type: 'text', text: '{"other":"untouched","options":{"region":"east","count":0,"enabled":false}}' }], isError: false, ...RESULT_META });
    await server.close();
  });
  it.each(['1.5', '01', '+1', '9007199254740992', 'false'])('rejects malformed mirrored integer %s', async (value) => {
    const { server, transport } = await setup();
    const handler = vi.fn(echo);
    server.register(definition('integer', { properties: { value: { type: 'integer', 'x-mcp-header': 'N' } } }), handler);
    await expect(transport.request(request('tools/call', { name: 'integer' }, { 'Mcp-Param-N': value })))
      .rejects.toMatchObject({ code: 'protocol_failure' });
    expect(handler).not.toHaveBeenCalled();
    await server.close();
  });
  it('rejects a body/header conflict and duplicate header casing before the gate', async () => {
    const gate = vi.fn(() => true);
    const { server, transport } = await setup({ gate });
    server.register(definition('mirror', { properties: { value: { type: 'string', 'x-mcp-header': 'V' } } }), echo);
    await expect(transport.request(request('tools/call', { name: 'mirror', arguments: { value: 'body' } }, { 'Mcp-Param-V': 'header' })))
      .rejects.toMatchObject({ code: 'protocol_failure' });
    await expect(transport.request(request('tools/call', { name: 'mirror' }, { 'Mcp-Param-V': 'one', 'mcp-param-v': 'two' })))
      .rejects.toMatchObject({ code: 'protocol_failure' });
    expect(gate).not.toHaveBeenCalled();
    await server.close();
  });
  it('keeps prototype-shaped schema properties as ordinary data', async () => {
    const { server, transport } = await setup();
    const schema = JSON.parse('{"properties":{"__proto__":{"properties":{"polluted":{"type":"string","x-mcp-header":"safe"}}}}}') as JsonObject;
    const handler = vi.fn(echo);
    server.register(definition('prototype', schema), handler);
    await transport.request(request('tools/call', { name: 'prototype' }, { 'Mcp-Param-safe': 'data' }));
    expect(handler.mock.calls[0][0]).toEqual(JSON.parse('{"__proto__":{"polluted":"data"}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await server.close();
  });
});

describe('handlers, gates, caps and protocol errors', () => {
  it('round-trips through the actual sibling client, including mirrored values and isError', async () => {
    const { server, transport } = await setup();
    const tool = definition('echo', { properties: { region: { type: 'string', 'x-mcp-header': 'region' } } });
    const result: McpToolResult = { text: 'exact-text', isError: true };
    server.register(tool, async (args, context) => {
      expect(args).toEqual({ region: 'west' });
      expect(context.headers).toEqual({ region: 'west' });
      return result;
    });
    const client = new Client({ server: 'fixture', transport: (raw) => transport.request(request(raw.method, raw.params, raw.headers)),
      trust: TrustPolicy.allowingEveryTool({ echo: tool.digest() }), guard: new ResultGuard({ frameProvenance: false }) });
    const [listed] = await client.listTools();
    expect(listed.digest()).toBe(tool.digest());
    expect(await client.callTool(listed, { region: 'west' })).toEqual(result);
    await server.close();
  });
  it('allows registered tools by default and a custom asynchronous gate refuses before execution', async () => {
    const { server, transport } = await setup({ gate: async () => false });
    const handler = vi.fn(echo);
    server.register(definition(), handler);
    await expect(transport.request(request('tools/call', { name: 'echo' }))).rejects.toMatchObject({ code: 'tool_denied' });
    expect(handler).not.toHaveBeenCalled();
    await server.close();
  });
  it.each([false, true])('caps default success/error results (%s) without truncation', async (isError) => {
    const { server, transport } = await setup();
    server.register(definition(), () => ({ text: 'x'.repeat(65537), isError }));
    await expect(transport.request(request('tools/call', { name: 'echo' }))).rejects.toMatchObject({ code: 'result_too_large' });
    await server.close();
  });
  it('counts UTF-8 bytes rather than characters', async () => {
    const { server, transport } = await setup({ guard: new ResultGuard({ maxBytes: 4, frameProvenance: false }) });
    server.register(definition(), (args) => ({ text: String(args.text), isError: false }));
    expect(await transport.request(request('tools/call', { name: 'echo', arguments: { text: '😀' } })))
      .toEqual({ content: [{ type: 'text', text: '😀' }], isError: false, ...RESULT_META });
    await expect(transport.request(request('tools/call', { name: 'echo', arguments: { text: '😀😀' } })))
      .rejects.toMatchObject({ code: 'result_too_large' });
    await server.close();
  });
  it.each(KNOWN_PROTOCOL_VERSIONS.filter((version) => version !== LATEST_PROTOCOL_VERSION))('refuses older protocol %s by name', async (version) => {
    const { server, transport } = await setup();
    const raw = request();
    (raw.params!._meta as JsonObject)[VERSION] = version;
    await expect(transport.request(raw)).rejects.toMatchObject({ code: 'unsupported_protocol_version', message: expect.stringContaining(version) });
    await expect(transport.request(raw)).rejects.toThrow(LATEST_PROTOCOL_VERSION);
    await server.close();
  });
  it('refuses missing metadata, malformed arguments, unknown methods and unknown tools', async () => {
    const { server, transport } = await setup();
    server.register(definition(), echo);
    // A request with no stateless metadata is the handshake protocol, served
    // since prism-mcp-server-ts#1, not refused. A stateless one still cannot
    // initialize: that revision has no handshake.
    await expect(transport.request({ method: 'tools/list' })).resolves.toMatchObject({ tools: [{ name: 'echo' }] });
    await expect(transport.request(request('initialize'))).rejects.toMatchObject({ code: 'protocol_failure' });
    await expect(transport.request(request('resources/list'))).rejects.toMatchObject({ code: 'protocol_failure' });
    await expect(transport.request(request('tools/call', { name: 'missing' }))).rejects.toMatchObject({ code: 'tool_call_failed' });
    await expect(transport.request(request('tools/call', { name: 'echo', arguments: [] }))).rejects.toMatchObject({ code: 'protocol_failure' });
    await server.close();
  });
  it.each([false, true])('maps handler errors without leaking diagnostic messages (%s)', async (shared) => {
    const { server, transport } = await setup();
    server.register(definition(), () => { throw shared ? new McpError('tool_denied', 'SECRET-DIAGNOSTIC') : new Error('SECRET-DIAGNOSTIC'); });
    await expect(transport.request(request('tools/call', { name: 'echo' })))
      .rejects.toMatchObject({ code: shared ? 'tool_denied' : 'tool_call_failed', message: 'The tool handler could not complete the request.' });
    await server.close();
  });
});

describe('in-memory lifecycle without a timeout', () => {
  it('reports no credential as null', async () => {
    const transport = new InMemoryTransport();
    const server = new Server({ server: 'fixture', transport });
    expect(await server.listen()).toEqual({ url: 'memory://prism-mcp-server', token: null });
    await server.close();
  });
  it('holds a request beyond Node defaults using a virtual clock and completes', async () => {
    vi.useFakeTimers();
    const { server, transport } = await setup();
    let finish!: (value: McpToolResult) => void;
    const started = vi.fn();
    server.register(definition('receive'), async () => {
      started();
      return new Promise<McpToolResult>((resolve) => { finish = resolve; });
    });
    const pending = transport.request(request('tools/call', { name: 'receive' }));
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(started).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    finish({ text: 'long-poll-complete', isError: false });
    expect(await pending).toEqual({ content: [{ type: 'text', text: 'long-poll-complete' }], isError: false, ...RESULT_META });
    await server.close();
  });
  it('closes with long-polls in flight and refuses later work', async () => {
    const { server, transport } = await setup();
    let finish!: (value: McpToolResult) => void;
    server.register(definition('receive'), () => new Promise((resolve) => { finish = resolve; }));
    const pending = transport.request(request('tools/call', { name: 'receive' }));
    const refused = expect(pending).rejects.toMatchObject({ code: 'protocol_failure' });
    await Promise.resolve(); await Promise.resolve();
    await server.close();
    await refused;
    await server.close();
    await expect(transport.request(request())).rejects.toMatchObject({ code: 'protocol_failure' });
    expect(() => server.register(definition('later'), echo)).toThrow(McpError);
    finish({ text: 'late handler completion', isError: false });
  });
});

/*
 * A NULL IS NOT AN OPTIONAL STRING (tynn, Genie 2, 2026-10-22). Claude Code validates tools/list strictly and dropped
 * the WHOLE server on one `title: null` -- "Invalid result for tools/list: path ["tools",17,"title"] ... expected
 * string, received null" -- so a single tool without a title hid every tool the server had. Claude Code 2.1.301 takes
 * the modern path; the classic path already omitted nulls (classic.test.ts pins that).
 */
describe('tools/list never sends a null field', () => {
  it('a tool with no title is listed WITHOUT a title, not with null', async () => {
    const { server, transport } = await setup();
    const untitled = new ToolDefinition('plain', 'No title.', { type: 'object' });
    expect(untitled.title).toBeNull();
    server.register(untitled, echo);
    server.register(definition('titled'), echo);

    const reply = await transport.request(request()) as { tools: JsonObject[] };
    const plain = reply.tools.find((tool) => tool.name === 'plain')!;
    expect(Object.hasOwn(plain, 'title')).toBe(false);
    for (const tool of reply.tools) {
      expect(Object.entries(tool).filter(([, value]) => value === null)).toEqual([]);
    }
    expect(reply.tools.find((tool) => tool.name === 'titled')?.title).toBe('Echo');
    await server.close();
  });

  it('and the pin a client computes from that entry is still the registered definition\'s', async () => {
    const { server, transport } = await setup();
    const untitled = new ToolDefinition('plain', 'No title.', { type: 'object' });
    server.register(untitled, echo);
    const reply = await transport.request(request()) as { tools: JsonObject[] };
    expect(ClientToolDefinition.fromPayload(JSON.parse(JSON.stringify(reply.tools[0])) as JsonObject).digest()).toBe(untitled.digest());
    await server.close();
  });
});
