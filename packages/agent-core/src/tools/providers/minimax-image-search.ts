/**
 * MiniMaxImageSearchProvider — host-side `ImageSearchProvider`.
 *
 * Wraps `mavis mcp call matrix matrix_search_images` to search the web for
 * images by query. Auth is handled by the mavis daemon via the matrix MCP
 * session, so the kimi-code process never sees a token.
 *
 * Request shape (sent as the CLI's JSON arg):
 *   { queries: [{ query, prompt, task_name }], providers?: ["serper"]? }
 *
 * Response shape (after `parseFirstJson`):
 *   {
 *     code, message,
 *     results: [
 *       { query, images: [{ title, image_url, source?, link? }], error? }
 *     ]
 *   }
 *
 * Per-task errors (an entry with `error` instead of `images`) are skipped
 * silently — we return only the successful task's images.
 */

import { spawn } from 'node:child_process';

import type { ImageSearchProvider, ImageSearchResult } from '../builtin';
import { parseFirstJson } from './parse-first-json';

export interface MiniMaxImageSearchProviderOptions {
  /** Override the `mavis` CLI path. Default: standard install. */
  cliPath?: string;
  /** MCP server name (default: `matrix`). */
  mcpServer?: string;
  /** MCP tool name (default: `matrix_search_images`). */
  mcpTool?: string;
  /** Per-call subprocess timeout in milliseconds (default: 30s). */
  timeoutMs?: number;
  /** Test seam — substitute for `child_process.spawn`. */
  spawnImpl?: MiniMaxWebSearchSpawnImpl;
}

interface MiniMaxImage {
  title?: string;
  image_url?: string;
  url?: string;
  source?: string;
  link?: string;
}

interface MiniMaxImageTask {
  query?: string;
  images?: MiniMaxImage[];
  error?: unknown;
}

interface MiniMaxImageResponse {
  code?: number;
  message?: string;
  results?: MiniMaxImageTask[];
}

const DEFAULT_CLI_PATH = '/Users/cheng/.mavis/bin/mavis';
const DEFAULT_MCP_SERVER = 'matrix';
const DEFAULT_MCP_TOOL = 'matrix_search_images';
const DEFAULT_TIMEOUT_MS = 30_000;

export class MiniMaxImageSearchProvider implements ImageSearchProvider {
  private readonly cliPath: string;
  private readonly mcpServer: string;
  private readonly mcpTool: string;
  private readonly timeoutMs: number;
  private readonly spawnImpl: NonNullable<MiniMaxImageSearchProviderOptions['spawnImpl']>;

  constructor(options: MiniMaxImageSearchProviderOptions = {}) {
    this.cliPath = options.cliPath ?? DEFAULT_CLI_PATH;
    this.mcpServer = options.mcpServer ?? DEFAULT_MCP_SERVER;
    this.mcpTool = options.mcpTool ?? DEFAULT_MCP_TOOL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  async search(
    query: string,
    options?: { limit?: number; prompt?: string; toolCallId?: string },
  ): Promise<ImageSearchResult[]> {
    // The matrix MCP image search takes a relevance-filter `prompt`; if the
    // caller didn't supply one, fall back to the query itself so the filter
    // is still useful.
    const prompt = options?.prompt && options.prompt.length > 0 ? options.prompt : query;

    const args: Record<string, unknown> = {
      queries: [
        {
          query,
          prompt,
          task_name: 'kimi-code-image-search',
        },
      ],
      timeout_seconds: Math.max(1, Math.round(this.timeoutMs / 1000)),
    };
    if (options?.toolCallId !== undefined && options.toolCallId.length > 0) {
      args['tool_call_id'] = options.toolCallId;
    }

    const child = this.spawnImpl(
      this.cliPath,
      ['mcp', 'call', this.mcpServer, this.mcpTool, JSON.stringify(args)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      throw new Error('MiniMax image search spawn did not produce piped stdio streams.');
    }

    const [stdoutText, stderrText, exitCode] = await Promise.all([
      collect(stdout, this.timeoutMs),
      collect(stderr, this.timeoutMs),
      waitExit(child),
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `MiniMax image search failed: ${this.cliPath} exited with code ${String(exitCode)}. stderr: ${stderrText.trim() || '<empty>'}`,
      );
    }

    const parsed = parseFirstJson<MiniMaxImageResponse>(stdoutText);
    if (parsed === undefined) {
      throw new Error(
        `MiniMax image search returned non-JSON output. stderr: ${stderrText.trim() || '<empty>'}. stdout (first 500 chars): ${stdoutText.slice(0, 500)}`,
      );
    }

    if (typeof parsed.code === 'number' && parsed.code !== 0) {
      throw new Error(
        `MiniMax image search error (code=${parsed.code}): ${parsed.message ?? 'unknown error'}`,
      );
    }

    const tasks = Array.isArray(parsed.results) ? parsed.results : [];
    const collected: ImageSearchResult[] = [];
    for (const task of tasks) {
      if (!Array.isArray(task.images)) continue;
      for (const img of task.images) {
        const url = img.image_url ?? img.url ?? '';
        if (url.length === 0) continue;
        const out: ImageSearchResult = {
          title: img.title ?? '',
          imageUrl: url,
        };
        if (typeof img.source === 'string' && img.source.length > 0) out.source = img.source;
        if (typeof img.link === 'string' && img.link.length > 0) out.link = img.link;
        collected.push(out);
        if (options?.limit !== undefined && collected.length >= options.limit) {
          return collected;
        }
      }
    }
    return collected;
  }
}

type MiniMaxWebSearchSpawnImpl = (
  file: string,
  args: readonly string[],
  options: import('node:child_process').SpawnOptions,
) => Pick<import('node:child_process').ChildProcess, 'stdout' | 'stderr' | 'exitCode'> & {
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
};

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
      reject(new Error(`MiniMax image search stream timed out after ${timeoutMs} ms.`));
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
