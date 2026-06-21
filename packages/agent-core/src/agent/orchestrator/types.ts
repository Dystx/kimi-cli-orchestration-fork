import type { OrchestratorDiagnostics, PolicyDiagnostic } from '@moonshot-ai/protocol';
import type { PromptOrigin } from '../context/types';

export type { OrchestratorDiagnostics, PolicyDiagnostic };

export interface TurnContext {
  readonly turnId: number;
  readonly signal: AbortSignal;
}

export interface OrchestratorInjection {
  readonly content: string;
  readonly origin?: PromptOrigin | undefined;
}

export interface OrchestratorResult {
  /** System reminders to prepend to the model context for this step. */
  readonly injections: readonly OrchestratorInjection[];
}

export interface OrchestrationPolicy {
  readonly name: string;
  beforeStep(ctx: TurnContext): Promise<OrchestratorResult> | OrchestratorResult;
  afterStep?(ctx: TurnContext): Promise<OrchestratorResult> | OrchestratorResult;
}
