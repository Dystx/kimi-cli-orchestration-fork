/**
 * Diagnostics report line builder for `/diag`.
 *
 * Renders orchestrator-policy diagnostics and recent swarm-run snapshots in a
 * compact text format suitable for `UsagePanelComponent`. Mirrors the visual
 * language of the status panel but stays decoupled from the runtime-status
 * fields that `/status` already covers.
 */

import type { SessionStatusSnapshot, SwarmRunSnapshot } from '@moonshot-ai/kimi-code-sdk';

// `OrchestratorDiagnostics` is part of `SessionStatusSnapshot.orchestrator` in
// the protocol; the SDK does not yet re-export the named type, so derive it
// from the snapshot field that the TUI already consumes.
export type OrchestratorDiagnosticsShape = NonNullable<SessionStatusSnapshot['orchestrator']>;

export interface DiagPanelOptions {
  readonly orchestrator?: OrchestratorDiagnosticsShape;
  readonly swarmRuns: readonly SwarmRunSnapshot[];
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
      const ended = run.completedAt !== undefined
        ? new Date(run.completedAt).toISOString()
        : '(in flight)';
      lines.push(`    ended    ${ended}`);
      lines.push(
        `    members  ${run.totals.completed}/${run.memberCount} done, ${run.totals.failed} failed, ${run.totals.cancelled} cancelled`,
      );
      const errorCount = run.members.filter((m) => m.errorMessage !== undefined).length;
      if (errorCount > 0) lines.push(`    errors   ${errorCount}`);
    }
  }

  return lines;
}
