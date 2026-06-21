/**
 * Public types for live swarm-run snapshots and per-member state.
 * Consumed by agent-core (emit), kimi-code-sdk (re-export), and kimi-code TUI (render).
 */

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
