import type { PromptOrigin } from '../context/types';
import type { Agent } from '../index';
import type {
  OrchestrationPolicy,
  OrchestratorDiagnostics,
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
  private readonly diagnosticState = new Map<
    string,
    {
      fireCount: number;
      lastFiredAt?: number;
      lastError?: { message: string; at: number };
    }
  >();

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
      const handler = policy[phase];
      if (handler === undefined) {
        continue;
      }
      try {
        const result = await handler.call(policy, ctx);
        this.applyInjections(result);
        const state = this.diagnosticState.get(policy.name) ?? { fireCount: 0 };
        state.fireCount += 1;
        state.lastFiredAt = Date.now();
        this.diagnosticState.set(policy.name, state);
      } catch (error) {
        this.agent.log.warn('orchestrator policy failed', {
          policy: policy.name,
          phase,
          error,
        });
        this.recordError(policy.name, error);
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

  getDiagnostics(): OrchestratorDiagnostics {
    return {
      policies: this.policies.map((p) => {
        const state = this.diagnosticState.get(p.name);
        return {
          name: p.name,
          fireCount: state?.fireCount ?? 0,
          lastFiredAt: state?.lastFiredAt,
          lastError: state?.lastError,
        };
      }),
      totals: this.computeTotals(),
    };
  }

  private computeTotals(): { injections: number; errors: number } {
    let injections = 0;
    let errors = 0;
    for (const state of this.diagnosticState.values()) {
      injections += state.fireCount;
      if (state.lastError !== undefined) errors += 1;
    }
    return { injections, errors };
  }

  recordError(policyName: string, error: unknown): void {
    const state = this.diagnosticState.get(policyName) ?? { fireCount: 0 };
    state.lastError = {
      message: error instanceof Error ? error.message : String(error),
      at: Date.now(),
    };
    this.diagnosticState.set(policyName, state);
  }
}
