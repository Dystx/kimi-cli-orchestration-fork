import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { MemoryStore } from '../session/memory-store';

/**
 * Start a stdio MCP server exposing memory_write/Read/Search/Delete over the
 * provided MemoryStore. The store is constructed from the
 * `KIMI_MEMORY_BASE_DIR` env var (defaults to `process.cwd()`).
 */
export async function startMemoryMcpServer(): Promise<void> {
  const baseDir = process.env['KIMI_MEMORY_BASE_DIR'] ?? process.cwd();
  const store = new MemoryStore(baseDir);

  const server = new McpServer({ name: 'kimi-memory', version: '0.1.0' });

  server.tool(
    'memory_write',
    'Persist a fact, insight, decision, preference, or snippet to cross-session memory.',
    {
      content: z.string().min(1),
      tags: z.array(z.string()).optional(),
      type: z.enum(['fact', 'insight', 'decision', 'preference', 'snippet']).optional(),
    },
    async ({ content, tags, type }) => {
      const memory = await store.write({ content, tags, type });
      return { content: [{ type: 'text', text: `id: ${memory.id}` }] };
    },
  );

  server.tool(
    'memory_read',
    'Fetch a single memory entry by id.',
    { id: z.string().min(1) },
    async ({ id }) => {
      const entry = await store.read(id);
      if (entry === undefined) {
        return { content: [{ type: 'text', text: `No memory found for id ${id}` }] };
      }
      return { content: [{ type: 'text', text: entry.content }] };
    },
  );

  server.tool(
    'memory_search',
    'Search memory by query and optional tag filter.',
    {
      query: z.string(),
      tags: z.array(z.string()).optional(),
      limit: z.number().int().positive().max(50).optional(),
    },
    async ({ query, tags, limit }) => {
      const results = await store.search(query, { tags, limit });
      const text = results
        .map((entry) => `${entry.id}\t${entry.tags.join(',')}\t${entry.content}`)
        .join('\n');
      return { content: [{ type: 'text', text: text.length === 0 ? 'No matching memories.' : text }] };
    },
  );

  server.tool(
    'memory_delete',
    'Delete a memory entry by id.',
    { id: z.string().min(1) },
    async ({ id }) => {
      const ok = await store.delete(id);
      return { content: [{ type: 'text', text: ok ? `deleted ${id}` : `not found ${id}` }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// CLI entrypoint: `node packages/agent-core/dist/mcp/memory-server.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  startMemoryMcpServer().catch((error: unknown) => {
    process.stderr.write(`memory-server failed: ${String(error)}\n`);
    process.exit(1);
  });
}
