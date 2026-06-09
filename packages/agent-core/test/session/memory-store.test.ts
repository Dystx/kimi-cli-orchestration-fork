import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryStore, type MemoryEntry } from '../../src/session/memory-store';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'kimi-memory-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function makeEntry(partial: Partial<MemoryEntry> & { content: string }): Omit<MemoryEntry, 'id' | 'timestamp'> {
  return {
    tags: [],
    source: 'outcome',
    ...partial,
  };
}

describe('MemoryStore', () => {
  it('adds and loads memories', async () => {
    const store = new MemoryStore(workDir);
    await store.addMemory(makeEntry({ content: 'First memory', tags: ['auth'] }));
    await new Promise((r) => setTimeout(r, 20));
    await store.addMemory(makeEntry({ content: 'Second memory', tags: ['refactor'] }));

    const loaded = await store.loadMemories();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.content).toBe('Second memory');
    expect(loaded[1]!.content).toBe('First memory');
  });

  it('finds relevant memories with BM25 scoring', async () => {
    const store = new MemoryStore(workDir);
    await store.addMemory(makeEntry({ content: 'Always run lint before committing code changes', tags: ['workflow'] }));
    await store.addMemory(makeEntry({ content: 'Use subagents for parallel exploration tasks', tags: ['orchestration'] }));
    await store.addMemory(makeEntry({ content: 'The auth module uses JWT tokens for validation', tags: ['auth', 'security'] }));
    await store.addMemory(makeEntry({ content: 'Refactor large functions into smaller units', tags: ['refactor'] }));

    const results = await store.findRelevant('auth jwt validation', undefined, 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.content).toContain('auth module');
    expect(results[0]!.relevanceScore).toBeGreaterThan(0);
  });

  it('boosts tag matches in BM25 scoring', async () => {
    const store = new MemoryStore(workDir);
    await store.addMemory(makeEntry({ content: 'Generic coding tip', tags: ['performance'] }));
    await store.addMemory(makeEntry({ content: 'Another generic tip', tags: ['performance', 'caching'] }));
    await store.addMemory(makeEntry({ content: 'Cache frequently accessed data in Redis', tags: ['performance', 'caching'] }));

    // Query uses exact token forms; "cache" matches the content of the Redis memory.
    const results = await store.findRelevant('cache performance', undefined, 3);
    expect(results[0]!.content).toContain('Redis');
    expect(results[0]!.tags).toContain('caching');
  });

  it('filters by explicit tags', async () => {
    const store = new MemoryStore(workDir);
    await store.addMemory(makeEntry({ content: 'Tip A', tags: ['frontend'] }));
    await store.addMemory(makeEntry({ content: 'Tip B', tags: ['backend'] }));

    const results = await store.findRelevant('', ['backend'], 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe('Tip B');
  });

  it('boosts workDir-tagged memories', async () => {
    const store = new MemoryStore(workDir);
    await store.addMemory(makeEntry({ content: 'General tip', tags: ['workflow'] }));
    await store.addMemory(makeEntry({ content: 'Project-specific tip', tags: ['/workspace'] }));

    const results = await store.findRelevant('', undefined, 10, '/workspace');
    expect(results[0]!.content).toBe('Project-specific tip');
  });

  it('applies recency decay', async () => {
    const store = new MemoryStore(workDir);
    await store.addMemory(makeEntry({ content: 'Old memory about auth', tags: ['auth'] }));
    // Wait a tiny bit so timestamps differ
    await new Promise((r) => setTimeout(r, 20));
    await store.addMemory(makeEntry({ content: 'New memory about auth', tags: ['auth'] }));

    const results = await store.findRelevant('auth', undefined, 2);
    expect(results[0]!.content).toBe('New memory about auth');
  });

  it('returns empty when no query and no matching tags', async () => {
    const store = new MemoryStore(workDir);
    await store.addMemory(makeEntry({ content: 'Orphan memory', tags: [] }));

    const results = await store.findRelevant('', undefined, 10);
    expect(results).toHaveLength(0);
  });

  it('limits results', async () => {
    const store = new MemoryStore(workDir);
    for (let i = 0; i < 5; i++) {
      await store.addMemory(makeEntry({ content: `Memory ${i}`, tags: ['test'] }));
    }

    const results = await store.findRelevant('', ['test'], 3);
    expect(results).toHaveLength(3);
  });

  it('enforces max entry limit', async () => {
    const store = new MemoryStore(workDir);
    for (let i = 0; i < 1005; i++) {
      await store.addMemory(makeEntry({ content: `Entry ${i}`, tags: [] }));
    }

    const loaded = await store.loadMemories();
    expect(loaded).toHaveLength(1000);
  }, 15000);

  it('formats for injection', async () => {
    const store = new MemoryStore(workDir);
    await store.addMemory(makeEntry({ content: 'Test memory', tags: ['tag1'] }));

    const formatted = store.formatForInjection(await store.loadMemories());
    expect(formatted).toContain('## Cross-Session Memories');
    expect(formatted).toContain('Test memory');
    expect(formatted).toContain('Tags: tag1');
  });

  it('handles exact phrase matches as strong signal', async () => {
    const store = new MemoryStore(workDir);
    await store.addMemory(makeEntry({ content: 'Run the full test suite before merging', tags: ['ci'] }));
    await store.addMemory(makeEntry({ content: 'Tests should be fast and isolated', tags: ['testing'] }));

    const results = await store.findRelevant('full test suite', undefined, 2);
    expect(results[0]!.content).toContain('full test suite');
  });
});
