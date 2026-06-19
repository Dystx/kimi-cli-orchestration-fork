import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '#/agent/orchestrator/index';
import type { Agent } from '#/agent';
import type { OrchestrationPolicy } from '#/agent/orchestrator/types';

function makeMockAgent(): Agent {
  return {
    context: { appendSystemReminder: vi.fn() },
    log: { warn: vi.fn(), error: vi.fn() },
  } as unknown as Agent;
}

describe('Orchestrator', () => {
  it('runs a policy and appends its injections', async () => {
    const agent = makeMockAgent();
    const orchestrator = new Orchestrator(agent);
    const origin = { kind: 'injection' as const, variant: 'test' };
    const policy: OrchestrationPolicy = {
      name: 'test',
      beforeStep: async () => ({ injections: [{ content: 'hello', origin }] }),
    };
    orchestrator.registerPolicy(policy);
    await orchestrator.beforeStep({ turnId: 1, signal: new AbortController().signal });
    expect(agent.context.appendSystemReminder).toHaveBeenCalledWith('hello', origin);
  });
});
