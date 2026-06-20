import type { PromptOrigin } from '../context/types';

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

export interface PolicyDiagnostic {
  readonly name: string;
  readonly fireCount: number;
  readonly lastFiredAt?: number;
  readonly lastError?: { readonly message: string; readonly at: number };
}

export interface OrchestratorDiagnostics {
  readonly policies: readonly PolicyDiagnostic[];
  readonly totals: { readonly injections: number; readonly errors: number };
}
