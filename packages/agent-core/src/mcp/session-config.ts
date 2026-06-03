import type { McpServerConfig } from '#/config/schema';

import { loadMcpServers, readMcpJson } from './config-loader';

export interface SessionMcpConfig {
  readonly servers: Record<string, McpServerConfig>;
}

export interface ResolveSessionMcpConfigInput {
  readonly cwd: string;
  readonly homeDir?: string;
  readonly customConfigFile?: string;
}

/**
 * Load MCP server declarations from the user-global `~/.kimi-code/mcp.json`,
 * the project-root `<project root>/.mcp.json`, and the project-local
 * `<cwd>/.kimi-code/mcp.json`. Entries in later files override earlier files
 * with the same key, so a repo can specialise or replace a shared definition,
 * and Kimi-specific project config wins over the Claude-compatible root file.
 *
 * If `customConfigFile` is provided, it is loaded and merged on top with the
 * highest precedence.
 *
 * Note: project-local entries may spawn stdio commands at session start, so
 * opening a session inside an untrusted checkout will execute whatever its
 * `mcp.json` declares. Only enable this in repos you trust.
 */
export async function resolveSessionMcpConfig(
  input: ResolveSessionMcpConfigInput,
): Promise<SessionMcpConfig | undefined> {
  const servers = await loadMcpServers({
    cwd: input.cwd,
    homeDir: input.homeDir,
  });
  if (input.customConfigFile !== undefined) {
    const custom = await readMcpJson(input.customConfigFile);
    Object.assign(servers, custom);
  }
  if (Object.keys(servers).length === 0) return undefined;
  return { servers };
}

export function mergeCallerMcpServers(
  base: SessionMcpConfig | undefined,
  callerServers: Readonly<Record<string, McpServerConfig>> | undefined,
): SessionMcpConfig | undefined {
  if (callerServers === undefined || Object.keys(callerServers).length === 0) {
    return base;
  }
  return {
    servers: {
      ...base?.servers,
      ...callerServers,
    },
  };
}
