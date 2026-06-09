/**
 * OrchestrationContext groups fork-specific session managers and callbacks
 * into a single interface.  This reduces AgentOptions/Agent constructor churn
 * during upstream merges — instead of adding N new optional fields to
 * AgentOptions, fork-specific subsystems are passed as one cohesive context.
 */

import type { SessionCostTracker } from './cost-tracker';
import type { SubagentResultCache } from './subagent-cache';
import type { SessionHealthMonitor } from './health-monitor';
import type { SessionMessageBus } from './message-bus';
import type { SessionSharedStore } from './shared-store';
import type { SessionOutcomeTracker } from './outcome-tracker';
import type { SessionLearningEngine } from './learning-engine';
import type { MemoryStore } from './memory-store';
import type { OrchestrationHooks } from './orchestration-hooks';
import type { SessionTaskRegistry } from './task-registry';
import type { SessionFileLock } from './file-lock';

export interface OrchestrationContext {
  readonly messageBus?: SessionMessageBus;
  readonly sharedStore?: SessionSharedStore;
  readonly costTracker?: SessionCostTracker;
  readonly subagentCache?: SubagentResultCache;
  readonly healthMonitor?: SessionHealthMonitor;
  readonly outcomeTracker?: SessionOutcomeTracker;
  readonly learningEngine?: SessionLearningEngine;
  readonly memoryStore?: MemoryStore;
  readonly orchestrationHooks?: OrchestrationHooks;
  readonly taskRegistry?: SessionTaskRegistry;
  readonly fileLock?: SessionFileLock;
  readonly onTurnEnded?:
    | ((turnId: number, durationMs: number, steps: number, failed: boolean) => void)
    | undefined;
  readonly onToolExecuted?:
    | ((toolName: string, isError: boolean, durationMs?: number) => void)
    | undefined;
  readonly onSubagentCompleted?:
    | ((
        profileName: string,
        isError: boolean,
        options: {
          tokenUsage?: { input: number; output: number };
          durationMs?: number;
          fallbackUsed?: boolean;
          cached?: boolean;
        },
      ) => void)
    | undefined;
}
