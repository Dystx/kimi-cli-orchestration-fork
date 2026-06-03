/**
 * GetSessionHealth — returns current session health metrics.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { SessionHealthMonitor } from '../../../session/health-monitor';

export const GetSessionHealthInputSchema = z.object({
  window_minutes: z
    .number()
    .int()
    .min(1)
    .max(60)
    .optional()
    .describe('Lookback window in minutes for burn-rate and turn averages. Defaults to 5.'),
});

export type GetSessionHealthInput = z.infer<typeof GetSessionHealthInputSchema>;

export class GetSessionHealthTool implements BuiltinTool<GetSessionHealthInput> {
  readonly name = 'GetSessionHealth';
  readonly description =
    'Returns current session health metrics: token burn rate, average turn duration, steps per turn, error rate, and a recommendation. Use this to diagnose runaway token usage, slow turns, or elevated error rates.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GetSessionHealthInputSchema);

  constructor(private readonly monitor: SessionHealthMonitor) {}

  resolveExecution(_args: GetSessionHealthInput): ToolExecution {
    return {
      description: 'Getting session health metrics',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(),
    };
  }

  private execution(): Promise<ExecutableToolResult> {
    const snapshot = this.monitor.snapshot();
    const recommendation = this.monitor.recommendation(snapshot);

    const lines = [
      'Session Health Metrics',
      '======================',
      '',
      `Token burn rate: ${snapshot.tokenBurnRatePerMin} tokens/min (last ${snapshot.windowMinutes} min)`,
      `Avg turn duration: ${snapshot.avgTurnDurationMs} ms`,
      `Avg steps per turn: ${snapshot.avgStepsPerTurn}`,
      `Error rate: ${Math.round(snapshot.errorRate * 100)}% (${snapshot.totalErrors}/${snapshot.totalTurns} turns)`,
      '',
      'Recommendation:',
      recommendation,
    ];

    return Promise.resolve({ output: lines.join('\n') });
  }
}
