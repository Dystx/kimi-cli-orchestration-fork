/**
 * Live swarm-run snapshot renderer.
 *
 * Mirrors the visual language of `diag-panel.ts` and `status-panel.ts` but
 * consumes a per-run snapshot emitted by the swarm coordinator and renders it
 * as a self-contained panel. Returns plain `string[]` lines matching the
 * `Component.render(width)` contract used by `UsagePanelComponent`. The file
 * keeps the `.tsx` extension for tooling compatibility even though it has no
 * JSX; the kimi-code TUI is built on `@earendil-works/pi-tui`, not Ink.
 */

import type {
  SwarmMemberSnapshot,
  SwarmMemberStatus,
  SwarmRunSnapshot,
} from '@moonshot-ai/kimi-code-sdk';
import chalk from 'chalk';

// Re-export the SDK types so consumers (`SwarmProgressController`,
// `useSwarmProgress` callers) can keep their existing import sites
// pointing at this module if they prefer.
export type { SwarmMemberSnapshot, SwarmMemberStatus, SwarmRunSnapshot };

// Structural view of `@moonshot-ai/protocol`'s `SwarmMemberToolCall`.
// `@moonshot-ai/kimi-code-sdk` does not (yet) re-export the type, so this
// module accepts the snapshot's `currentToolCall` field by structural
// compatibility rather than a nominal import.
interface MemberToolCallShape {
  readonly toolName: string;
  readonly argsSummary?: string;
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

function formatActivity(call: MemberToolCallShape): string {
  return call.argsSummary !== undefined
    ? `[${call.toolName} ${call.argsSummary}]`
    : `[${call.toolName}]`;
}

export function SwarmProgressMessage({ snapshot }: { snapshot: SwarmRunSnapshot }): string[] {
  const { totals, memberCount, runId, members } = snapshot;
  const lines: string[] = [
    chalk.bold(`Swarm ${runId}`),
    ` ${totals.completed}/${memberCount} done · ${totals.running} running · ${totals.failed} failed · ${totals.cancelled} cancelled`,
  ];
  for (const m of members) {
    const detail = m.errorMessage !== undefined ? ` — ${m.errorMessage}` : '';
    const activity = m.currentToolCall !== undefined
      ? ' ' + chalk.dim(formatActivity(m.currentToolCall))
      : '';
    lines.push(
      colorizeForStatus(m.status, `  ${STATUS_ICON[m.status]} ${m.memberId}${detail}`) + activity,
    );
  }
  return lines;
}
