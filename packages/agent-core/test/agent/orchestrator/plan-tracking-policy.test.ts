import EventEmitter from 'node:events';
import { watch } from 'node:fs';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { Agent } from '#/agent';
import { PlanTrackingPolicy } from '#/agent/orchestrator/plan-tracking-policy';
import { TODO_STORE_KEY } from '#/tools/builtin/state/todo-list';

const SYNC_DEBOUNCE_MS = 250;

vi.mock('node:fs', () => ({
  watch: vi.fn(() => {
    throw new Error('watch unavailable');
  }),
}));

interface MockAgentOptions {
  planActive?: boolean;
  planPath?: string | null;
  planContent?: string;
  readError?: Error;
}

function makeMockAgent(overrides: MockAgentOptions = {}): Agent {
  const store: Record<string, unknown> = {};
  return {
    planMode: {
      isActive: overrides.planActive ?? false,
      planFilePath: overrides.planPath ?? null,
    },
    kaos: {
      readText: vi.fn(async () => {
        if (overrides.readError !== undefined) {
          throw overrides.readError;
        }
        return overrides.planContent ?? '';
      }),
    },
    tools: {
      updateStore: vi.fn((key, value) => {
        store[key] = value;
      }),
      storeData: vi.fn(() => store),
    },
    log: { warn: vi.fn(), error: vi.fn() },
  } as unknown as Agent;
}

const signal = new AbortController().signal;

describe('PlanTrackingPolicy', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing when plan mode is inactive', async () => {
    const agent = makeMockAgent();
    const policy = new PlanTrackingPolicy(agent);
    const result = await policy.beforeStep({ turnId: 1, signal });

    expect(result.injections).toEqual([]);
    expect(agent.tools.updateStore).not.toHaveBeenCalled();
    expect(agent.kaos.readText).not.toHaveBeenCalled();
  });

  it('syncs parsed todos when plan mode is active with a file path', async () => {
    const agent = makeMockAgent({
      planActive: true,
      planPath: '/tmp/plan.md',
      planContent: '# Plan\n## Research\n- [x] read docs\n- [ ] write code\n',
    });
    const policy = new PlanTrackingPolicy(agent);

    const result = await policy.beforeStep({ turnId: 1, signal });

    expect(result.injections).toEqual([]);
    expect(agent.tools.updateStore).toHaveBeenCalledTimes(1);
    expect(agent.tools.updateStore).toHaveBeenCalledWith(TODO_STORE_KEY, [
      { title: 'Research', status: 'in_progress' },
      { title: 'read docs', status: 'done' },
      { title: 'write code', status: 'pending' },
    ]);
  });

  it('falls back to polling the plan file when fs.watch fails to attach', async () => {
    const watchError = new Error('watch unavailable');
    vi.mocked(watch).mockImplementation(() => {
      throw watchError;
    });

    const agent = makeMockAgent({
      planActive: true,
      planPath: '/tmp/plan.md',
      planContent: '# Plan\n## Step\n- [ ] item\n',
    });
    const policy = new PlanTrackingPolicy(agent);

    const result = await policy.beforeStep({ turnId: 1, signal });

    expect(result.injections).toEqual([]);
    expect(agent.kaos.readText).toHaveBeenCalledWith('/tmp/plan.md');
    expect(agent.tools.updateStore).toHaveBeenCalledWith(TODO_STORE_KEY, [
      { title: 'Step', status: 'in_progress' },
      { title: 'item', status: 'pending' },
    ]);
    expect(agent.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('PlanTrackingPolicy could not watch /tmp/plan.md'),
    );
  });

  it('does not call updateStore twice when content is unchanged', async () => {
    const agent = makeMockAgent({
      planActive: true,
      planPath: '/tmp/plan.md',
      planContent: '# Plan\n## Step\n- [ ] item\n',
    });
    const policy = new PlanTrackingPolicy(agent);

    await policy.beforeStep({ turnId: 1, signal });
    expect(agent.tools.updateStore).toHaveBeenCalledTimes(1);

    await policy.beforeStep({ turnId: 2, signal });
    expect(agent.tools.updateStore).toHaveBeenCalledTimes(1);
  });

  it('logs non-ENOENT read errors and clears the todo store', async () => {
    const error = Object.assign(new Error('disk failure'), { code: 'EACCES' });
    const agent = makeMockAgent({
      planActive: true,
      planPath: '/tmp/plan.md',
      planContent: '# Plan\n## Step\n- [ ] item\n',
    });
    const policy = new PlanTrackingPolicy(agent);

    await policy.beforeStep({ turnId: 1, signal });
    expect(agent.tools.updateStore).toHaveBeenLastCalledWith(TODO_STORE_KEY, [
      { title: 'Step', status: 'in_progress' },
      { title: 'item', status: 'pending' },
    ]);

    agent.kaos.readText = vi.fn(async () => {
      throw error;
    });

    const result = await policy.beforeStep({ turnId: 2, signal });

    expect(result.injections).toEqual([]);
    expect(agent.tools.updateStore).toHaveBeenLastCalledWith(TODO_STORE_KEY, []);
    expect(agent.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('PlanTrackingPolicy failed to read /tmp/plan.md'),
    );
    expect(agent.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('disk failure'),
    );
  });

  it('treats ENOENT as an empty plan and clears todos', async () => {
    const error = Object.assign(new Error('file missing'), { code: 'ENOENT' });
    const agent = makeMockAgent({
      planActive: true,
      planPath: '/tmp/plan.md',
      planContent: '# Plan\n## Step\n- [ ] item\n',
    });
    const policy = new PlanTrackingPolicy(agent);

    await policy.beforeStep({ turnId: 1, signal });
    expect(agent.tools.updateStore).toHaveBeenCalledTimes(1);

    agent.kaos.readText = vi.fn(async () => {
      throw error;
    });

    await policy.beforeStep({ turnId: 2, signal });
    expect(agent.tools.updateStore).toHaveBeenCalledTimes(2);
    expect(agent.tools.updateStore).toHaveBeenLastCalledWith(TODO_STORE_KEY, []);
  });

  it('syncs file changes emitted by the fs watcher', async () => {
    const watcher = new EventEmitter() as ReturnType<typeof watch>;
    vi.mocked(watch).mockImplementation((_path, listener) => {
      if (listener) {
        watcher.on('change', listener as () => void);
      }
      return watcher;
    });

    const agent = makeMockAgent({
      planActive: true,
      planPath: '/tmp/plan.md',
      planContent: '# Plan\n## Step\n- [ ] item\n',
    });
    const policy = new PlanTrackingPolicy(agent);

    await policy.beforeStep({ turnId: 1, signal });
    expect(agent.tools.updateStore).toHaveBeenCalledTimes(1);

    vi.mocked(agent.kaos.readText).mockResolvedValue(
      '# Plan\n## Step\n- [x] item\n',
    );
    watcher.emit('change');
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 10);

    expect(agent.tools.updateStore).toHaveBeenCalledTimes(2);
    expect(agent.tools.updateStore).toHaveBeenLastCalledWith(TODO_STORE_KEY, [
      { title: 'Step', status: 'done' },
      { title: 'item', status: 'done' },
    ]);
  });

  it('does not update the store when the plan file path changes during sync', async () => {
    const agent = makeMockAgent({
      planActive: true,
      planPath: '/tmp/plan.md',
      planContent: '# Plan\n## Step\n- [ ] item\n',
    });

    let resolveReadText: (value: string) => void = () => {};
    vi.mocked(agent.kaos.readText).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReadText = resolve;
        }),
    );

    const policy = new PlanTrackingPolicy(agent);
    const syncPromise = policy.beforeStep({ turnId: 1, signal });

    (agent.planMode as { planFilePath: string | null }).planFilePath =
      '/tmp/other-plan.md';
    resolveReadText('# Plan\n## Step\n- [ ] item\n');
    await syncPromise;

    expect(agent.tools.updateStore).not.toHaveBeenCalled();
  });

  it('disposes the watcher and timers cleanly', () => {
    const agent = makeMockAgent({
      planActive: true,
      planPath: '/tmp/plan.md',
    });
    const policy = new PlanTrackingPolicy(agent);

    expect(() => {
      policy.dispose();
    }).not.toThrow();
  });
});
