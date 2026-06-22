import { describe, it, expect, vi } from 'vitest';

import { Session } from '../../src/session';
import { SwarmCoordinator } from '../../src/agent/swarm/coordinator';
import type { SwarmRunSnapshot } from '@moonshot-ai/protocol';
import type { AgentSwarmSpec } from '../../src/tools/builtin/collaboration/agent-swarm';

/**
 * End-to-end coverage for the swarm visibility pipeline.
 *
 * Phase 9 added `Session.recordSwarmRun` / `getSwarmRuns` (completed-run history).
 * Phase 10 added `Session.emitSwarmSnapshot` (in-flight fan-out), plus the
 * `SwarmCoordinator.emitSnapshot()` that fires on every member state change.
 * Phase 11 added per-member `currentToolCall` activity tracking.
 * Phase 12 closed the production wiring gap: `subagent-host` re-emits
 * child `tool.call.started` / `tool.result` events through
 * `session.orchestrationHooks` stamped with `subagentId`.
 *
 * Each layer is tested in isolation. This file exercises the *full* chain
 * end-to-end with real `Session` + real `OrchestrationHooks` + real
 * `SwarmCoordinator` — so a regression in any link surfaces here.
 *
 * Properties under test:
 *   1. `subagent.spawned` → coordinator records `memberBySubagentId` mapping.
 *   2. `tool.call.started` (with `subagentId`) → coordinator sets
 *      `currentToolCall` on the matching member, emits a snapshot, the
 *      snapshot flows through `Session.emitSwarmSnapshot`, the SDK-style
 *      `subscribeSwarmRuns` callback receives the snapshot.
 *   3. `tool.result` → coordinator clears `currentToolCall`, emits a
 *      snapshot.
 *   4. `coordinator.dispose()` → final snapshot has `completedAt` set;
 *      `Session.emitSwarmSnapshot` routes it through `recordSwarmRun`;
 *      `getSwarmRunHistory()` returns the summary.
 *   5. The subagent-host bridge re-emits a child `tool.call.started`
 *      through `orchestrationHooks` stamped with `subagentId` — proving
 *      the production chain works without `as unknown` casts.
 */

function makeSessionOptions(): ConstructorParameters<typeof Session>[0] {
  return {
    id: 'test-swarm-e2e',
    kaos: {
      name: 'noop',
      getcwd: () => '/tmp',
      withCwd: () => ({}) as never,
    } as never,
    homedir: process.cwd(),
    rpc: {
      emitEvent: () => Promise.resolve(),
      requestApproval: () => Promise.resolve({ decision: 'cancelled' as const }),
      requestQuestion: () => Promise.resolve(null),
      toolCall: () => Promise.resolve({ output: '', isError: true }),
    } as never,
  };
}

function makeSession() {
  const session = new Session(makeSessionOptions());
  // Session exposes `orchestrationHooks` but not `subagentHost` as a typed
  // field. For this E2E test we hand-build the structural shape the
  // coordinator expects. The subagent-host bridge is the production
  // owner of child event re-emission; we simulate it inline.
  const events: unknown[] = [];
  return {
    session,
    orchestrationHooks: session.orchestrationHooks,
    fireEvent(event: { type: string; payload: Record<string, unknown> }) {
      events.push(event);
      session.orchestrationHooks.emit(event as never);
    },
    events,
  };
}

describe('swarm pipeline end-to-end', () => {
  it('tool.call.started → coordinator currentToolCall → snapshot → Session cache', () => {
    const { session, fireEvent } = makeSession();

    // Subscribe to live snapshots the way SDK consumers do.
    const received: SwarmRunSnapshot[] = [];
    session.subscribeSwarmRuns((snapshot) => {
      received.push(snapshot);
    });

    // Create a coordinator wired to the Session's orchestrationHooks.
    const coordinator = new SwarmCoordinator(
      'run-e2e',
      { session, log: { warn: () => {} } } as never,
      new AbortController(),
      () => {},
    );
    coordinator.registerMember('alice', { description: 'alice' } as unknown as AgentSwarmSpec);
    coordinator.registerMember('bob', { description: 'bob' } as unknown as AgentSwarmSpec);

    // 1. subagent.spawned — coordinator records memberBySubagentId mapping.
    fireEvent({ type: 'subagent.spawned', payload: { subagentId: 'sub-1' } });
    // First snapshot reflects the mapping.
    expect(received.at(-1)?.members.find((m) => m.memberId === 'alice')).toBeDefined();
    expect(received.at(-1)?.members.find((m) => m.memberId === 'bob')).toBeDefined();

    // 2. subagent.started — alice transitions to running.
    fireEvent({ type: 'subagent.started', payload: { subagentId: 'sub-1' } });
    const running = received.at(-1);
    expect(running?.members.find((m) => m.memberId === 'alice')?.status).toBe('running');

    // 3. tool.call.started — Phase 12 produces this with subagentId set.
    fireEvent({
      type: 'tool.call.started',
      payload: {
        subagentId: 'sub-1',
        toolName: 'read_file',
        args: { file_path: '/Users/cheng/kimi-code/README.md' },
      },
    });
    const withActivity = received.at(-1);
    const alice = withActivity?.members.find((m) => m.memberId === 'alice');
    expect(alice?.currentToolCall?.toolName).toBe('read_file');
    expect(alice?.currentToolCall?.argsSummary).toBe('kimi-code/README.md');

    // 4. tool.result — currentToolCall clears.
    fireEvent({ type: 'tool.result', payload: { subagentId: 'sub-1' } });
    const cleared = received.at(-1);
    expect(cleared?.members.find((m) => m.memberId === 'alice')?.currentToolCall).toBeUndefined();

    // 5. dispose — final snapshot has completedAt; Session caches the summary.
    coordinator.dispose();
    const final = received.at(-1);
    expect(final?.completedAt).toBeTypeOf('number');

    const history = session.getSwarmRunHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.runId).toBe('run-e2e');
  });

  it('tool events for unknown subagentId are dropped silently', () => {
    const { session, fireEvent } = makeSession();
    const received: SwarmRunSnapshot[] = [];
    session.subscribeSwarmRuns((s) => received.push(s));

    const coordinator = new SwarmCoordinator(
      'run-no-unknown',
      { session, log: { warn: () => {} } } as never,
      new AbortController(),
      () => {},
    );
    coordinator.registerMember('alice', { description: 'alice' } as unknown as AgentSwarmSpec);

    fireEvent({
      type: 'tool.call.started',
      payload: { subagentId: 'sub-unknown', toolName: 'shell' },
    });
    coordinator.dispose();

    // No member got an activity entry; completedAt still set on the dispose snapshot.
    const allSnapshots = received;
    for (const snap of allSnapshots) {
      for (const member of snap.members) {
        expect(member.currentToolCall).toBeUndefined();
      }
    }
  });

  it('subagent-host bridge stamps subagentId on tool events', async () => {
    // This test uses the real `SubagentHost.attachChildToolEventBridge`
    // (Phase 12) instead of hand-rolling the orchestrationHooks event.
    // It proves the production wiring works without casts.
    const { SubagentHost } = await import('../../src/session/subagent-host');

    const { session } = makeSession();
    const host = new SubagentHost(session, 'parent');

    // Mock child rpc with onEvent + emit helpers.
    const childSubscribers: Array<(e: unknown) => void> = [];
    const childRpc = {
      onEvent: vi.fn((cb: (e: unknown) => void) => {
        childSubscribers.push(cb);
        return () => {
          const idx = childSubscribers.indexOf(cb);
          if (idx >= 0) childSubscribers.splice(idx, 1);
        };
      }),
      emit: vi.fn((e: unknown) => {
        for (const cb of childSubscribers) cb(e);
      }),
    };

    const unsubscribe = host.attachChildToolEventBridge(
      'sub-2',
      childRpc as never,
      session.orchestrationHooks,
    );

    const received: SwarmRunSnapshot[] = [];
    session.subscribeSwarmRuns((s) => received.push(s));

    // Spawn a coordinator and register a member, then route a child event
    // through the bridge. Without the bridge, the event would land at the
    // coordinator without subagentId; with the bridge, the coordinator's
    // memberBySubagentId mapping picks it up.
    const coordinator = new SwarmCoordinator(
      'run-bridge',
      { session, log: { warn: () => {} } } as never,
      new AbortController(),
      () => {},
    );
    coordinator.registerMember('alice', { description: 'alice' } as unknown as AgentSwarmSpec);

    // Tell the coordinator about the child.
    session.orchestrationHooks.emit({
      type: 'subagent.spawned',
      payload: { subagentId: 'sub-2' },
    } as never);

    // Now fire a tool event through the child rpc; the bridge re-emits
    // through orchestrationHooks stamped with subagentId='sub-2'.
    childRpc.emit({
      type: 'tool.call.started',
      toolName: 'shell',
      args: { command: 'ls' },
    });

    const last = received.at(-1);
    const alice = last?.members.find((m) => m.memberId === 'alice');
    expect(alice?.currentToolCall?.toolName).toBe('shell');
    expect(alice?.currentToolCall?.argsSummary).toBe('ls');

    unsubscribe();
    coordinator.dispose();
  });
});