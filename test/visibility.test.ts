import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@particle-academy/prism-mcp';
import { LoopbackHttpTransport, Server, ToolDefinition, type JsonObject, type ToolVisibility } from '../src/index.js';

/**
 * PER-REQUEST TOOL VISIBILITY (tynn, for the owner, 2026-10-19): "do not list tools an agent cannot use". One server
 * answers every agent, so a tool can be hidden per request, from the caller's headers. Hiding is not cosmetic: a hidden
 * tool's call is refused exactly as an unregistered one is, so a caller cannot even learn that it exists.
 */
const transports: LoopbackHttpTransport[] = [];
afterEach(async () => { await Promise.all(transports.map((t) => t.close())); transports.length = 0; });

async function setup(visible: ToolVisibility) {
  const transport = new LoopbackHttpTransport(); transports.push(transport);
  const server = new Server({ server: 'genie', transport });
  server.register(new ToolDefinition('lists', 'Everyone may.', {}), () => ({ text: 'lists', isError: false }));
  server.register(new ToolDefinition('createAgent', 'Only the default agent may.', {}),
    () => ({ text: 'created', isError: false }), { visible });
  const { url, token } = await server.listen();
  return { url, token: token as string };
}

const stateless = (method: string, params: JsonObject = {}): JsonObject => ({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: {
  'io.modelcontextprotocol/protocolVersion': LATEST_PROTOCOL_VERSION, 'io.modelcontextprotocol/clientCapabilities': {},
} } });
const classic = (method: string, params?: JsonObject): JsonObject => ({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });

function send(url: string, token: string, body: JsonObject, headers: http.OutgoingHttpHeaders = {}): Promise<JsonObject> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST', agent: false, headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: `Bearer ${token}`, ...headers,
    } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.once('end', () => resolve(JSON.parse(text) as JsonObject));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.end(data);
  });
}

const names = (reply: JsonObject) => ((reply.result as JsonObject).tools as JsonObject[]).map((tool) => tool.name);
const DEFAULT_AGENT = { 'x-genie-agent': 'default' };
const OTHER_AGENT = { 'x-genie-agent': 'helper' };
const onlyDefault: ToolVisibility = ({ headers }) => headers['x-genie-agent'] === 'default';

describe.each([['stateless', stateless], ['handshake', classic]] as const)('on the %s protocol', (_name, rpc) => {
  it('lists a tool only to the callers its predicate admits', async () => {
    const { url, token } = await setup(onlyDefault);
    expect(names(await send(url, token, rpc('tools/list'), DEFAULT_AGENT))).toEqual(['lists', 'createAgent']);
    expect(names(await send(url, token, rpc('tools/list'), OTHER_AGENT))).toEqual(['lists']);
  });

  it('refuses a hidden tool\'s call exactly as an unregistered one', async () => {
    const { url, token } = await setup(onlyDefault);
    const hidden = await send(url, token, rpc('tools/call', { name: 'createAgent' }), OTHER_AGENT);
    const unknown = await send(url, token, rpc('tools/call', { name: 'noSuchTool' }), OTHER_AGENT);
    expect(hidden.error).toEqual(unknown.error);
    expect(hidden.error).toMatchObject({ data: { code: 'tool_call_failed' } });
    expect((await send(url, token, rpc('tools/call', { name: 'createAgent' }), DEFAULT_AGENT)).result)
      .toMatchObject({ content: [{ type: 'text', text: 'created' }] });
  });
});

describe('the predicate', () => {
  it('a registration without one is listed and callable for every caller (the control)', async () => {
    const { url, token } = await setup(onlyDefault);
    for (const caller of [DEFAULT_AGENT, OTHER_AGENT]) {
      expect(names(await send(url, token, stateless('tools/list'), caller))).toContain('lists');
      expect((await send(url, token, stateless('tools/call', { name: 'lists' }), caller)).result).toBeDefined();
    }
  });

  it('may be async', async () => {
    const { url, token } = await setup(async ({ headers }) => headers['x-genie-agent'] === 'default');
    expect(names(await send(url, token, stateless('tools/list'), OTHER_AGENT))).toEqual(['lists']);
    expect(names(await send(url, token, stateless('tools/list'), DEFAULT_AGENT))).toEqual(['lists', 'createAgent']);
  });

  it('HIDES the tool when it throws, rejects, or answers anything but true: it fails closed', async () => {
    for (const predicate of [
      () => { throw new Error('registry unavailable'); },
      async () => { throw new Error('registry unavailable'); },
      () => 'yes' as unknown as boolean,
      () => 1 as unknown as boolean,
    ] as ToolVisibility[]) {
      const { url, token } = await setup(predicate);
      expect(names(await send(url, token, stateless('tools/list'), DEFAULT_AGENT))).toEqual(['lists']);
      expect((await send(url, token, stateless('tools/call', { name: 'createAgent' }), DEFAULT_AGENT)).error)
        .toMatchObject({ data: { code: 'tool_call_failed' } });
    }
  });

  it('never sees the caller\'s credentials', async () => {
    let seen: Record<string, string> = {};
    const { url, token } = await setup(({ headers }) => { seen = headers; return true; });
    await send(url, token, stateless('tools/list'), { ...DEFAULT_AGENT, Cookie: 'session=secret' });
    expect(seen['x-genie-agent']).toBe('default');
    expect(seen).not.toHaveProperty('authorization');
    expect(seen).not.toHaveProperty('cookie');
  });
});
