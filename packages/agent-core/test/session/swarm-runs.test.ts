import { describe, it, expect } from 'vitest';

import { Session } from '../../src/session';
import type { SwarmRunSummary } from '../../src/session';

function makeSessionOptions(): ConstructorParameters<typeof Session>[0] {
  // The `Session` constructor only needs the minimum viable option set to
  // expose `recordSwarmRun` / `getSwarmRuns`. Reuse the same fake-RPC
  // pattern as the other Session-level tests so the harness matches
  // production wiring without dragging in MCP or skills loading.
  return {
    id: 'test-swarm-runs',
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

describe('Session swarm runs', () => {
  function makeSummary(overrides: Partial<SwarmRunSummary> = {}): SwarmRunSummary {
    return {
      runId: 'run-1',
      startedAt: 1_000,
      completedAt: 2_000,
      memberCount: 3,
      cancelledCount: 0,
      failedCount: 0,
      completedCount: 3,
      errorCount: 0,
      ...overrides,
    };
  }

  it('records and returns a single run', () => {
    const session = new Session(makeSessionOptions());
    session.recordSwarmRun(makeSummary());
    expect(session.getSwarmRuns()).toEqual([makeSummary()]);
  });

  it('returns runs sorted by startedAt desc', () => {
    const session = new Session(makeSessionOptions());
    session.recordSwarmRun(makeSummary({ runId: 'old', startedAt: 1_000 }));
    session.recordSwarmRun(makeSummary({ runId: 'new', startedAt: 5_000 }));
    session.recordSwarmRun(makeSummary({ runId: 'mid', startedAt: 3_000 }));
    expect(session.getSwarmRuns().map((r) => r.runId)).toEqual(['new', 'mid', 'old']);
  });

  it('overwrites a run with the same id', () => {
    const session = new Session(makeSessionOptions());
    session.recordSwarmRun(makeSummary({ runId: 'a', startedAt: 1_000 }));
    session.recordSwarmRun(makeSummary({ runId: 'a', startedAt: 1_000, completedCount: 5 }));
    expect(session.getSwarmRuns()).toHaveLength(1);
    expect(session.getSwarmRuns()[0]!.completedCount).toBe(5);
  });
});