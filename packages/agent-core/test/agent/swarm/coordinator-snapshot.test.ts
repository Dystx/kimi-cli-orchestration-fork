import { describe, it, expect, vi } from 'vitest';
import { SwarmCoordinator } from '../../../src/agent/swarm/coordinator';
import type { AgentSwarmSpec } from '../../../src/tools/builtin/collaboration/agent-swarm';
import type { SwarmRunSnapshot } from '@moonshot-ai/protocol';

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
      emitSwarmSnapshot: vi.fn(),
    },
    log: { warn: vi.fn() },
  };
}

function fireEvent(
  agent: ReturnType<typeof makeAgent>,
  event: string,
  payload: unknown,
): void {
  agent.handlers.get(event)?.[0]?.({ type: event, payload });
}

describe('SwarmCoordinator emits snapshots on every member state change', () => {
  it('emits a snapshot when a member starts', () => {
    const agent = makeAgent();
    const c = new SwarmCoordinator('run-x', agent as never, new AbortController(), () => {});
    c.registerMember('a', spec('a'));
    c.registerMember('b', spec('b'));
    fireEvent(agent, 'subagent.started', { subagentId: 'a' });
    expect(agent.session.emitSwarmSnapshot).toHaveBeenCalled();
    const snap = agent.session.emitSwarmSnapshot.mock.calls[0]![0] as SwarmRunSnapshot;
    expect(snap.runId).toBe('run-x');
    expect(snap.totals.running).toBe(1);
    expect(snap.totals.queued).toBe(1);
  });

  it('emits a snapshot when a member completes', () => {
    const agent = makeAgent();
    const c = new SwarmCoordinator('run-y', agent as never, new AbortController(), () => {});
    c.registerMember('a', spec('a'));
    fireEvent(agent, 'subagent.started', { subagentId: 'a' });
    fireEvent(agent, 'subagent.completed', { subagentId: 'a', result: 'ok' });
    const lastSnap = agent.session.emitSwarmSnapshot.mock.calls.at(-1)![0] as SwarmRunSnapshot;
    expect(lastSnap.totals.completed).toBe(1);
    expect(lastSnap.totals.running).toBe(0);
  });

  it('emits a final snapshot with completedAt set on dispose', () => {
    const agent = makeAgent();
    const c = new SwarmCoordinator('run-z', agent as never, new AbortController(), () => {});
    c.registerMember('a', spec('a'));
    c.registerMember('b', spec('b'));
    fireEvent(agent, 'subagent.started', { subagentId: 'a' });
    fireEvent(agent, 'subagent.completed', { subagentId: 'a', result: 'ok' });
    c.dispose();
    const finalSnap = agent.session.emitSwarmSnapshot.mock.calls.at(-1)![0] as SwarmRunSnapshot;
    expect(finalSnap.completedAt).toBeTypeOf('number');
    expect(finalSnap.totals.completed).toBe(1);
  });
});
