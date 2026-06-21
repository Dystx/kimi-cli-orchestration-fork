/**
 * Covers: ChainedWebSearchProvider.
 *
 * Exercises the fallback semantics: returns the first non-empty result,
 * cascades on empty list, aggregates errors when every provider throws,
 * and surfaces a clean "no results" when every provider is empty.
 */

import { describe, expect, it, vi } from 'vitest';

import { ChainedWebSearchProvider } from '../../src/tools/providers/chained-web-search';
import type { WebSearchProvider, WebSearchResult } from '../../src/tools/builtin';

function makeProvider(
  name: string,
  results: WebSearchResult[] | Error,
): { provider: WebSearchProvider; calls: () => number } {
  let calls = 0;
  const search = vi.fn(async () => {
    calls += 1;
    if (results instanceof Error) throw results;
    return results;
  });
  const provider: WebSearchProvider = { search };
  return { provider, calls: () => calls };
}

describe('ChainedWebSearchProvider', () => {
  it('throws when constructed with no providers', () => {
    expect(() => new ChainedWebSearchProvider([])).toThrow(/at least one provider/);
  });

  it('returns the first provider result when non-empty', async () => {
    const a = makeProvider('a', [
      { title: 'A1', url: 'https://a.test/1', snippet: 's' },
    ]);
    const b = makeProvider('b', [
      { title: 'B1', url: 'https://b.test/1', snippet: 's' },
    ]);
    const chain = new ChainedWebSearchProvider([
      { provider: a.provider, name: 'a' },
      { provider: b.provider, name: 'b' },
    ]);
    const results = await chain.search('hello');
    expect(results[0]!.title).toBe('A1');
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(0);
  });

  it('falls back to the next provider when the first returns empty', async () => {
    const a = makeProvider('a', []);
    const b = makeProvider('b', [
      { title: 'B1', url: 'https://b.test/1', snippet: 's' },
    ]);
    const chain = new ChainedWebSearchProvider([
      { provider: a.provider, name: 'a' },
      { provider: b.provider, name: 'b' },
    ]);
    const results = await chain.search('hello');
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('B1');
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });

  it('aggregates errors when every provider throws and rethrows a combined message', async () => {
    const a = makeProvider('a', new Error('boom a'));
    const b = makeProvider('b', new Error('boom b'));
    const chain = new ChainedWebSearchProvider([
      { provider: a.provider, name: 'a' },
      { provider: b.provider, name: 'b' },
    ]);
    await expect(chain.search('hello')).rejects.toThrow(/\[a\] boom a.*\[b\] boom b/);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });

  it('returns [] when every provider returns empty (no error)', async () => {
    const a = makeProvider('a', []);
    const b = makeProvider('b', []);
    const chain = new ChainedWebSearchProvider([
      { provider: a.provider, name: 'a' },
      { provider: b.provider, name: 'b' },
    ]);
    const results = await chain.search('hello');
    expect(results).toEqual([]);
  });

  it('continues past an empty result AND a thrown error to a successful later provider', async () => {
    const a = makeProvider('a', []);
    const b = makeProvider('b', new Error('flaky'));
    const c = makeProvider('c', [
      { title: 'C1', url: 'https://c.test/1', snippet: 's' },
    ]);
    const chain = new ChainedWebSearchProvider([
      { provider: a.provider, name: 'a' },
      { provider: b.provider, name: 'b' },
      { provider: c.provider, name: 'c' },
    ]);
    const results = await chain.search('hello');
    expect(results[0]!.title).toBe('C1');
  });

  it('forwards query, limit, includeContent, and toolCallId to providers', async () => {
    const observed: {
      query: string;
      limit?: number;
      includeContent?: boolean;
      toolCallId?: string;
    }[] = [];
    const provider: WebSearchProvider = {
      search: vi.fn(async (q, opts) => {
        observed.push({
          query: q,
          limit: opts?.limit,
          includeContent: opts?.includeContent,
          toolCallId: opts?.toolCallId,
        });
        return [];
      }),
    };
    const chain = new ChainedWebSearchProvider([{ provider, name: 'p' }]);
    await chain.search('kimi', { limit: 7, includeContent: true, toolCallId: 'tc-99' });
    expect(observed[0]).toEqual({
      query: 'kimi',
      limit: 7,
      includeContent: true,
      toolCallId: 'tc-99',
    });
  });
});
