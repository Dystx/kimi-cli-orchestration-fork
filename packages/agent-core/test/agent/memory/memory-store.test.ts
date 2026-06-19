import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { MemoryStore } from '../../../src/session/memory-store';

describe('MemoryStore extended API', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-store-'));
    store = new MemoryStore(dir);
  });

  it('writes and reads entries', async () => {
    const written = await store.write({ content: 'hello world', tags: ['greeting'], type: 'fact' });
    expect(written.id).toBeTypeOf('string');
    expect(written.type).toBe('fact');

    const read = await store.read(written.id);
    expect(read?.content).toBe('hello world');
  });

  it('searches by query and tags', async () => {
    await store.write({ content: 'TypeScript is a typed superset of JavaScript', tags: ['lang'], type: 'fact' });
    await store.write({ content: 'Python is dynamically typed', tags: ['lang'], type: 'fact' });

    const results = await store.search('typed', { tags: ['lang'], limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.content.toLowerCase()).toContain('typed');
  });

  it('deletes entries and returns false when missing', async () => {
    const written = await store.write({ content: 'temporary', type: 'snippet' });
    expect(await store.delete(written.id)).toBe(true);
    expect(await store.read(written.id)).toBeUndefined();
    expect(await store.delete(written.id)).toBe(false);
  });
});