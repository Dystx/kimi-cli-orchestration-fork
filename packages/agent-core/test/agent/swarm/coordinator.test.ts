import { describe, it, expect, vi } from 'vitest';
import { SwarmCoordinator } from '../../../src/agent/swarm/coordinator';
import type { AgentSwarmSpec } from '../../../src/tools/builtin/collaboration/agent-swarm';

function spec(name: string): AgentSwarmSpec {
  return { description: name } as unknown as AgentSwarmSpec;
}

function makeAgent(): {
  handlers: Map<string, Array<(e: unknown) => void>>;
  session: {
    orchestrationHooks: { on(event: string, handler: (e: unknown) => void): () => void };
    subagentHost: { spawn: ReturnType<typeof vi.fn> };
    emitSwarmSnapshot: ReturnType<typeof vi.fn>;
  };
  log: { warn: ReturnType<typeof vi.fn> };
} {
  const handlers = new Map<string, Array<(e: unknown) => void>>();
  const hooks = {
    on(event: string, handler: (e: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const cur = handlers.get(event) ?? [];
        handlers.set(event, cur.filter((h) => h !== handler));
      };
    },
  };
  return {
    handlers,
    session: {
      orchestrationHooks: hooks,
      subagentHost: { spawn: vi.fn(() => ({ subagentId: 'agent-retry-1' })) },
      // Phase 10: the coordinator calls `session.emitSwarmSnapshot` on every
      // member transition and on dispose. Mock the entry point so existing
      // tests keep passing without each assertion having to opt in.
      emitSwarmSnapshot: vi.fn(),
    },
    log: { warn: vi.fn() },
  };
}

function emit(handlers: Map<string, Array<(e: unknown) => void>>, event: string, payload: unknown) {
  for (const h of handlers.get(event) ?? []) h(payload);
}

describe('SwarmCoordinator', () => {
  // The mock agent satisfies SwarmCoordinator's structural type via cast at the
  // constructor call site; vi.fn() returns Mock<...> which isn't strictly
  // compatible with the expected return shapes.
  const newCoordinator = (agent: ReturnType<typeof makeAgent>) =>
    new SwarmCoordinator('run-1', agent as never, new AbortController());

  it('registerMember + getProgress reports total', () => {
    const agent = makeAgent();
    const c = newCoordinator(agent);
    c.registerMember('a', spec('a'));
    c.registerMember('b', spec('b'));
    const p = c.getProgress();
    expect(p.total).toBe(2);
    expect(p.completed).toBe(0);
    c.dispose();
  });

  it('marks members completed on subagent.completed', () => {
    const agent = makeAgent();
    const c = newCoordinator(agent);
    c.registerMember('a', spec('a'));
    c.registerMember('b', spec('b'));
    emit(agent.handlers, 'subagent.started', { subagentId: 'a' });
    emit(agent.handlers, 'subagent.started', { subagentId: 'b' });
    // Mirror the real `OrchestrationEvent` shape emitted by
    // `SessionSubagentHost` so the coordinator reads `resultSummary` from
    // `payload` rather than the (always-undefined) top-level `result`.
    emit(agent.handlers, 'subagent.completed', {
      type: 'subagent.completed',
      payload: { subagentId: 'a', resultSummary: 'hello' },
    });
    const p = c.getProgress();
    expect(p.completed).toBe(1);
    expect(p.total).toBe(2);
    c.dispose();
  });

  it('marks members failed on subagent.failed', () => {
    const agent = makeAgent();
    const c = newCoordinator(agent);
    c.registerMember('a', spec('a'));
    // Mirror the real `OrchestrationEvent` shape: `error` lives under
    // `payload` because `SessionSubagentHost.emitSubagentFailed` routes
    // the failure message through `orchestrationHooks.emit({ type,
    // payload })`.
    emit(agent.handlers, 'subagent.failed', {
      type: 'subagent.failed',
      payload: { subagentId: 'a', error: new Error('boom') },
    });
    const p = c.getProgress();
    expect(p.failed).toBe(1);
    const results = c.getResults();
    expect(results[0]!.status).toBe('failed');
    c.dispose();
  });

  it('cancelAll aborts and marks in-flight as cancelled', async () => {
    const agent = makeAgent();
    const controller = new AbortController();
    const c = new SwarmCoordinator('run-1', agent as never, controller);
    c.registerMember('a', spec('a'));
    c.registerMember('b', spec('b'));
    emit(agent.handlers, 'subagent.started', { subagentId: 'a' });
    await c.cancelAll('user-requested');
    expect(controller.signal.aborted).toBe(true);
    const p = c.getProgress();
    // Both 'started' (a) and 'spawned' (b) members are cancelled.
    expect(p.cancelled).toBe(2);
    c.dispose();
  });

  it('cancelAll is idempotent and safe on disposed coordinator', async () => {
    const agent = makeAgent();
    const c = newCoordinator(agent);
    c.dispose();
    await expect(c.cancelAll('x')).resolves.toBeUndefined();
  });

  it('dispose unsubscribes from all hooks', () => {
    const agent = makeAgent();
    const c = newCoordinator(agent);
    expect(agent.handlers.get('subagent.started')?.length ?? 0).toBeGreaterThan(0);
    c.dispose();
    expect(agent.handlers.get('subagent.started')?.length ?? 0).toBe(0);
  });

  it('retryFailed skips non-failed members', async () => {
    const agent = makeAgent();
    const c = newCoordinator(agent);
    c.registerMember('a', spec('a'));
    emit(agent.handlers, 'subagent.completed', {
      type: 'subagent.completed',
      payload: { subagentId: 'a', resultSummary: 'done' },
    });
    const retried = await c.retryFailed();
    expect(retried.length).toBe(0);
    expect(agent.session.subagentHost.spawn).not.toHaveBeenCalled();
    c.dispose();
  });

  it('retryFailed re-spawns failed members and re-keys the map', async () => {
    const agent = makeAgent();
    const c = newCoordinator(agent);
    c.registerMember('a', spec('a'));
    emit(agent.handlers, 'subagent.failed', {
      type: 'subagent.failed',
      payload: { subagentId: 'a', error: new Error('boom') },
    });
    await c.retryFailed();
    expect(agent.session.subagentHost.spawn).toHaveBeenCalledTimes(1);
    // The re-keyed member should be findable under its new id and back in 'spawned'.
    const member = c.getProgress().members.find((m) => m.subagentId === 'agent-retry-1');
    expect(member).toBeDefined();
    expect(member!.status).toBe('spawned');
    c.dispose();
  });

  it('ignores events for unknown subagentIds', () => {
    const agent = makeAgent();
    const c = newCoordinator(agent);
    emit(agent.handlers, 'subagent.completed', {
      type: 'subagent.completed',
      payload: { subagentId: 'ghost', resultSummary: 'done' },
    });
    const p = c.getProgress();
    expect(p.total).toBe(0);
    c.dispose();
  });

  it('reads subagentId from OrchestrationEvent.payload shape', () => {
    const agent = makeAgent();
    const c = newCoordinator(agent);
    c.registerMember('agent-1', spec('a'));
    emit(agent.handlers, 'subagent.started', {
      type: 'subagent.started',
      payload: { subagentId: 'agent-1' },
    });
    emit(agent.handlers, 'subagent.completed', {
      type: 'subagent.completed',
      payload: { subagentId: 'agent-1' },
    });
    expect(c.getProgress().completed).toBe(1);
    c.dispose();
  });

  it('falls back to top-level subagentId for flat AgentEvent shape', () => {
    const agent = makeAgent();
    const c = newCoordinator(agent);
    c.registerMember('a', spec('a'));
    emit(agent.handlers, 'subagent.completed', { subagentId: 'a' });
    expect(c.getProgress().completed).toBe(1);
    c.dispose();
  });

  it('awaitCompletion resolves immediately for already-terminal members', async () => {
    const agent = makeAgent();
    const c = newCoordinator(agent);
    c.registerMember('a', spec('a'));
    emit(agent.handlers, 'subagent.completed', {
      type: 'subagent.completed',
      payload: { subagentId: 'a', resultSummary: 'done' },
    });
    const result = await c.awaitCompletion('a');
    expect(result).toBeDefined();
    c.dispose();
  });

  it('awaitCompletion resolves when a subagent.completed event arrives later', async () => {
    const agent = makeAgent();
    const c = newCoordinator(agent);
    c.registerMember('a', spec('a'));
    const promise = c.awaitCompletion('a');
    emit(agent.handlers, 'subagent.completed', {
      type: 'subagent.completed',
      payload: { subagentId: 'a', resultSummary: 'done' },
    });
    const result = await promise;
    expect(result).toBeDefined();
    c.dispose();
  });

  it('awaitCompletion rejects on AbortSignal', async () => {
    const agent = makeAgent();
    const c = newCoordinator(agent);
    c.registerMember('a', spec('a'));
    const controller = new AbortController();
    const promise = c.awaitCompletion('a', controller.signal);
    controller.abort('user-requested');
    await expect(promise).rejects.toBe('user-requested');
    c.dispose();
  });

  it('dispose rejects all pending completions', async () => {
    const agent = makeAgent();
    const c = newCoordinator(agent);
    c.registerMember('a', spec('a'));
    const promise = c.awaitCompletion('a');
    c.dispose();
    await expect(promise).rejects.toThrow('SwarmCoordinator disposed');
  });
});