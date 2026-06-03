import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { SessionCostTracker } from '../../../session/cost-tracker';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export const SetCostBudgetInputSchema = z.object({
  max_dollars: z.number().positive().describe('Maximum estimated API spend for this session in USD'),
  warn_at_fraction: z
    .number()
    .min(0.1)
    .max(0.99)
    .optional()
    .describe('Fraction of budget at which to emit a warning (default 0.8)'),
});

export type SetCostBudgetInput = z.infer<typeof SetCostBudgetInputSchema>;

export class SetCostBudgetTool implements BuiltinTool<SetCostBudgetInput> {
  readonly name = 'SetCostBudget' as const;
  readonly description =
    'Set a session-level API cost budget in USD. When the budget is approached or exceeded, the system emits warnings. Use this to prevent runaway spend from iterative subagent work.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SetCostBudgetInputSchema);

  constructor(private readonly tracker: SessionCostTracker) {}

  resolveExecution(args: SetCostBudgetInput): ToolExecution {
    return {
      description: `Setting cost budget: $${args.max_dollars.toFixed(2)}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private execution(args: SetCostBudgetInput): Promise<ExecutableToolResult> {
    this.tracker.setBudget({
      maxDollars: args.max_dollars,
      warnAtFraction: args.warn_at_fraction,
    });
    return Promise.resolve({
      output: `Session cost budget set to $${args.max_dollars.toFixed(2)}${args.warn_at_fraction !== undefined ? ` with warning at ${Math.round(args.warn_at_fraction * 100)}%` : ''}.`,
    });
  }
}
