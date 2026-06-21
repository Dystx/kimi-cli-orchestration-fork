/**
 * Covers: MiniMaxWebSearchProvider.
 *
 * The provider spawns `mavis mcp call matrix matrix_web_search` and parses
 * the JSON stdout. We stub `spawnImpl` so the test never touches the real
 * CLI or daemon.
 */

import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MiniMaxWebSearchProvider } from '../../src/tools/providers/minimax-web-search';
import type { WebSearchProvider } from '../../src/tools/builtin';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

interface SpawnedCall {
  file: string;
  args: readonly string[];
  options: unknown;
}

interface FakeChild extends EventEmitter {
  exitCode: number | null;
  stdout: Readable;
  stderr: Readable;
}

interface FakeSpawnResult {
  calls: SpawnedCall[];
  /** Returns a child whose stdout/stderr are pre-fed with `stdout` / `stderr`. */
  spawn: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

function makeFakeSpawn(stdoutText: string, stderrText: string, exitCode = 0): FakeSpawnResult {
  const calls: SpawnedCall[] = [];
  const spawn: FakeSpawnResult['spawn'] = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter() as FakeChild;
    child.exitCode = null;
    child.stdout = Readable.from([Buffer.from(stdoutText, 'utf8')]);
    child.stderr = Readable.from([Buffer.from(stderrText, 'utf8')]);
    queueMicrotask(() => {
      child.exitCode = exitCode;
      child.emit('exit', exitCode);
    });
    // The provider only touches stdout, stderr, exitCode, and emits on
    // 'exit' / 'error' — narrow-cast for the type contract.
    return child as unknown as ChildProcess;
  };
  return { calls, spawn };
}

describe('MiniMaxWebSearchProvider', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns the mavis CLI with the matrix web_search tool and parses results', async () => {
    const fake = makeFakeSpawn(
      JSON.stringify({
        code: 0,
        message: 'ok',
        results: [
          { title: 'Result A', link: 'https://a.test', snippet: 'snip A', source: 'SiteA' },
          { title: 'Result B', link: 'https://b.test', snippet: 'snip B', date: '2025-04-01' },
        ],
      }),
      '',
    );
    const provider = new MiniMaxWebSearchProvider({
      cliPath: '/usr/local/bin/mavis',
      spawnImpl: fake.spawn,
    });
    const results = await provider.search('hello', { limit: 2 });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.file).toBe('/usr/local/bin/mavis');
    expect(fake.calls[0]!.args.slice(0, 4)).toEqual(['mcp', 'call', 'matrix', 'matrix_web_search']);

    const toolArgs = JSON.parse(fake.calls[0]!.args[4]!);
    expect(toolArgs).toMatchObject({ query: 'hello', count: 2 });
    expect(toolArgs.timeout_seconds).toBe(30);

    expect(results).toEqual([
      { title: 'Result A', url: 'https://a.test', snippet: 'snip A' },
      { title: 'Result B', url: 'https://b.test', snippet: 'snip B', date: '2025-04-01' },
    ]);
  });

  it('falls back to the url field when link is missing', async () => {
    const fake = makeFakeSpawn(
      JSON.stringify({
        code: 0,
        results: [{ title: 'NoLink', url: 'https://nolink.test', snippet: 's' }],
      }),
      '',
    );
    const provider = new MiniMaxWebSearchProvider({ spawnImpl: fake.spawn });
    const results = await provider.search('hi');
    expect(results[0]!.url).toBe('https://nolink.test');
  });

  it('includes `include_content` and `tool_call_id` in tool args when set', async () => {
    const fake = makeFakeSpawn(JSON.stringify({ code: 0, results: [] }), '');
    const provider = new MiniMaxWebSearchProvider({ spawnImpl: fake.spawn });
    await provider.search('hi', { includeContent: true, toolCallId: 'tc-9' });
    const args = JSON.parse(fake.calls[0]!.args[4]!);
    expect(args.include_content).toBe(true);
    expect(args.tool_call_id).toBe('tc-9');
  });

  it('returns an empty array when the daemon reports zero results', async () => {
    const fake = makeFakeSpawn(JSON.stringify({ code: 0, results: [] }), '');
    const provider = new MiniMaxWebSearchProvider({ spawnImpl: fake.spawn });
    const results = await provider.search('nothing-here');
    expect(results).toEqual([]);
  });

  it('throws when the CLI exits non-zero', async () => {
    const fake = makeFakeSpawn('', 'mavis: not found', 1);
    const provider = new MiniMaxWebSearchProvider({ spawnImpl: fake.spawn });
    await expect(provider.search('hi')).rejects.toThrow(/exited with code 1.*mavis: not found/);
  });

  it('throws when the daemon returns a non-zero `code` in the response', async () => {
    const fake = makeFakeSpawn(
      JSON.stringify({ code: 401, message: 'auth failed', results: [] }),
      '',
    );
    const provider = new MiniMaxWebSearchProvider({ spawnImpl: fake.spawn });
    await expect(provider.search('hi')).rejects.toThrow(/code=401.*auth failed/);
  });

  it('throws when stdout is not valid JSON', async () => {
    const fake = makeFakeSpawn('<html>not json</html>', '');
    const provider = new MiniMaxWebSearchProvider({ spawnImpl: fake.spawn });
    await expect(provider.search('hi')).rejects.toThrow(/non-JSON output/);
  });

  it('parses only the first JSON object when the CLI appends a hint block', async () => {
    const stdoutWithHint =
      JSON.stringify({
        code: 0,
        results: [
          { title: 'Real', link: 'https://real.test', snippet: 'r' },
          { title: 'Also', link: 'https://also.test', snippet: 'a' },
        ],
      }) +
      '\n\n[matrix-mcp-cli:hint] some trailing hint the CLI prints';
    const fake = makeFakeSpawn(stdoutWithHint, '');
    const provider = new MiniMaxWebSearchProvider({ spawnImpl: fake.spawn });
    const results = await provider.search('hi');
    expect(results).toHaveLength(2);
    expect(results[0]!.title).toBe('Real');
  });

  it('surfaces a 500 error response with the daemon message', async () => {
    const fake = makeFakeSpawn(
      JSON.stringify({
        code: 500,
        message: 'web search failed: request failed; please retry the same request shortly',
        results: [],
      }),
      '',
    );
    const provider = new MiniMaxWebSearchProvider({ spawnImpl: fake.spawn });
    await expect(provider.search('hi')).rejects.toThrow(
      /code=500.*retry the same request shortly/,
    );
  });

  it('normalises results: optional date and content are kept when present', async () => {
    const fake = makeFakeSpawn(
      JSON.stringify({
        code: 0,
        results: [
          { title: 'A', link: 'https://a', snippet: 's', content: 'full page' },
          { title: 'B', link: 'https://b', snippet: 's' },
        ],
      }),
      '',
    );
    const provider = new MiniMaxWebSearchProvider({ spawnImpl: fake.spawn });
    const results = await provider.search('hi', { limit: 5 });
    expect(results[0]).toEqual({
      title: 'A',
      url: 'https://a',
      snippet: 's',
      content: 'full page',
    });
    expect(results[1]).toEqual({ title: 'B', url: 'https://b', snippet: 's' });
  });

  it('respects a custom timeout', async () => {
    const fake = makeFakeSpawn(JSON.stringify({ code: 0, results: [] }), '');
    const provider = new MiniMaxWebSearchProvider({
      spawnImpl: fake.spawn,
      timeoutMs: 5_000,
    });
    await provider.search('hi');
    const args = JSON.parse(fake.calls[0]!.args[4]!);
    expect(args.timeout_seconds).toBe(5);
  });

  it('implements the WebSearchProvider interface', () => {
    const fake = makeFakeSpawn(JSON.stringify({ code: 0, results: [] }), '');
    const provider: WebSearchProvider = new MiniMaxWebSearchProvider({ spawnImpl: fake.spawn });
    expect(typeof provider.search).toBe('function');
  });
});
