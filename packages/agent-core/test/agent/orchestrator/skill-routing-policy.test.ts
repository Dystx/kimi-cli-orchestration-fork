import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SkillRoutingPolicy } from '../../../src/agent/orchestrator/skill-routing-policy';
import type { SkillDefinition } from '../../../src/skill/types';

function skill(name: string): SkillDefinition {
  return {
    name,
    metadata: { name, description: `${name} helper`, type: 'prompt', safe: true },
    body: '',
    source: { kind: 'project' },
    path: `/skills/${name}`,
  } as unknown as SkillDefinition;
}

function makeAgent(opts: {
  flagEnabled: boolean;
  skills?: readonly SkillDefinition[];
  history?: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
  activate?: ReturnType<typeof vi.fn>;
}) {
  const activate = opts.activate ?? vi.fn();
  return {
    skills: opts.skills !== undefined || opts.activate !== undefined
      ? {
          registry: {
            listInvocableSkills: () => opts.skills ?? [],
          },
          activate,
        }
      : null,
    experimentalFlags: {
      enabled: (id: string) => (id === 'skill_routing' ? opts.flagEnabled : false),
    },
    context: { history: opts.history ?? [] },
    log: { warn: vi.fn() },
    orchestrator: { recordError: vi.fn() } as never,
    config: { cwd: '/tmp' },
  } as never;
}

describe('SkillRoutingPolicy', () => {
  let activate: ReturnType<typeof vi.fn>;
  let skills: SkillDefinition[];
  let history: Array<{ role: string; content: Array<{ type: string; text: string }> }>;

  beforeEach(() => {
    activate = vi.fn();
    skills = [
      skill('database-helper'),
      skill('image-helper'),
    ];
    history = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'help me with the database migration' }],
      },
    ];
  });

  it('does nothing when the flag is disabled', async () => {
    const policy = new SkillRoutingPolicy(makeAgent({ flagEnabled: false, activate, skills, history }));
    const result = await policy.beforeStep({ turnId: 1, signal: new AbortController().signal });
    expect(result.injections).toEqual([]);
    expect(activate).not.toHaveBeenCalled();
  });

  it('does nothing when skills manager is missing', async () => {
    const agent = makeAgent({ flagEnabled: true, skills, history });
    (agent as { skills: null }).skills = null;
    const policy = new SkillRoutingPolicy(agent);
    const result = await policy.beforeStep({ turnId: 1, signal: new AbortController().signal });
    expect(result.injections).toEqual([]);
    expect(activate).not.toHaveBeenCalled();
  });

  it('activates matching skills with the auto-routed trigger', async () => {
    const policy = new SkillRoutingPolicy(makeAgent({ flagEnabled: true, activate, skills, history }));
    await policy.beforeStep({ turnId: 1, signal: new AbortController().signal });
    expect(activate).toHaveBeenCalled();
    const calledWith = activate.mock.calls[0]!;
    expect(calledWith[0]).toEqual({ name: 'database-helper', args: '' });
    expect(calledWith[1]).toBe('auto-routed');
  });

  it('does not re-activate the same skill twice', async () => {
    const policy = new SkillRoutingPolicy(makeAgent({ flagEnabled: true, activate, skills, history }));
    await policy.beforeStep({ turnId: 1, signal: new AbortController().signal });
    await policy.beforeStep({ turnId: 2, signal: new AbortController().signal });
    const databaseCalls = activate.mock.calls.filter((c) => c[0].name === 'database-helper');
    expect(databaseCalls.length).toBe(1);
  });

  it('re-evaluates after onContextCompacted', async () => {
    const policy = new SkillRoutingPolicy(makeAgent({ flagEnabled: true, activate, skills, history }));
    await policy.beforeStep({ turnId: 1, signal: new AbortController().signal });
    policy.onContextCompacted();
    await policy.beforeStep({ turnId: 2, signal: new AbortController().signal });
    const databaseCalls = activate.mock.calls.filter((c) => c[0].name === 'database-helper');
    expect(databaseCalls.length).toBe(1);
  });

  it('clears the activated set on onContextClear', async () => {
    const policy = new SkillRoutingPolicy(makeAgent({ flagEnabled: true, activate, skills, history }));
    await policy.beforeStep({ turnId: 1, signal: new AbortController().signal });
    policy.onContextClear();
    activate.mockClear();
    await policy.beforeStep({ turnId: 2, signal: new AbortController().signal });
    expect(activate).toHaveBeenCalledWith({ name: 'database-helper', args: '' }, 'auto-routed');
  });
});
