import { describe, it, expect, vi } from 'vitest';
import { SwarmCoordinator } from '../../../src/agent/swarm/coordinator';
import type { AgentSwarmSpec } from '../../../src/tools/builtin/collaboration/agent-swarm';
import type { SwarmRunSummary } from '../../../src/session';

function spec(name: string): AgentSwarmSpec {
  return { description: name } as unknown as AgentSwarmSpec;
}

function makeAgent(): {
  handlers: Map<string, Array<(e: unknown) => void>>;
  session: {
    orchestrationHooks: { on(event: string, handler: (e: unknown) => void): () => void };
    subagentHost: { spawn: ReturnType<typeof vi.fn> };
  };
  log: { warn: ReturnType<typeof vi.fn> };
} {
  const handlers = new Map<string, Array<(e: unknown) => void>>();
  return {
    handlers,
    session: {
      orchestrationHooks: {
        on(event: string, handler: (e: unknown) => void) {
          const list = handlers.get(event) ?? [];
          list.push(handler);
          handlers.set(event, list);
          return () => {
            const cur = handlers.get(event) ?? [];
            handlers.set(event, cur.filter((h) => h !== handler));
          };
        },
      },
      subagentHost: { spawn: vi.fn() },
    },
    log: { warn: vi.fn() },
  };
}

function emit(handlers: Map<string, Array<(e: unknown) => void>>, event: string, payload: unknown) {
  for (const h of handlers.get(event) ?? []) h(payload);
}

describe('SwarmCoordinator dispose summary', () => {
  it('reports a SwarmRunSummary via the onDispose callback', () => {
    const agent = makeAgent();
    const onDispose = vi.fn();
    const c = new SwarmCoordinator('run-x', agent as never, new AbortController(), onDispose);
    c.registerMember('a', spec('a'));
    c.registerMember('b', spec('b'));
    c.registerMember('c', spec('c'));
    c.dispose();
    expect(onDispose).toHaveBeenCalledTimes(1);
    const summary = onDispose.mock.calls[0]![0] as SwarmRunSummary;
    expect(summary.runId).toBe('run-x');
    expect(summary.memberCount).toBe(3);
    expect(summary.completedCount).toBe(0);
    expect(summary.cancelledCount).toBe(0);
    expect(summary.failedCount).toBe(0);
    expect(summary.startedAt).toBeTypeOf('number');
    expect(summary.completedAt).toBeGreaterThanOrEqual(summary.startedAt);
  });

  it('counts cancelled members', async () => {
    const agent = makeAgent();
    const onDispose = vi.fn();
    const c = new SwarmCoordinator('run-cancel', agent as never, new AbortController(), onDispose);
    c.registerMember('a', spec('a'));
    c.registerMember('b', spec('b'));
    // Flip member 'a' to 'started' so cancelAll marks it cancelled (rather
    // than leaving it in 'spawned'). Mirrors the `subagent.started` event
    // the real SessionSubagentHost emits once the child is actually running.
    emit(agent.handlers, 'subagent.started', {
      type: 'subagent.started',
      payload: { subagentId: 'a' },
    });
    await c.cancelAll('user-requested');
    c.dispose();
    const summary = onDispose.mock.calls[0]![0] as SwarmRunSummary;
    expect(summary.cancelledCount).toBeGreaterThanOrEqual(1);
  });
});