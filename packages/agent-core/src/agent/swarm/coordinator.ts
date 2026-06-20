import type { AgentSwarmSpec } from '../../tools/builtin/collaboration/agent-swarm';
import type { SubagentResult } from '../../session/subagent-batch';

export type SwarmMemberStatus =
  | 'spawned'
  | 'started'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SwarmMember {
  readonly subagentId: string;
  readonly spec: AgentSwarmSpec;
  readonly agentId?: string;
  status: SwarmMemberStatus;
  startedAt?: number;
  completedAt?: number;
  result?: SubagentResult;
}

export interface SwarmProgress {
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly suspended: number;
  readonly cancelled: number;
  readonly members: readonly SwarmMember[];
}

export class SwarmCoordinator {
  readonly runId: string;
  private readonly members = new Map<string, SwarmMember>();
  private readonly unsubscribers: Array<() => void> = [];
  private retried = new Set<string>();
  private disposed = false;

  constructor(
    runId: string,
    private readonly agent: { session: { orchestrationHooks: { on(event: string, handler: (e: unknown) => void): () => void } } },
    private readonly abortController: AbortController,
  ) {
    this.runId = runId;
  }

  registerMember(subagentId: string, spec: AgentSwarmSpec, agentId?: string): void {
    this.members.set(subagentId, { subagentId, spec, agentId, status: 'spawned' });
  }

  getProgress(): SwarmProgress {
    const members = Array.from(this.members.values());
    return {
      total: members.length,
      completed: members.filter((m) => m.status === 'completed').length,
      failed: members.filter((m) => m.status === 'failed').length,
      suspended: members.filter((m) => m.status === 'suspended').length,
      cancelled: members.filter((m) => m.status === 'cancelled').length,
      members,
    };
  }

  getResults(): readonly SubagentResult[] {
    const out: SubagentResult[] = [];
    for (const m of this.members.values()) {
      if (m.result !== undefined) out.push(m.result);
    }
    return out;
  }

  // Tasks 2–5 will fill in subscribe, cancelAll, retryFailed.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.members.clear();
    this.retried.clear();
  }
}
