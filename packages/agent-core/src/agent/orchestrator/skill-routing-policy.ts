import type { Agent } from '../index';
import { scoreSkills } from './skill-router';
import type { OrchestrationPolicy, OrchestratorResult, TurnContext } from './types';

export class SkillRoutingPolicy implements OrchestrationPolicy {
  readonly name = 'skill-routing';
  private readonly autoActivated: Set<string> = new Set();
  private pendingReevaluate = false;
  private lastScoredMessage: string | null = null;

  constructor(private readonly agent: Agent) {}

  async beforeStep(_ctx: TurnContext): Promise<OrchestratorResult> {
    if (!this.agent.experimentalFlags.enabled('skill_routing')) {
      return { injections: [] };
    }
    if (this.agent.skills === null) {
      return { injections: [] };
    }

    const message = this.getLastUserMessage();
    if (message === null || message.length === 0) {
      return { injections: [] };
    }

    const messageChanged = message !== this.lastScoredMessage;
    if (!messageChanged && !this.pendingReevaluate) {
      return { injections: [] };
    }
    this.lastScoredMessage = message;
    this.pendingReevaluate = false;

    const candidates = scoreSkills(message, this.agent.skills.registry.listInvocableSkills());
    for (const candidate of candidates) {
      if (this.autoActivated.has(candidate.skill.name)) continue;
      try {
        this.agent.skills.activate({ name: candidate.skill.name, args: '' }, 'auto-routed');
        this.autoActivated.add(candidate.skill.name);
      } catch (error) {
        this.agent.log.warn('SkillRoutingPolicy activate failed', {
          skill: candidate.skill.name,
          error,
        });
      }
    }

    return { injections: [] };
  }

  onContextCompacted(): void {
    this.pendingReevaluate = true;
  }

  onContextClear(): void {
    this.autoActivated.clear();
    this.pendingReevaluate = false;
    this.lastScoredMessage = null;
  }

  private getLastUserMessage(): string | null {
    const history = this.agent.context.history;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const msg = history[i];
      if (msg?.role === 'user') {
        const text = msg.content
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join(' ');
        return text;
      }
    }
    return null;
  }
}
