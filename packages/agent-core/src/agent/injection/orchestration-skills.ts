import { DynamicInjector } from './injector';
import type { OrchestrationHooks } from '../../session/orchestration-hooks';

/**
 * Injects auto-triggered orchestration skills into the agent context.
 * Runs every step and drains any pending events from OrchestrationHooks.
 * Also injects a rolling history of recent orchestration events.
 * Skill content is injected once per event batch and then cleared.
 */
export class OrchestrationSkillInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'orchestration_skills';

  constructor(
    agent: ConstructorParameters<typeof DynamicInjector>[0],
    private readonly hooks: OrchestrationHooks,
  ) {
    super(agent);
  }

  protected override getInjection(): string | undefined {
    const parts: string[] = [];

    // Rolling history of recent events
    const history = this.hooks.getRecentEvents(10);
    if (history.length > 0) {
      const historyLines = history.map((e) => {
        const id = e.payload['subagentId'] ?? e.payload['taskId'] ?? e.payload['goalId'] ?? e.payload['jobId'] ?? '';
        return `  [${e.type}]${id ? ` ${id}` : ''}`;
      });
      parts.push(`<orchestration-history>\nRecent events:\n${historyLines.join('\n')}\n</orchestration-history>`);
    }

    // Drain pending skill activations
    if (this.hooks.hasPending) {
      const injections = this.hooks.drain();
      if (injections.length > 0) {
        parts.push(...injections);
      }
    }

    // Reset per-turn tracking for next step
    this.hooks.resetTurn();

    if (parts.length === 0) return undefined;
    return parts.join('\n\n');
  }
}
