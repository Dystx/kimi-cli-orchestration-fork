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

// `scoreSkills` now requires >= `minMessageTokens` (default 6) and
// >= `minOverlap` (default 2) distinct shared tokens to consider a skill
// a candidate. Test fixtures that don't pass those filters should pass
// `minMessageTokens: 0` and `minOverlap: 0` explicitly so they keep
// exercising the ranking logic in isolation.
const RELAXED = { minMessageTokens: 0, minOverlap: 0 } as const;

describe('scoreSkills', () => {
  it('ranks skills by token overlap against the message', () => {
    const skills = [
      skill({ name: 'a', metadata: { name: 'a', description: 'database migration helper' } }),
      skill({ name: 'b', metadata: { name: 'b', description: 'image generation utility' } }),
    ];
    const ranked = scoreSkills('migrate the production database today please', skills, {
      threshold: 0,
      ...RELAXED,
    });
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
    // Long enough message to clear `minMessageTokens`, low enough threshold
    // (and minOverlap: 0) to keep all three skills in the candidate pool.
    const ranked = scoreSkills('database migration and backup utility script', skills, {
      limit: 1,
      threshold: 0.1,
      minMessageTokens: 0,
      minOverlap: 0,
    });
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
    // Long enough message to clear `minMessageTokens`; minOverlap:0 keeps
    // both skills eligible so we can verify ranking order.
    const ranked = scoreSkills(
      'Please verify the quality after every code change in this repo',
      skills,
      { minMessageTokens: 0, minOverlap: 0 },
    );
    expect(ranked[0]!.skill.name).toBe('quality-gate');
  });

  it('returns empty array for empty input', () => {
    expect(scoreSkills('', [])).toEqual([]);
    expect(scoreSkills('hello world', [])).toEqual([]);
  });

  it('skips short messages that fall below minMessageTokens', () => {
    const skills = [
      skill({ name: 'a', metadata: { name: 'a', description: 'database migration helper' } }),
    ];
    // Default minMessageTokens=6; 'run lint' is 2 tokens.
    expect(scoreSkills('run lint', skills)).toEqual([]);
  });

  it('skips skills with fewer than minOverlap distinct shared tokens', () => {
    // Skill corpus has "run" + "lint"; message has only "run".
    // With default minOverlap=2 the skill is filtered out — it would
    // otherwise fire on a single coincidental overlap (e.g. "run").
    const skills = [
      skill({ name: 'linter', metadata: { name: 'linter', description: 'run lint on a file' } }),
    ];
    expect(scoreSkills('run the script', skills)).toEqual([]);
  });
});