import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@particle-academy/prism-mcp';
import { InMemoryTransport, Server } from '../src/index.js';

const { name, version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };

it.each(['classic', 'stateless'])('advertises the package version to %s clients', async protocol => {
  const transport = new InMemoryTransport();
  const server = new Server({ server: 'version-fixture', transport });
  await server.listen();
  try {
    if (protocol === 'classic') {
      const result = await transport.request({ method: 'initialize', params: {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'version-test', version: '1' },
      } });
      expect(result).toMatchObject({ serverInfo: { name, version } });
    } else {
      const result = await transport.request({ method: 'tools/list', params: { _meta: {
        'io.modelcontextprotocol/protocolVersion': LATEST_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
      } } });
      expect(result).toMatchObject({ _meta: { 'io.modelcontextprotocol/serverInfo': { name, version } } });
    }
  } finally {
    await server.close();
  }
});
