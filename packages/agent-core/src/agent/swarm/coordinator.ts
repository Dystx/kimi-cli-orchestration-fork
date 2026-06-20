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
    this.subscribe();
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

  subscribe(): void {
    if (this.disposed) return;
    const hooks = this.agent.session.orchestrationHooks as unknown as {
      on(event: string, handler: (e: unknown) => void): () => void;
    };
    const off = (event: string, handler: (e: unknown) => void) => {
      this.unsubscribers.push(hooks.on(event, handler));
    };

    off('subagent.started', (e) => {
      const id = (e as { subagentId?: string }).subagentId;
      if (id === undefined) return;
      const m = this.members.get(id);
      if (m === undefined) return;
      m.status = 'started';
      m.startedAt = Date.now();
    });

    off('subagent.suspended', (e) => {
      const id = (e as { subagentId?: string }).subagentId;
      if (id === undefined) return;
      const m = this.members.get(id);
      if (m === undefined) return;
      m.status = 'suspended';
    });

    off('subagent.completed', (e) => {
      const id = (e as { subagentId?: string }).subagentId;
      if (id === undefined) return;
      const m = this.members.get(id);
      if (m === undefined) return;
      const result = (e as { result?: SubagentResult }).result;
      m.status = 'completed';
      m.completedAt = Date.now();
      if (result !== undefined) m.result = result;
    });

    off('subagent.failed', (e) => {
      const id = (e as { subagentId?: string }).subagentId;
      if (id === undefined) return;
      const m = this.members.get(id);
      if (m === undefined) return;
      m.status = 'failed';
      m.completedAt = Date.now();
      const err = (e as { error?: unknown }).error;
      m.result = {
        task: { kind: 'spawn', spec: m.spec },
        agentId: m.agentId,
        status: 'failed',
        error: err instanceof Error ? err : new Error(String(err)),
      } as unknown as SubagentResult;
    });
  }

  // Tasks 3–5 will fill in cancelAll, retryFailed.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.members.clear();
    this.retried.clear();
  }
}
