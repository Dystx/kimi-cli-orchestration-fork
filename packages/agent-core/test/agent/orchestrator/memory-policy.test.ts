import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { MemoryPolicy } from '../../../src/agent/orchestrator/memory-policy';
import { MemoryStore } from '../../../src/session/memory-store';

function makeAgent(
  store: MemoryStore | undefined,
  history: Array<{ role: string; content: Array<{ type: string; text: string }> }>,
) {
  return {
    memoryStore: store,
    config: { cwd: '/tmp/project' },
    context: { history },
    log: { warn: vi.fn() },
  } as never;
}

describe('MemoryPolicy', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-policy-'));
  });

  it('returns no injections when memoryStore is missing', async () => {
    const agent = makeAgent(undefined, []);
    const policy = new MemoryPolicy(agent);
    const result = await policy.beforeStep({ turnId: 1, signal: new AbortController().signal });
    expect(result.injections).toEqual([]);
  });

  it('does not inject on first user prompt (cadence gate)', async () => {
    const store = new MemoryStore(dir);
    await store.write({ content: 'Project uses pnpm for installs', tags: ['fact'] });
    const history = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'How do I install dependencies?' }],
      },
    ];
    const policy = new MemoryPolicy(makeAgent(store, history));
    const result = await policy.beforeStep({ turnId: 1, signal: new AbortController().signal });
    // First call has no prior assistant turns, so cadence (>=6) is not yet met
    // and no compaction has occurred. Injection is gated.
    expect(result.injections).toEqual([]);
  });

  it('flags a refresh after compaction', async () => {
    const store = new MemoryStore(dir);
    await store.write({ content: 'Use the dark theme', tags: ['preference'] });
    const history = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'set theme' }],
      },
    ];
    const policy = new MemoryPolicy(makeAgent(store, history));
    const first = await policy.beforeStep({ turnId: 1, signal: new AbortController().signal });
    expect(first.injections.length).toBe(0); // first call, no assistant turns yet
    policy.onContextCompacted();
    const second = await policy.beforeStep({ turnId: 2, signal: new AbortController().signal });
    expect(second.injections.length).toBe(1);
  });
});
