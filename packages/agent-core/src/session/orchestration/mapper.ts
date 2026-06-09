import type { OrchestrationEvent, OrchestrationMappingConfig, SkillMapping } from './types';

/** Predefined condition functions for config-based mappings. */
const CONDITION_REGISTRY: Record<string, (payload: Record<string, unknown>) => boolean> = {
  hasDiff: (p) => (p['hasDiff'] as boolean | undefined) ?? false,
  isCodeTask: (p) => p['isCodeTask'] !== false,
  testFailure: (p) => p['reason'] === 'test_failure',
  runtimeError: (p) => p['reason'] === 'runtime_error',
  goalActive: (p) => p['hasActiveGoal'] === true,
  taskCountGt2: (p) =>
    ((p['taskCount'] as number | undefined) ?? 0) > 2 ||
    ((p['totalTaskCount'] as number | undefined) ?? 0) > 2,
};

/**
 * Default skill mappings for coding orchestration.
 * These are checked at runtime against the SkillRegistry — missing skills
 * are silently skipped so the system degrades gracefully.
 */
export const DEFAULT_SKILL_MAPPINGS: readonly SkillMapping[] = [
  {
    eventType: 'task.completed',
    skillName: 'quality-gate',
    condition: (p) => p['isCodeTask'] !== false,
    priority: 2,
  },
  {
    eventType: 'subagent.completed',
    skillName: 'code-review',
    condition: (p) => (p['hasDiff'] as boolean | undefined) ?? false,
    priority: 3,
  },
  {
    eventType: 'goal.started',
    skillName: 'plan-first',
    condition: (p) => ((p['taskCount'] as number | undefined) ?? 0) > 2,
    priority: 1,
  },
  {
    eventType: 'health.degraded',
    skillName: 'troubleshooting',
    priority: 0,
  },
  {
    eventType: 'subagent.completed',
    skillName: 'evidence-contract',
    condition: (p) => (p['hasDiff'] as boolean | undefined) ?? false,
    priority: 3,
  },
  {
    eventType: 'goal.blocked',
    skillName: 'test-debug-loop',
    condition: (p) => p['reason'] === 'test_failure',
    priority: 0,
  },
  {
    eventType: 'goal.paused',
    skillName: 'troubleshooting',
    condition: (p) => p['reason'] === 'runtime_error',
    priority: 0,
  },
  {
    eventType: 'task.created',
    skillName: 'plan-first',
    condition: (p) =>
      p['hasActiveGoal'] === true && ((p['totalTaskCount'] as number | undefined) ?? 0) > 2,
    priority: 1,
  },
];

/**
 * Build SkillMapping array from user config. Falls back to DEFAULT_SKILL_MAPPINGS
 * when config provides no mappings.
 */
export function buildMappingsFromConfig(
  mappings: OrchestrationMappingConfig[] | undefined,
): readonly SkillMapping[] {
  if (mappings === undefined || mappings.length === 0) {
    return DEFAULT_SKILL_MAPPINGS;
  }
  return mappings.map((m) => ({
    eventType: m.event as OrchestrationEvent['type'],
    skillName: m.skill,
    condition: m.condition ? CONDITION_REGISTRY[m.condition] : undefined,
    priority: m.priority,
  }));
}
