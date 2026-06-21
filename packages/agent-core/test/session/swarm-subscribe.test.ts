import { describe, it, expect, vi } from 'vitest';

import { Session } from '../../src/session';
import type { SwarmRunSnapshot } from '@moonshot-ai/protocol';

function makeSessionOptions(): ConstructorParameters<typeof Session>[0] {
  // Reuse the same minimal fake-RPC harness as the Phase 9 `swarm-runs.test.ts`
  // — only the constructor dependencies are exercised here, no MCP / skills.
  return {
    id: 'test-swarm-subscribe',
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

function makeSnapshot(overrides: Partial<SwarmRunSnapshot> = {}): SwarmRunSnapshot {
  return {
    runId: 'run-1',
    startedAt: 1_000,
    memberCount: 2,
    members: [
      { memberId: 'a', status: 'queued' },
      { memberId: 'b', status: 'queued' },
    ],
    totals: { queued: 2, running: 0, completed: 0, failed: 0, cancelled: 0 },
    ...overrides,
  };
}

describe('Session swarm subscribe API', () => {
  it('fires callback on every emit', () => {
    const session = new Session(makeSessionOptions());
    const cb = vi.fn();
    session.subscribeSwarmRuns(cb);
    const snap = makeSnapshot();
    session.emitSwarmSnapshot(snap);
    expect(cb).toHaveBeenCalledWith(snap);
  });

  it('unsubscribe stops further emissions', () => {
    const session = new Session(makeSessionOptions());
    const cb = vi.fn();
    const unsub = session.subscribeSwarmRuns(cb);
    unsub();
    session.emitSwarmSnapshot(makeSnapshot());
    expect(cb).not.toHaveBeenCalled();
  });

  it('isolates subscriber errors', () => {
    const session = new Session(makeSessionOptions());
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    session.subscribeSwarmRuns(bad);
    session.subscribeSwarmRuns(good);
    session.emitSwarmSnapshot(makeSnapshot());
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });

  it('getActiveSwarmRun returns the snapshot during the run', () => {
    const session = new Session(makeSessionOptions());
    session.emitSwarmSnapshot(makeSnapshot({ runId: 'r1' }));
    session.emitSwarmSnapshot(makeSnapshot({ runId: 'r2', startedAt: 2_000 }));
    const active = session.getActiveSwarmRun();
    expect(active?.runId).toBe('r2');
  });

  it('getActiveSwarmRun returns undefined after dispose (completedAt set)', () => {
    const session = new Session(makeSessionOptions());
    session.emitSwarmSnapshot(makeSnapshot({ completedAt: 5_000 }));
    expect(session.getActiveSwarmRun()).toBeUndefined();
  });

  it('getSwarmRunHistory returns completed runs sorted desc', () => {
    const session = new Session(makeSessionOptions());
    session.emitSwarmSnapshot(makeSnapshot({ runId: 'a', startedAt: 1_000, completedAt: 2_000 }));
    session.emitSwarmSnapshot(makeSnapshot({ runId: 'b', startedAt: 3_000, completedAt: 4_000 }));
    const history = session.getSwarmRunHistory();
    expect(history.map((r) => r.runId)).toEqual(['b', 'a']);
  });
});
