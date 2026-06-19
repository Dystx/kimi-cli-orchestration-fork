import type { PromptOrigin } from '../context/types';
import type { Agent } from '../index';
import type {
  OrchestrationPolicy,
  OrchestratorInjection,
  OrchestratorResult,
  TurnContext,
} from './types';

const ORCHESTRATOR_ORIGIN: PromptOrigin = {
  kind: 'injection',
  variant: 'orchestrator',
};

export class Orchestrator {
  private readonly agent: Agent;
  private readonly policies: OrchestrationPolicy[] = [];

  constructor(agent: Agent) {
    this.agent = agent;
  }

  registerPolicy(policy: OrchestrationPolicy): void {
    this.policies.push(policy);
  }

  async beforeStep(ctx: TurnContext): Promise<void> {
    await this.runPolicies(ctx, 'beforeStep');
  }

  async afterStep(ctx: TurnContext): Promise<void> {
    await this.runPolicies(ctx, 'afterStep');
  }

  private async runPolicies(
    ctx: TurnContext,
    phase: 'beforeStep' | 'afterStep',
  ): Promise<void> {
    for (const policy of this.policies) {
      try {
        const handler = policy[phase];
        if (handler === undefined) {
          continue;
        }
        const result = await handler.call(policy, ctx);
        this.applyInjections(result);
      } catch (error) {
        this.agent.log.warn('orchestrator policy failed', {
          policy: policy.name,
          phase,
          error,
        });
      }
    }
  }

  private applyInjections(result: OrchestratorResult): void {
    for (const injection of result.injections) {
      this.appendInjection(injection);
    }
  }

  private appendInjection(injection: OrchestratorInjection): void {
    this.agent.context.appendSystemReminder(
      injection.content,
      injection.origin ?? ORCHESTRATOR_ORIGIN,
    );
  }

  notifyContextCompacted(): void {
    for (const policy of this.policies) {
      try {
        const hook = (policy as { onContextCompacted?: () => void }).onContextCompacted;
        if (hook !== undefined) hook.call(policy);
      } catch (error) {
        this.agent.log.warn('orchestrator policy failed', {
          policy: policy.name,
          phase: 'notifyContextCompacted',
          error,
        });
      }
    }
  }

  notifyContextClear(): void {
    for (const policy of this.policies) {
      try {
        const hook = (policy as { onContextClear?: () => void }).onContextClear;
        if (hook !== undefined) hook.call(policy);
      } catch (error) {
        this.agent.log.warn('orchestrator policy failed', {
          policy: policy.name,
          phase: 'notifyContextClear',
          error,
        });
      }
    }
  }
}
