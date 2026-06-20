import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '../../../src/agent/orchestrator';
import type { OrchestrationPolicy, OrchestratorResult, TurnContext } from '../../../src/agent/orchestrator/types';
import type { Agent } from '../../../src/agent';

function makeMockAgent(): Agent {
  return {
    context: { appendSystemReminder: vi.fn() },
    log: { warn: vi.fn(), error: vi.fn() },
  } as unknown as Agent;
}

function makePolicy(name: string, behavior?: { throw?: boolean }): OrchestrationPolicy {
  return {
    name,
    async beforeStep(_ctx: TurnContext): Promise<OrchestratorResult> {
      if (behavior?.throw === true) {
        throw new Error(`${name} boom`);
      }
      return { injections: [] };
    },
  };
}

describe('Orchestrator.getDiagnostics', () => {
  it('returns empty state when no policies are registered', () => {
    const o = new Orchestrator(makeMockAgent());
    const diag = o.getDiagnostics();
    expect(diag.policies).toEqual([]);
    expect(diag.totals.injections).toBe(0);
    expect(diag.totals.errors).toBe(0);
  });

  it('returns policies with zero fireCount after construction', () => {
    const o = new Orchestrator(makeMockAgent());
    o.registerPolicy(makePolicy('plan-tracking'));
    o.registerPolicy(makePolicy('memory-policy'));
    const diag = o.getDiagnostics();
    expect(diag.policies.map((p) => p.name)).toEqual(['plan-tracking', 'memory-policy']);
    expect(diag.policies.every((p) => p.fireCount === 0)).toBe(true);
    expect(diag.policies.every((p) => p.lastFiredAt === undefined)).toBe(true);
  });

  it('increments fireCount and sets lastFiredAt on successful beforeStep', async () => {
    const o = new Orchestrator(makeMockAgent());
    o.registerPolicy(makePolicy('p1'));
    const ctx = { turnId: 1, signal: new AbortController().signal };
    await o.beforeStep(ctx);
    const diag = o.getDiagnostics();
    const p = diag.policies[0]!;
    expect(p.fireCount).toBe(1);
    expect(p.lastFiredAt).toBeTypeOf('number');
    expect(p.lastError).toBeUndefined();
    expect(diag.totals.injections).toBe(1);
  });

  it('captures lastError but does not increment fireCount on failure', async () => {
    const o = new Orchestrator(makeMockAgent());
    o.registerPolicy(makePolicy('bad', { throw: true }));
    const ctx = { turnId: 1, signal: new AbortController().signal };
    await o.beforeStep(ctx);
    const diag = o.getDiagnostics();
    const p = diag.policies[0]!;
    expect(p.fireCount).toBe(0);
    expect(p.lastError).toBeDefined();
    expect(p.lastError!.message).toBe('bad boom');
    expect(diag.totals.errors).toBe(1);
  });

  it('recordError populates lastError without throwing', () => {
    const o = new Orchestrator(makeMockAgent());
    o.registerPolicy(makePolicy('p1'));
    o.recordError('p1', new Error('manual'));
    const diag = o.getDiagnostics();
    expect(diag.policies[0]!.lastError?.message).toBe('manual');
  });
});