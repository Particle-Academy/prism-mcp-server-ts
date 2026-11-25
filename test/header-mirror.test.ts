import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeaderMismatchError, InMemoryTransport, LoopbackHttpTransport, Server, ToolDefinition, type JsonObject, type JsonValue } from '../src/index.js';

/*
 * The shared header-mirroring corpus, run through the real loopback server on a raw socket so every header reaches
 * the server exactly as the row spells it: casing, repeats, padding and non-ASCII bytes included. The Python server
 * runs the same file; both pin its SHA-256 so a row cannot change in one language only.
 */
const CORPUS_FILE = new URL('./fixtures/mcp-header-mirror.json', import.meta.url);
const CORPUS_SHA256 = 'cdacbf274bf31c03ef7078c66105bbb9c069c19ac2fd97cc76f832ebb3abb961';

interface Row {
  id: string; title: string; revision: string; tool: string; standard: boolean;
  arguments?: JsonObject; headers: [string, string][];
  expect: { outcome: 'served'; arguments: JsonObject; headers: Record<string, string> }
    | { outcome: 'refused'; message: string } | { outcome: 'unregistered' };
}
interface Corpus { tools: { name: string; inputSchema: JsonObject }[]; cases: Row[] }

const raw = readFileSync(CORPUS_FILE);
const corpus = JSON.parse(raw.toString('utf8')) as Corpus;
const STATELESS = '2026-07-28';

const transports: LoopbackHttpTransport[] = [];
afterEach(async () => { await Promise.all(transports.map((transport) => transport.close())); transports.length = 0; });

async function setup() {
  const transport = new LoopbackHttpTransport(); transports.push(transport);
  const gate = vi.fn(() => true);
  const server = new Server({ server: 'fixture', transport, gate });
  const handler = vi.fn((args: JsonObject, context: { headers: Record<string, string> }) => {
    void args; void context; return { text: 'ok', isError: false };
  });
  for (const tool of corpus.tools) server.register(new ToolDefinition(tool.name, '', tool.inputSchema), handler);
  const endpoint = await server.listen();
  return { url: new URL(endpoint.url), token: endpoint.token as string, gate, handler };
}

function body(row: Row): JsonObject {
  const params: JsonObject = { name: row.tool };
  if (row.arguments !== undefined) params.arguments = row.arguments;
  if (row.revision === STATELESS) {
    params._meta = {
      'io.modelcontextprotocol/protocolVersion': STATELESS,
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'header-mirror-corpus', version: '1' },
    };
  }
  return { jsonrpc: '2.0', id: row.id, method: 'tools/call', params };
}

function standard(row: Row): [string, string][] {
  if (!row.standard) return [];
  if (row.revision === STATELESS) return [['MCP-Protocol-Version', STATELESS], ['Mcp-Method', 'tools/call'], ['Mcp-Name', row.tool]];
  return row.revision >= '2025-06-18' ? [['MCP-Protocol-Version', row.revision]] : [];
}

/** One HTTP/1.1 POST written byte for byte; Node's own client would refuse or normalise the hostile rows. */
function post(url: URL, token: string, headers: [string, string][], payload: JsonObject): Promise<{ status: number; body: JsonObject }> {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = [`POST ${url.pathname} HTTP/1.1`, `Host: ${url.host}`, `Authorization: Bearer ${token}`,
    'Content-Type: application/json', 'Accept: application/json', `Content-Length: ${data.length}`, 'Connection: close',
    ...headers.map(([name, value]) => `${name}: ${value}`)].join('\r\n');
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname);
    const chunks: Buffer[] = [];
    socket.setTimeout(3000, () => socket.destroy(new Error('Corpus request exceeded deadline.')));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]);
      const rest = split < 0 ? '' : text.slice(split + 4);
      resolve({ status, body: rest ? JSON.parse(rest) as JsonObject : {} });
    });
    socket.write(Buffer.concat([Buffer.from(`${head}\r\n\r\n`, 'utf8'), data]));
  });
}

describe('the shared header-mirroring corpus', () => {
  it('is the exact file the Python server runs', () => {
    // Line endings are normalised, so a checkout that converts them still compares the content.
    const text = raw.toString('utf8').replaceAll('\r\n', '\n');
    expect(crypto.createHash('sha256').update(text, 'utf8').digest('hex')).toBe(CORPUS_SHA256);
    expect(new Set(corpus.cases.map((row) => row.id)).size).toBe(corpus.cases.length);
  });

  it.each(corpus.cases.map((row) => [row.id, row.title, row] as const))('%s %s', async (_id, _title, row) => {
    const { url, token, gate, handler } = await setup();
    const reply = await post(url, token, [...standard(row), ...row.headers], body(row));
    const expected = row.expect;
    if (expected.outcome === 'served') {
      expect(reply.status).toBe(200);
      expect(reply.body.error).toBeUndefined();
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0]).toEqual(expected.arguments);
      expect(handler.mock.calls[0][1].headers).toEqual(expected.headers);
      return;
    }
    expect(handler).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
    if (expected.outcome === 'refused') {
      expect(reply.status).toBe(400);
      expect(reply.body).toEqual({ jsonrpc: '2.0', id: row.id, error: { code: -32020, message: expected.message } } satisfies JsonValue);
    } else {
      expect(reply.status).toBe(200);
      expect(reply.body.error).toMatchObject({ code: -32000, data: { code: 'tool_call_failed' } });
    }
  });
});

describe('header checks outside the corpus', () => {
  it('refuses a mismatch with 400 before a streamed tools/call opens its event stream', async () => {
    const { url, token, gate, handler } = await setup();
    const row = corpus.cases.find((entry) => entry.id === 'hdr-0103')!;
    const data = Buffer.from(JSON.stringify(body(row)), 'utf8');
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(Number(url.port), url.hostname);
      const chunks: Buffer[] = [];
      socket.setTimeout(3000, () => socket.destroy(new Error('Stream request exceeded deadline.')));
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.once('error', reject);
      socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.write(Buffer.concat([Buffer.from([`POST ${url.pathname} HTTP/1.1`, `Host: ${url.host}`, `Authorization: Bearer ${token}`,
        'Content-Type: application/json', 'Accept: text/event-stream', `Content-Length: ${data.length}`, 'Connection: close',
        ...[...standard(row), ...row.headers].map(([name, value]) => `${name}: ${value}`)].join('\r\n') + '\r\n\r\n', 'utf8'), data]));
    });
    expect(reply.startsWith('HTTP/1.1 400 ')).toBe(true);
    expect(reply).not.toContain('text/event-stream');
    expect(JSON.parse(reply.slice(reply.indexOf('\r\n\r\n') + 4))).toEqual({ jsonrpc: '2.0', id: row.id,
      error: { code: -32020, message: 'Header mismatch: the [Mcp-Param-Region] header does not match the request body.' } });
    expect(gate).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('in process: requires no header, but checks every header a request does carry', async () => {
    const transport = new InMemoryTransport();
    const handler = vi.fn((args: JsonObject) => ({ text: JSON.stringify(args), isError: false }));
    const server = new Server({ server: 'fixture', transport });
    server.register(new ToolDefinition('route', '', corpus.tools[0].inputSchema), handler);
    await server.listen();
    const call = (args: JsonObject, headers: Record<string, string>) => transport.request({ method: 'tools/call',
      params: { name: 'route', arguments: args, _meta: { 'io.modelcontextprotocol/protocolVersion': STATELESS,
        'io.modelcontextprotocol/clientCapabilities': {} } }, headers });
    await expect(call({ region: 'us-west1' }, {})).resolves.toMatchObject({ isError: false });
    await expect(call({}, { 'Mcp-Param-Region': 'us-west1' })).rejects.toBeInstanceOf(HeaderMismatchError);
    await expect(call({ region: 'us-west1' }, { 'Mcp-Param-Region': 'eu-west1' })).rejects.toBeInstanceOf(HeaderMismatchError);
    await expect(call({ region: 'us-west1' }, { 'Mcp-Param-Region': 'us-west1', 'mcp-param-region': 'us-west1' }))
      .rejects.toMatchObject({ message: 'Header mismatch: a header that mirrors the request body is repeated.' });
    expect(handler).toHaveBeenCalledOnce();
    await server.close();
  });

  it('refuses a hidden tool as unknown, whatever its headers say', async () => {
    const transport = new LoopbackHttpTransport(); transports.push(transport);
    const handler = vi.fn(() => ({ text: 'ok', isError: false }));
    const server = new Server({ server: 'fixture', transport });
    server.register(new ToolDefinition('route', '', corpus.tools[0].inputSchema), handler, { visible: () => false });
    const endpoint = await server.listen();
    const row = corpus.cases.find((entry) => entry.id === 'hdr-0103')!;
    const reply = await post(new URL(endpoint.url), endpoint.token as string, [...standard(row), ...row.headers], body(row));
    expect(reply.status).toBe(200);
    expect(reply.body.error).toMatchObject({ code: -32000, data: { code: 'tool_call_failed' } });
    expect(handler).not.toHaveBeenCalled();
  });
});
