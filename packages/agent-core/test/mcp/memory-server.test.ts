import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync } from 'node:fs';

const DIST_ENTRY = join(process.cwd(), 'packages/agent-core/dist/mcp/memory-server.js');

describe('memory MCP server', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-mcp-'));
  });

  it.skipIf(!existsSync(DIST_ENTRY))('exposes memory_write/Read/Search/Delete tools', async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [DIST_ENTRY],
      env: { ...process.env, KIMI_MEMORY_BASE_DIR: dir },
    });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(transport);
    try {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toEqual(['memory_delete', 'memory_read', 'memory_search', 'memory_write']);
    } finally {
      await client.close();
    }
  });
});
