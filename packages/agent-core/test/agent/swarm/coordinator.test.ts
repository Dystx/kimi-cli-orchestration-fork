import { describe, it, expect, vi } from 'vitest';
import { SwarmCoordinator } from '../../../src/agent/swarm/coordinator';
import type { AgentSwarmSpec } from '../../../src/tools/builtin/collaboration/agent-swarm';
import type { SubagentResult } from '../../../src/session/subagent-batch';

function spec(name: string): AgentSwarmSpec {
  return { description: name } as unknown as AgentSwarmSpec;
}

function makeAgent() {
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
      subagentHost: { spawn: vi.fn() },
    },
    log: { warn: vi.fn() },
  } as never;
}

function emit(handlers: Map<string, Array<(e: unknown) => void>>, event: string, payload: unknown) {
  for (const h of handlers.get(event) ?? []) h(payload);
}

describe('SwarmCoordinator', () => {
  it('registerMember + getProgress reports total', () => {
    const agent = makeAgent();
    const c = new SwarmCoordinator('run-1', agent, new AbortController());
    c.registerMember('a', spec('a'));
    c.registerMember('b', spec('b'));
    const p = c.getProgress();
    expect(p.total).toBe(2);
    expect(p.completed).toBe(0);
    c.dispose();
  });

  it('marks members completed on subagent.completed', () => {
    const agent = makeAgent();
    const c = new SwarmCoordinator('run-1', agent, new AbortController());
    c.registerMember('a', spec('a'));
    c.registerMember('b', spec('b'));
    emit(agent.handlers, 'subagent.started', { subagentId: 'a' });
    emit(agent.handlers, 'subagent.started', { subagentId: 'b' });
    emit(agent.handlers, 'subagent.completed', {
      subagentId: 'a',
      result: { status: 'completed' } as SubagentResult,
    });
    const p = c.getProgress();
    expect(p.completed).toBe(1);
    expect(p.total).toBe(2);
    c.dispose();
  });

  it('marks members failed on subagent.failed', () => {
    const agent = makeAgent();
    const c = new SwarmCoordinator('run-1', agent, new AbortController());
    c.registerMember('a', spec('a'));
    emit(agent.handlers, 'subagent.failed', { subagentId: 'a', error: new Error('boom') });
    const p = c.getProgress();
    expect(p.failed).toBe(1);
    const results = c.getResults();
    expect(results[0]!.status).toBe('failed');
    c.dispose();
  });

  it('cancelAll aborts and marks in-flight as cancelled', async () => {
    const agent = makeAgent();
    const controller = new AbortController();
    const c = new SwarmCoordinator('run-1', agent, controller);
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
    const c = new SwarmCoordinator('run-1', agent, new AbortController());
    c.dispose();
    await expect(c.cancelAll('x')).resolves.toBeUndefined();
  });

  it('dispose unsubscribes from all hooks', () => {
    const agent = makeAgent();
    const c = new SwarmCoordinator('run-1', agent, new AbortController());
    expect(agent.handlers.get('subagent.started')?.length ?? 0).toBeGreaterThan(0);
    c.dispose();
    expect(agent.handlers.get('subagent.started')?.length ?? 0).toBe(0);
  });

  it('retryFailed skips non-failed members', async () => {
    const agent = makeAgent();
    const c = new SwarmCoordinator('run-1', agent, new AbortController());
    c.registerMember('a', spec('a'));
    emit(agent.handlers, 'subagent.completed', { subagentId: 'a', result: { status: 'completed' } });
    const retried = await c.retryFailed();
    expect(retried.length).toBe(0);
    expect(agent.session.subagentHost.spawn).not.toHaveBeenCalled();
    c.dispose();
  });

  it('retryFailed re-spawns failed members', async () => {
    const agent = makeAgent();
    const c = new SwarmCoordinator('run-1', agent, new AbortController());
    c.registerMember('a', spec('a'));
    emit(agent.handlers, 'subagent.failed', { subagentId: 'a', error: new Error('boom') });
    await c.retryFailed();
    expect(agent.session.subagentHost.spawn).toHaveBeenCalledTimes(1);
    c.dispose();
  });

  it('ignores events for unknown subagentIds', () => {
    const agent = makeAgent();
    const c = new SwarmCoordinator('run-1', agent, new AbortController());
    emit(agent.handlers, 'subagent.completed', { subagentId: 'ghost', result: { status: 'completed' } });
    const p = c.getProgress();
    expect(p.total).toBe(0);
    c.dispose();
  });
});