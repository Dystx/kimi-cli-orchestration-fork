/**
 * Diagnostics report line builder for `/diag`.
 *
 * Renders orchestrator-policy diagnostics and recent swarm-run summaries in a
 * compact text format suitable for `UsagePanelComponent`. Mirrors the visual
 * language of the status panel but stays decoupled from the runtime-status
 * fields that `/status` already covers.
 */

import type { SessionStatusSnapshot } from '@moonshot-ai/kimi-code-sdk';

// `OrchestratorDiagnostics` is part of `SessionStatusSnapshot.orchestrator` in
// the protocol; the SDK does not yet re-export the named type, so derive it
// from the snapshot field that the TUI already consumes.
export type OrchestratorDiagnosticsShape = NonNullable<SessionStatusSnapshot['orchestrator']>;

// `SwarmRunSummary` lives in agent-core and is not yet surfaced through the
// SDK, so reproduce the structural shape locally. The runtime field set must
// stay in sync with `packages/agent-core/src/session/index.ts`; until the SDK
// exposes the type, callers pass an empty list (see `showDiagReport`).
export interface SwarmRunSummaryShape {
  readonly runId: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly memberCount: number;
  readonly cancelledCount: number;
  readonly failedCount: number;
  readonly completedCount: number;
  readonly errorCount: number;
}

export interface DiagPanelOptions {
  readonly orchestrator?: OrchestratorDiagnosticsShape;
  readonly swarmRuns: readonly SwarmRunSummaryShape[];
}

export function buildDiagReportLines(opts: DiagPanelOptions): string[] {
  const lines: string[] = [];

  lines.push('Orchestrator policies');
  if (opts.orchestrator !== undefined) {
    for (const policy of opts.orchestrator.policies) {
      const status = policy.lastError !== undefined ? '✗' : '✓';
      const lastFired =
        policy.lastFiredAt !== undefined
          ? new Date(policy.lastFiredAt).toISOString().slice(11, 19)
          : '—';
      lines.push(
        `  ${policy.name.padEnd(20)} fires ${String(policy.fireCount).padStart(4)}  ${status}  last: ${lastFired}`,
      );
      if (policy.lastError !== undefined) {
        lines.push(`    └─ ${policy.lastError.message}`);
      }
    }
    lines.push(
      `  totals: ${opts.orchestrator.totals.injections} injections · ${opts.orchestrator.totals.errors} errors`,
    );
  } else {
    lines.push('  (no orchestrator data)');
  }

  lines.push('');
  lines.push(`Swarm runs (${opts.swarmRuns.length} total)`);
  if (opts.swarmRuns.length === 0) {
    lines.push('  (no swarm runs yet)');
  } else {
    for (const run of opts.swarmRuns.slice(0, 5)) {
      lines.push(`  ${run.runId}`);
      lines.push(`    started  ${new Date(run.startedAt).toISOString()}`);
      lines.push(`    ended    ${new Date(run.completedAt).toISOString()}`);
      lines.push(
        `    members  ${run.completedCount}/${run.memberCount} done, ${run.failedCount} failed, ${run.cancelledCount} cancelled`,
      );
      if (run.errorCount > 0) lines.push(`    errors   ${run.errorCount}`);
    }
  }

  return lines;
}
