/**
 * Live swarm-run snapshot renderer.
 *
 * Mirrors the visual language of `diag-panel.ts` and `status-panel.ts` but
 * consumes a per-run snapshot emitted by the swarm coordinator and renders it
 * as a self-contained panel. The kimi-code TUI does not currently pull in
 * `ink` or `@moonshot-ai/agent-core`, and `@moonshot-ai/kimi-code-sdk` does
 * not yet re-export `SwarmRunSnapshot` / `SwarmMemberStatus` from
 * `@moonshot-ai/protocol`, so the structural shapes are reproduced here. The
 * field set must stay in sync with `packages/protocol/src/swarm.ts`; once the
 * SDK exposes the type, this file can drop the local declarations.
 *
 * NOTE: the task template uses `import { Box, Text } from 'ink'` and JSX. The
 * kimi-code TUI is built on `@earendil-works/pi-tui` (no Ink runtime in the
 * dependency graph), so this implementation returns plain `string[]` lines
 * matching the `Component.render(width)` contract used by `UsagePanelComponent`
 * and similar consumers. The file keeps the `.tsx` extension only because the
 * parent task spec mandates that path; the contents are pure TypeScript.
 */

import chalk from 'chalk';

export type SwarmMemberStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SwarmMemberSnapshot {
  readonly memberId: string;
  readonly status: SwarmMemberStatus;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly errorMessage?: string;
}

export interface SwarmRunTotals {
  readonly queued: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
}

export interface SwarmRunSnapshot {
  readonly runId: string;
  readonly startedAt: number;
  /** Set when the coordinator is disposed; absent while the run is in flight. */
  readonly completedAt?: number;
  readonly memberCount: number;
  readonly members: readonly SwarmMemberSnapshot[];
  readonly totals: SwarmRunTotals;
}

const STATUS_ICON: Record<SwarmMemberStatus, string> = {
  queued: '·',
  running: '◐',
  completed: '✓',
  failed: '✗',
  cancelled: '⊘',
};

function colorizeForStatus(status: SwarmMemberStatus, text: string): string {
  switch (status) {
    case 'queued':
      return chalk.gray(text);
    case 'running':
      return chalk.yellow(text);
    case 'completed':
      return chalk.green(text);
    case 'failed':
      return chalk.red(text);
    case 'cancelled':
      return chalk.gray(text);
  }
}

export function SwarmProgressMessage({ snapshot }: { snapshot: SwarmRunSnapshot }): string[] {
  const { totals, memberCount, runId, members } = snapshot;
  const lines: string[] = [
    chalk.bold(`Swarm ${runId}`),
    ` ${totals.completed}/${memberCount} done · ${totals.running} running · ${totals.failed} failed · ${totals.cancelled} cancelled`,
  ];
  for (const m of members) {
    const detail = m.errorMessage !== undefined ? ` — ${m.errorMessage}` : '';
    lines.push(colorizeForStatus(m.status, `  ${STATUS_ICON[m.status]} ${m.memberId}${detail}`));
  }
  return lines;
}
