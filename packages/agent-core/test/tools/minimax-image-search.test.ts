/**
 * Covers: MiniMaxImageSearchProvider.
 *
 * Stubs `spawnImpl` so the test never touches the real `mavis` CLI or daemon.
 */

import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MiniMaxImageSearchProvider } from '../../src/tools/providers/minimax-image-search';
import type { ImageSearchProvider } from '../../src/tools/builtin';

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
    return child as unknown as ChildProcess;
  };
  return { calls, spawn };
}

describe('MiniMaxImageSearchProvider', () => {
  afterEach(() => vi.useRealTimers());

  it('spawns the mavis CLI with matrix_search_images and parses results', async () => {
    const fake = makeFakeSpawn(
      JSON.stringify({
        code: 0,
        message: 'ok',
        results: [
          {
            query: 'rust crab logo',
            images: [
              { title: 'Ferris', image_url: 'https://rustacean.net/ferris.png', source: 'rustacean.net' },
              { title: 'Ferris alt', image_url: 'https://example.com/ferris2.png' },
            ],
          },
        ],
      }),
      '',
    );
    const provider = new MiniMaxImageSearchProvider({ spawnImpl: fake.spawn });
    const results = await provider.search('rust crab logo', { limit: 5 });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.file).toContain('mavis');
    expect(fake.calls[0]!.args.slice(0, 4)).toEqual([
      'mcp',
      'call',
      'matrix',
      'matrix_search_images',
    ]);

    const toolArgs = JSON.parse(fake.calls[0]!.args[4]!);
    expect(toolArgs.queries).toHaveLength(1);
    expect(toolArgs.queries[0].query).toBe('rust crab logo');
    expect(toolArgs.queries[0].prompt).toBe('rust crab logo'); // defaults to query
    expect(toolArgs.queries[0].task_name).toBe('kimi-code-image-search');

    expect(results).toEqual([
      { title: 'Ferris', imageUrl: 'https://rustacean.net/ferris.png', source: 'rustacean.net' },
      { title: 'Ferris alt', imageUrl: 'https://example.com/ferris2.png' },
    ]);
  });

  it('uses the explicit prompt when supplied', async () => {
    const fake = makeFakeSpawn(JSON.stringify({ code: 0, results: [] }), '');
    const provider = new MiniMaxImageSearchProvider({ spawnImpl: fake.spawn });
    await provider.search('logo', { prompt: 'flat illustration' });
    const toolArgs = JSON.parse(fake.calls[0]!.args[4]!);
    expect(toolArgs.queries[0].prompt).toBe('flat illustration');
  });

  it('respects the limit option', async () => {
    const fake = makeFakeSpawn(
      JSON.stringify({
        code: 0,
        results: [
          {
            images: [
              { title: '1', image_url: 'https://a.test/1' },
              { title: '2', image_url: 'https://a.test/2' },
              { title: '3', image_url: 'https://a.test/3' },
            ],
          },
        ],
      }),
      '',
    );
    const provider = new MiniMaxImageSearchProvider({ spawnImpl: fake.spawn });
    const results = await provider.search('hi', { limit: 2 });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.title)).toEqual(['1', '2']);
  });

  it('skips per-task errors and continues collecting from successful tasks', async () => {
    const fake = makeFakeSpawn(
      JSON.stringify({
        code: 0,
        results: [
          { error: 'upstream timeout' },
          {
            images: [{ title: 'good', image_url: 'https://good.test' }],
          },
        ],
      }),
      '',
    );
    const provider = new MiniMaxImageSearchProvider({ spawnImpl: fake.spawn });
    const results = await provider.search('hi');
    expect(results).toEqual([{ title: 'good', imageUrl: 'https://good.test' }]);
  });

  it('skips images with empty URLs', async () => {
    const fake = makeFakeSpawn(
      JSON.stringify({
        code: 0,
        results: [
          {
            images: [
              { title: 'no-url', image_url: '' },
              { title: 'has-url', image_url: 'https://ok.test' },
            ],
          },
        ],
      }),
      '',
    );
    const provider = new MiniMaxImageSearchProvider({ spawnImpl: fake.spawn });
    const results = await provider.search('hi');
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('has-url');
  });

  it('returns [] when results is missing or empty', async () => {
    const fake = makeFakeSpawn(JSON.stringify({ code: 0, results: [] }), '');
    const provider = new MiniMaxImageSearchProvider({ spawnImpl: fake.spawn });
    expect(await provider.search('hi')).toEqual([]);
  });

  it('parses only the first JSON object when the CLI appends a hint block', async () => {
    const stdout =
      JSON.stringify({
        code: 0,
        results: [{ images: [{ title: 't', image_url: 'https://x' }] }],
      }) +
      '\n\n[matrix-mcp-cli:hint] trailing hint';
    const fake = makeFakeSpawn(stdout, '');
    const provider = new MiniMaxImageSearchProvider({ spawnImpl: fake.spawn });
    const results = await provider.search('hi');
    expect(results).toHaveLength(1);
  });

  it('throws when the CLI exits non-zero', async () => {
    const fake = makeFakeSpawn('', 'mavis: not found', 1);
    const provider = new MiniMaxImageSearchProvider({ spawnImpl: fake.spawn });
    await expect(provider.search('hi')).rejects.toThrow(/exited with code 1/);
  });

  it('throws when the daemon returns a non-zero code', async () => {
    const fake = makeFakeSpawn(
      JSON.stringify({ code: 500, message: 'upstream glitched', results: [] }),
      '',
    );
    const provider = new MiniMaxImageSearchProvider({ spawnImpl: fake.spawn });
    await expect(provider.search('hi')).rejects.toThrow(/code=500.*upstream glitched/);
  });

  it('implements the ImageSearchProvider interface', () => {
    const fake = makeFakeSpawn(JSON.stringify({ code: 0, results: [] }), '');
    const provider: ImageSearchProvider = new MiniMaxImageSearchProvider({ spawnImpl: fake.spawn });
    expect(typeof provider.search).toBe('function');
  });
});
