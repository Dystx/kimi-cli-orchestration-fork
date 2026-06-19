import { describe, it, expect } from 'vitest';
import { scoreSkills } from '../../../src/agent/orchestrator/skill-router';
import type { SkillDefinition } from '../../../src/skill/types';

function skill(overrides: Partial<SkillDefinition> & { name: string }): SkillDefinition {
  return {
    metadata: {
      name: overrides.name,
      description: overrides.metadata?.description ?? '',
      type: 'prompt',
      safe: true,
      ...overrides.metadata,
    },
    body: '',
    source: { kind: 'project' },
    path: `/skills/${overrides.name}`,
    ...overrides,
  } as SkillDefinition;
}

describe('scoreSkills', () => {
  it('ranks skills by token overlap against the message', () => {
    const skills = [
      skill({ name: 'a', metadata: { name: 'a', description: 'database migration helper' } }),
      skill({ name: 'b', metadata: { name: 'b', description: 'image generation utility' } }),
    ];
    const ranked = scoreSkills('migrate the production database', skills, { threshold: 0 });
    expect(ranked.length).toBe(2);
    expect(ranked[0]!.skill.name).toBe('a');
    expect(ranked[1]!.skill.name).toBe('b');
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it('excludes skills with disableModelInvocation true', () => {
    const skills = [
      skill({
        name: 'hidden',
        metadata: { name: 'hidden', description: 'database helper', disableModelInvocation: true },
      }),
    ];
    expect(scoreSkills('database', skills)).toEqual([]);
  });

  it('respects limit and threshold options', () => {
    const skills = [
      skill({ name: 'a', metadata: { name: 'a', description: 'database migration' } }),
      skill({ name: 'b', metadata: { name: 'b', description: 'database backup' } }),
      skill({ name: 'c', metadata: { name: 'c', description: 'image generation' } }),
    ];
    const ranked = scoreSkills('database', skills, { limit: 1, threshold: 0.1 });
    expect(ranked.length).toBe(1);
    expect(ranked[0]!.skill.name).toMatch(/a|b/);
  });

  it('includes whenToUse in the candidate corpus', () => {
    const skills = [
      skill({
        name: 'quality-gate',
        metadata: {
          name: 'quality-gate',
          description: 'Run static analysis',
          whenToUse: 'After every code change to verify quality',
        },
      }),
      skill({ name: 'unrelated', metadata: { name: 'unrelated', description: 'Image processing' } }),
    ];
    const ranked = scoreSkills('verify quality', skills);
    expect(ranked[0]!.skill.name).toBe('quality-gate');
  });

  it('returns empty array for empty input', () => {
    expect(scoreSkills('', [])).toEqual([]);
    expect(scoreSkills('hello world', [])).toEqual([]);
  });
});
