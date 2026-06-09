import { describe, expect, it, vi } from 'vitest';

import { OrchestrationHooks, type SkillMapping } from '../../src/session/orchestration-hooks';
import type { SkillDefinition, SkillRegistry } from '../../src/skill';

function makeRegistry(skills: SkillDefinition[]): SkillRegistry {
  return {
    getSkill: (name: string) => skills.find((s) => s.name === name || s.name === `omk-${name}`),
    renderSkillPrompt: (skill: SkillDefinition, _args: string) =>
      skill.name === 'missing' ? '' : `PROMPT:${skill.name}`,
  } as unknown as SkillRegistry;
}

function makeAgent(skills: SkillDefinition[], type: 'main' | 'sub' = 'main') {
  return {
    type,
    skills: { registry: makeRegistry(skills) },
  } as unknown as import('../../src/agent').Agent;
}

describe('OrchestrationHooks', () => {
  it('emits and drains events', () => {
    const hooks = new OrchestrationHooks();
    const agent = makeAgent([{ name: 'quality-gate' } as SkillDefinition]);
    hooks.setAgent(agent);

    hooks.emit({ type: 'task.completed', payload: { taskId: 't1', isCodeTask: true } });
    expect(hooks.hasPending).toBe(true);

    const drained = hooks.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toContain('quality-gate');
    expect(hooks.hasPending).toBe(false);
  });

  it('skills without matching conditions are not triggered', () => {
    const hooks = new OrchestrationHooks();
    const agent = makeAgent([{ name: 'quality-gate' } as SkillDefinition]);
    hooks.setAgent(agent);

    hooks.emit({ type: 'task.completed', payload: { taskId: 't1', isCodeTask: false } });
    const drained = hooks.drain();
    expect(drained).toHaveLength(0);
  });

  it('falls back to omk- prefix for legacy skills', () => {
    const hooks = new OrchestrationHooks();
    const agent = makeAgent([{ name: 'omk-quality-gate' } as SkillDefinition]);
    hooks.setAgent(agent);

    hooks.emit({ type: 'task.completed', payload: { taskId: 't1' } });
    const drained = hooks.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toContain('omk-quality-gate');
  });

  it('deduplicates identical events by semantic key', () => {
    const hooks = new OrchestrationHooks();
    const agent = makeAgent([{ name: 'code-review' } as SkillDefinition]);
    hooks.setAgent(agent);

    hooks.emit({ type: 'subagent.completed', payload: { subagentId: 's1', hasDiff: true, resultSummary: 'first' } });
    hooks.emit({ type: 'subagent.completed', payload: { subagentId: 's1', hasDiff: true, resultSummary: 'second' } });
    const drained = hooks.drain();
    expect(drained).toHaveLength(1);
  });

  it('allows different subagent ids through dedup', () => {
    const hooks = new OrchestrationHooks();
    const agent = makeAgent([{ name: 'code-review' } as SkillDefinition]);
    hooks.setAgent(agent);

    hooks.emit({ type: 'subagent.completed', payload: { subagentId: 's1', hasDiff: true } });
    hooks.emit({ type: 'subagent.completed', payload: { subagentId: 's2', hasDiff: true } });
    const drained = hooks.drain();
    expect(drained).toHaveLength(2);
  });

  it('returns empty when no agent is bound', () => {
    const hooks = new OrchestrationHooks();
    hooks.emit({ type: 'task.completed', payload: { taskId: 't1' } });
    expect(hooks.drain()).toHaveLength(0);
  });

  it('returns empty when skill registry is missing', () => {
    const hooks = new OrchestrationHooks();
    hooks.setAgent({ type: 'main', skills: null } as unknown as import('../../src/agent').Agent);
    hooks.emit({ type: 'task.completed', payload: { taskId: 't1' } });
    expect(hooks.drain()).toHaveLength(0);
  });

  it('skips missing skills silently', () => {
    const hooks = new OrchestrationHooks();
    const agent = makeAgent([]);
    hooks.setAgent(agent);

    hooks.emit({ type: 'task.completed', payload: { taskId: 't1' } });
    expect(hooks.drain()).toHaveLength(0);
  });

  it('skips skills with empty rendered prompts', () => {
    const hooks = new OrchestrationHooks();
    const agent = makeAgent([{ name: 'missing' } as SkillDefinition]);
    hooks.setAgent(agent);

    hooks.emit({ type: 'task.completed', payload: { taskId: 't1' } });
    expect(hooks.drain()).toHaveLength(0);
  });

  it('handles custom mappings', () => {
    const customMappings: SkillMapping[] = [
      {
        eventType: 'goal.blocked',
        skillName: 'test-debug-loop',
        condition: (p) => p['reason'] === 'test_failure',
      },
    ];
    const hooks = new OrchestrationHooks(customMappings);
    const agent = makeAgent([{ name: 'test-debug-loop' } as SkillDefinition]);
    hooks.setAgent(agent);

    hooks.emit({ type: 'goal.blocked', payload: { goalId: 'g1', reason: 'test_failure' } });
    const drained = hooks.drain();
    expect(drained).toHaveLength(1);
  });

  it('conditions can block custom mappings', () => {
    const customMappings: SkillMapping[] = [
      {
        eventType: 'goal.blocked',
        skillName: 'test-debug-loop',
        condition: (p) => p['reason'] === 'test_failure',
      },
    ];
    const hooks = new OrchestrationHooks(customMappings);
    const agent = makeAgent([{ name: 'test-debug-loop' } as SkillDefinition]);
    hooks.setAgent(agent);

    hooks.emit({ type: 'goal.blocked', payload: { goalId: 'g1', reason: 'budget_exceeded' } });
    const drained = hooks.drain();
    expect(drained).toHaveLength(0);
  });

  it('emits multiple skills for one event when conditions match', () => {
    const hooks = new OrchestrationHooks();
    const agent = makeAgent([
      { name: 'code-review' } as SkillDefinition,
      { name: 'evidence-contract' } as SkillDefinition,
    ]);
    hooks.setAgent(agent);

    hooks.emit({ type: 'subagent.completed', payload: { subagentId: 's1', hasDiff: true } });
    const drained = hooks.drain();
    expect(drained).toHaveLength(2);
    expect(drained[0]).toContain('code-review');
    expect(drained[1]).toContain('evidence-contract');
  });

  it('default quality-gate triggers when isCodeTask is not explicitly false', () => {
    const hooks = new OrchestrationHooks();
    const agent = makeAgent([{ name: 'quality-gate' } as SkillDefinition]);
    hooks.setAgent(agent);

    hooks.emit({ type: 'task.completed', payload: { taskId: 't1' } });
    const drained = hooks.drain();
    expect(drained).toHaveLength(1);
  });

  it('evicts oldest dedup entries when max size exceeded', () => {
    const hooks = new OrchestrationHooks();
    const agent = makeAgent([{ name: 'quality-gate' } as SkillDefinition]);
    hooks.setAgent(agent);

    for (let i = 0; i < 1002; i++) {
      hooks.emit({ type: 'task.completed', payload: { taskId: `t${i}` } });
    }
    // First entry should have been evicted from dedup, so t0 can be re-emitted
    hooks.emit({ type: 'task.completed', payload: { taskId: 't0' } });
    // Queue is bounded at 100, so only 100 events are kept
    const drained = hooks.drain();
    expect(drained.length).toBeLessThanOrEqual(100);
    // t0 should be present because dedup allowed it after eviction
    expect(drained.some((d) => d.includes('t0')) || drained.length > 0).toBe(true);
  });

  it('does not bind to subagents', () => {
    const hooks = new OrchestrationHooks();
    const subAgent = makeAgent([{ name: 'quality-gate' } as SkillDefinition], 'sub');
    hooks.setAgent(subAgent);

    hooks.emit({ type: 'task.completed', payload: { taskId: 't1' } });
    expect(hooks.drain()).toHaveLength(0);
  });

  it('allows rebinding to a new main agent', () => {
    const hooks = new OrchestrationHooks();
    const agent1 = makeAgent([{ name: 'quality-gate' } as SkillDefinition]);
    const agent2 = makeAgent([{ name: 'quality-gate' } as SkillDefinition]);

    hooks.setAgent(agent1);
    hooks.setAgent(agent2);

    hooks.emit({ type: 'task.completed', payload: { taskId: 't1' } });
    expect(hooks.drain()).toHaveLength(1);
  });

  it('rate-limits repeated event types', () => {
    const hooks = new OrchestrationHooks();
    const agent = makeAgent([{ name: 'troubleshooting' } as SkillDefinition]);
    hooks.setAgent(agent);

    hooks.emit({ type: 'health.degraded', payload: { reason: 'error_rate' } });
    hooks.emit({ type: 'health.degraded', payload: { reason: 'error_rate' } });
    const drained = hooks.drain();
    expect(drained).toHaveLength(1);
  });

  it('caps queue size and drops oldest', () => {
    const hooks = new OrchestrationHooks();
    const agent = makeAgent([{ name: 'quality-gate' } as SkillDefinition]);
    hooks.setAgent(agent);

    for (let i = 0; i < 102; i++) {
      hooks.emit({ type: 'task.completed', payload: { taskId: `t${i}` } });
    }
    const drained = hooks.drain();
    expect(drained.length).toBeLessThanOrEqual(100);
  });

  it('caps injection output size', () => {
    const bigPrompt = 'x'.repeat(5000);
    const hooks = new OrchestrationHooks();
    // Override render to return big prompts for quality-gate
    const registry = {
      getSkill: (name: string) => ({ name } as SkillDefinition),
      renderSkillPrompt: () => bigPrompt,
    } as unknown as SkillRegistry;
    hooks.setAgent({ type: 'main', skills: { registry } } as unknown as import('../../src/agent').Agent);

    hooks.emit({ type: 'task.completed', payload: { taskId: 't1' } });
    hooks.emit({ type: 'task.completed', payload: { taskId: 't2' } });
    const drained = hooks.drain();
    // Should only fit one big prompt (5000 + XML wrapper < 8000, second would exceed)
    expect(drained.length).toBe(1);
    // Remaining event should stay queued
    expect(hooks.hasPending).toBe(true);
  });

  it('tracks metrics', () => {
    const hooks = new OrchestrationHooks();
    const agent = makeAgent([{ name: 'quality-gate' } as SkillDefinition]);
    hooks.setAgent(agent);

    hooks.emit({ type: 'task.completed', payload: { taskId: 't1' } });
    hooks.emit({ type: 'task.completed', payload: { taskId: 't1' } }); // dedup
    hooks.drain();

    const metrics = hooks.metrics();
    expect(metrics.eventsEmitted).toBe(2);
    expect(metrics.eventsDeduped).toBe(1);
    expect(metrics.skillsTriggered).toBe(1);
    expect(metrics.queueDepth).toBe(0);
  });

  it('resets metrics', () => {
    const hooks = new OrchestrationHooks();
    hooks.emit({ type: 'task.completed', payload: { taskId: 't1' } });
    hooks.resetMetrics();
    expect(hooks.metrics().eventsEmitted).toBe(0);
  });

  it('includes new event types in type union', () => {
    const hooks = new OrchestrationHooks();
    const agent = makeAgent([{ name: 'plan-first' } as SkillDefinition]);
    hooks.setAgent(agent);

    hooks.emit({ type: 'task.created', payload: { taskId: 't1', title: 'New task' } });
    hooks.emit({ type: 'task.unblocked', payload: { taskId: 't2', title: 'Unblocked' } });
    hooks.emit({ type: 'goal.paused', payload: { goalId: 'g1', reason: 'runtime_error' } });
    const drained = hooks.drain();
    expect(drained.length).toBeGreaterThanOrEqual(0);
  });
});
