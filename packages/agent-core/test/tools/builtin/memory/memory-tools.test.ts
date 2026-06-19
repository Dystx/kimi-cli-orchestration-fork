/**
 * Covers: MemoryWriteTool, MemoryReadTool, MemorySearchTool, MemoryDeleteTool.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type {
  ExecutableTool,
  ExecutableToolContext,
  ExecutableToolResult,
} from '../../../../src/loop';
import { MemoryStore } from '../../../../src/session/memory-store';
import { MemoryWriteTool } from '../../../../src/tools/builtin/memory/memory-write';
import { MemoryReadTool } from '../../../../src/tools/builtin/memory/memory-read';
import { MemorySearchTool } from '../../../../src/tools/builtin/memory/memory-search';
import { MemoryDeleteTool } from '../../../../src/tools/builtin/memory/memory-delete';

async function makeExecution<T>(
  tool: ExecutableTool<T>,
  args: T,
): Promise<{ isError: boolean; output: string }> {
  const ctx: ExecutableToolContext = {
    turnId: '1',
    toolCallId: 'x',
    signal: new AbortController().signal,
  };
  const resolved = await tool.resolveExecution(args);
  if ('execute' in resolved) {
    const result: ExecutableToolResult = await resolved.execute(ctx);
    return { isError: result.isError === true, output: result.output as string };
  }
  return { isError: true, output: resolved.output as string };
}

describe('Memory builtin tools', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-tools-'));
    store = new MemoryStore(dir);
  });

  it('write then read returns the entry', async () => {
    const writeTool = new MemoryWriteTool(store);
    const readTool = new MemoryReadTool(store);
    const write = await makeExecution(writeTool, { content: 'hello', type: 'fact' });
    expect(write.isError).toBe(false);
    const id = write.output.match(/id ([^\s.]+)/)![1]!;
    const read = await makeExecution(readTool, { id });
    expect(read.isError).toBe(false);
    expect(read.output).toContain('hello');
  });

  it('search returns matches and respects limit', async () => {
    const writeTool = new MemoryWriteTool(store);
    const searchTool = new MemorySearchTool(store);
    await makeExecution(writeTool, { content: 'TypeScript is typed', tags: ['lang'] });
    await makeExecution(writeTool, { content: 'Python is dynamic', tags: ['lang'] });
    const search = await makeExecution(searchTool, { query: 'typed', limit: 1 });
    expect(search.isError).toBe(false);
    expect(search.output.split('\n').length).toBe(1);
  });

  it('delete removes the entry', async () => {
    const writeTool = new MemoryWriteTool(store);
    const deleteTool = new MemoryDeleteTool(store);
    const write = await makeExecution(writeTool, { content: 'temporary' });
    const id = write.output.match(/id ([^\s.]+)/)![1]!;
    const del = await makeExecution(deleteTool, { id });
    expect(del.isError).toBe(false);
    const delAgain = await makeExecution(deleteTool, { id });
    expect(delAgain.isError).toBe(true);
  });
});
