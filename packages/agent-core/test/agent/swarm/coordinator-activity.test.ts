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

function fireEvent(agent: ReturnType<typeof makeAgent>, event: string, payload: unknown): void {
  agent.handlers.get(event)?.[0]?.({ type: event, payload });
}

describe('SwarmCoordinator tracks per-member tool-call activity', () => {
  it('sets currentToolCall on tool.call.started for a tracked member', () => {
    const agent = makeAgent();
    const c = new SwarmCoordinator('run-x', agent as never, new AbortController(), () => {});
    c.registerMember('alice', spec('alice'));
    fireEvent(agent, 'subagent.spawned', { subagentId: 'sub-1', agentId: 'main' });
    fireEvent(agent, 'subagent.started', { subagentId: 'sub-1' });
    fireEvent(agent, 'tool.call.started', { subagentId: 'sub-1', toolName: 'read_file', args: { file_path: '/Users/cheng/kimi-code/README.md' } });
    const snap = agent.session.emitSwarmSnapshot.mock.calls.at(-1)![0] as SwarmRunSnapshot;
    const alice = snap.members.find((m) => m.memberId === 'alice');
    expect(alice?.currentToolCall?.toolName).toBe('read_file');
    expect(alice?.currentToolCall?.argsSummary).toBe('kimi-code/README.md');
  });

  it('clears currentToolCall on tool.result', () => {
    const agent = makeAgent();
    const c = new SwarmCoordinator('run-y', agent as never, new AbortController(), () => {});
    c.registerMember('alice', spec('alice'));
    fireEvent(agent, 'subagent.spawned', { subagentId: 'sub-1', agentId: 'main' });
    fireEvent(agent, 'subagent.started', { subagentId: 'sub-1' });
    fireEvent(agent, 'tool.call.started', { subagentId: 'sub-1', toolName: 'shell', args: { command: 'ls' } });
    fireEvent(agent, 'tool.result', { subagentId: 'sub-1' });
    const snap = agent.session.emitSwarmSnapshot.mock.calls.at(-1)![0] as SwarmRunSnapshot;
    const alice = snap.members.find((m) => m.memberId === 'alice');
    expect(alice?.currentToolCall).toBeUndefined();
  });

  it('ignores tool events for unknown subagentId', () => {
    const agent = makeAgent();
    const c = new SwarmCoordinator('run-z', agent as never, new AbortController(), () => {});
    c.registerMember('alice', spec('alice'));
    fireEvent(agent, 'tool.call.started', { subagentId: 'sub-unknown', toolName: 'shell', args: { command: 'ls' } });
    // No snapshot emit (only registered events emit). With unknown subagent,
    // no memberId lookup succeeds, so no member's currentToolCall is touched.
    for (const [arg] of agent.session.emitSwarmSnapshot.mock.calls) {
      const s = arg as SwarmRunSnapshot;
      for (const m of s.members) {
        expect(m.currentToolCall).toBeUndefined();
      }
    }
  });
});
