import { fileURLToPath } from 'node:url';
import { dirname, join } from 'pathe';
import type { McpServerConfig } from '../config/schema';

/**
 * Returns an `McpServerConfig` for the bundled memory MCP server, pointing
 * at the compiled JS entry that ships with `@moonshot-ai/agent-core`.
 *
 * The MCP server is opt-in: callers should add it to `SessionMcpConfig.servers`
 * only when they want external MCP clients to share the agent-core memory
 * store. When the package is consumed from source (tsx/vitest), `distPath`
 * falls back to the source file so dev workflows still work.
 */
export function createMemoryMcpServerConfig(): McpServerConfig {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist: .../dist/mcp/builtin-servers.js → .../dist/mcp/memory-server.js
  const distEntry = join(here, 'memory-server.js');
  return {
    transport: 'stdio',
    command: 'node',
    args: [distEntry],
  };
}
