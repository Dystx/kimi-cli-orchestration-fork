/**
 * MiniMaxWebSearchProvider — host-side `WebSearchProvider`.
 *
 * Wraps the `mavis mcp call matrix matrix_web_search` CLI so that the
 * MiniMax daemon injects the matrix session token on the kimi-code side.
 * The kimi-code process itself never sees a token — it just spawns
 * `mavis`, the daemon opens the matrix CLI with `MATRIX_TOKEN` set, and
 * the call returns the JSON the provider normalises to `WebSearchResult[]`.
 *
 * Result schema (from the matrix CLI):
 *   { results: [{ title, link, snippet, source?, date?, content? }], total }
 *
 * The provider is intentionally minimal — it spawns one process per call
 * because the matrix CLI is a stateful MCP client (it maintains an
 * authenticated connection to the biz-gateway). Caching the spawned
 * process across calls would require speaking stdio MCP ourselves; the
 * round-trip is already fast enough (~hundreds of ms in tests) for the
 * kimi-code search tool's expected usage.
 */

import { spawn } from 'node:child_process';

import type { WebSearchProvider, WebSearchResult } from '../builtin';
import { parseFirstJson } from './parse-first-json';

export interface MiniMaxWebSearchProviderOptions {
  /**
   * Absolute path to the `mavis` binary that can run `mcp call <server>
   * <tool>`. Defaults to the standard install location on macOS; override
   * for testing or non-macOS hosts.
   */
  cliPath?: string;
  /** MCP server name (default: `matrix`). */
  mcpServer?: string;
  /** MCP tool name (default: `matrix_web_search`). */
  mcpTool?: string;
  /** Per-call subprocess timeout in milliseconds (default: 30s). */
  timeoutMs?: number;
  /** Custom spawn implementation (used by tests to stub the CLI). */
  spawnImpl?: (
    file: string,
    args: readonly string[],
    options: import('node:child_process').SpawnOptions,
  ) => Pick<import('node:child_process').ChildProcess, 'stdout' | 'stderr' | 'exitCode'> & {
    on(event: 'exit', listener: (code: number | null) => void): unknown;
    on(event: 'error', listener: (err: Error) => void): unknown;
    once(event: 'exit', listener: (code: number | null) => void): unknown;
    once(event: 'error', listener: (err: Error) => void): unknown;
  };
}

interface MiniMaxSearchResult {
  title?: string;
  link?: string;
  url?: string;
  snippet?: string;
  content?: string;
  date?: string;
  source?: string;
}

interface MiniMaxSearchResponse {
  results?: MiniMaxSearchResult[];
  total?: number;
  code?: number;
  message?: string;
}

const DEFAULT_CLI_PATH = '/Users/cheng/.mavis/bin/mavis';
const DEFAULT_MCP_SERVER = 'matrix';
const DEFAULT_MCP_TOOL = 'matrix_web_search';
const DEFAULT_TIMEOUT_MS = 30_000;

export class MiniMaxWebSearchProvider implements WebSearchProvider {
  private readonly cliPath: string;
  private readonly mcpServer: string;
  private readonly mcpTool: string;
  private readonly timeoutMs: number;
  private readonly spawnImpl: NonNullable<MiniMaxWebSearchProviderOptions['spawnImpl']>;

  constructor(options: MiniMaxWebSearchProviderOptions = {}) {
    this.cliPath = options.cliPath ?? DEFAULT_CLI_PATH;
    this.mcpServer = options.mcpServer ?? DEFAULT_MCP_SERVER;
    this.mcpTool = options.mcpTool ?? DEFAULT_MCP_TOOL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  async search(
    query: string,
    options?: { limit?: number; includeContent?: boolean; toolCallId?: string },
  ): Promise<WebSearchResult[]> {
    const args: Record<string, unknown> = {
      query,
      count: options?.limit ?? 5,
      timeout_seconds: Math.max(1, Math.round(this.timeoutMs / 1000)),
    };
    if (options?.includeContent === true) {
      args['include_content'] = true;
    }
    if (options?.toolCallId !== undefined && options.toolCallId.length > 0) {
      // Pass through as an opaque hint; the CLI ignores unknown args
      // beyond the schema. We don't fail on it being unsupported.
      args['tool_call_id'] = options.toolCallId;
    }

    const child = this.spawnImpl(
      this.cliPath,
      ['mcp', 'call', this.mcpServer, this.mcpTool, JSON.stringify(args)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    // `stdio` is `['ignore', 'pipe', 'pipe']`, so stdout and stderr are
    // guaranteed to be Readable streams by the Node typings.
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      throw new Error('MiniMax search spawn did not produce piped stdio streams.');
    }

    const [stdoutText, stderrText, exitCode] = await Promise.all([
      collect(stdout, this.timeoutMs),
      collect(stderr, this.timeoutMs),
      waitExit(child),
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `MiniMax search failed: ${this.cliPath} exited with code ${String(exitCode)}. stderr: ${stderrText.trim() || '<empty>'}`,
      );
    }

    // The matrix CLI sometimes appends a `[matrix-mcp-cli:hint]` block or
    // other trailing text after the JSON object. Parse only the first
    // top-level JSON value so the hint doesn't poison the parse.
    const parsed = parseFirstJson<MiniMaxSearchResponse>(stdoutText);
    if (parsed === undefined) {
      throw new Error(
        `MiniMax search returned non-JSON output. stderr: ${stderrText.trim() || '<empty>'}. stdout (first 500 chars): ${stdoutText.slice(0, 500)}`,
      );
    }

    if (typeof parsed.code === 'number' && parsed.code !== 0) {
      throw new Error(
        `MiniMax search error (code=${parsed.code}): ${parsed.message ?? 'unknown error'}`,
      );
    }

    const raw = Array.isArray(parsed.results) ? parsed.results : [];
    return raw.map((r): WebSearchResult => {
      const out: WebSearchResult = {
        title: r.title ?? '',
        url: r.link ?? r.url ?? '',
        snippet: r.snippet ?? '',
      };
      if (typeof r.date === 'string' && r.date.length > 0) out.date = r.date;
      if (typeof r.content === 'string' && r.content.length > 0) out.content = r.content;
      return out;
    });
  }
}

function waitExit(child: {
  exitCode: number | null;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
}): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once('exit', (code) => { resolve(code); });
    child.once('error', () => { resolve(null); });
  });
}

async function collect(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stream.removeAllListeners('data');
      stream.removeAllListeners('end');
      stream.removeAllListeners('error');
      reject(new Error(`MiniMax search stream timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    stream.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    stream.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}
