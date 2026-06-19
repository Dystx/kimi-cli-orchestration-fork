import type { PromptOrigin } from '../context/types';

export interface TurnContext {
  turnId: number;
  signal: AbortSignal;
}

export interface OrchestratorResult {
  injections: Array<{ content: string; origin?: PromptOrigin }>;
}

export interface OrchestrationPolicy {
  readonly name: string;
  beforeStep(ctx: TurnContext): Promise<OrchestratorResult> | OrchestratorResult;
  afterStep?(ctx: TurnContext): Promise<OrchestratorResult> | OrchestratorResult;
}
