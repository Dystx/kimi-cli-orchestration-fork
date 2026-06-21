import type { OrchestrationEvent } from '../../session/orchestration/types';
import type { SwarmRunSummary } from '../../session';
import type { SubagentResult } from '../../session/subagent-batch';
import type { AgentSwarmSpec } from '../../tools/builtin/collaboration/agent-swarm';

export type SwarmMemberStatus =
  | 'spawned'
  | 'started'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SwarmMember {
  subagentId: string;
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

function getSubagentId(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const obj = e as { subagentId?: unknown; payload?: unknown };
  if (typeof obj.subagentId === 'string') return obj.subagentId;
  if (typeof obj.payload === 'object' && obj.payload !== null) {
    const p = obj.payload as { subagentId?: unknown };
    if (typeof p.subagentId === 'string') return p.subagentId;
  }
  return undefined;
}

export class SwarmCoordinator {
  readonly runId: string;
  private readonly members = new Map<string, SwarmMember>();
  private readonly unsubscribers: Array<() => void> = [];
  private retried = new Set<string>();
  private readonly pendingCompletions = new Map<
    string,
    {
      resolve: (result: SubagentResult | undefined) => void;
      reject: (error: unknown) => void;
    }
  >();
  private readonly diagnosticState = new Map<string, { lastError?: unknown }>();
  private disposed = false;
  private readonly startedAt: number;
  private readonly onDispose?: (summary: SwarmRunSummary) => void;

  constructor(
    runId: string,
    private readonly agent: {
      session: {
        orchestrationHooks: {
          on(event: string, handler: (e: OrchestrationEvent) => void): () => void;
        };
        subagentHost: {
          spawn(options: unknown): Promise<{ subagentId: string }>;
        };
      };
      log: { warn(msg: string, meta?: unknown): void };
    },
    private readonly abortController: AbortController,
    onDispose?: (summary: SwarmRunSummary) => void,
  ) {
    this.runId = runId;
    this.startedAt = Date.now();
    this.onDispose = onDispose;
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
    const hooks = this.agent.session.orchestrationHooks;
    const off = (event: string, handler: (e: OrchestrationEvent) => void) => {
      this.unsubscribers.push(hooks.on(event, handler));
    };

    off('subagent.started', (e) => {
      const id = getSubagentId(e);
      if (id === undefined) return;
      const m = this.members.get(id);
      if (m === undefined) return;
      m.status = 'started';
      m.startedAt = Date.now();
      this.resolvePendingCompletions(id);
    });

    off('subagent.suspended', (e) => {
      const id = getSubagentId(e);
      if (id === undefined) return;
      const m = this.members.get(id);
      if (m === undefined) return;
      m.status = 'suspended';
      this.resolvePendingCompletions(id);
    });

    off('subagent.completed', (e) => {
      const id = getSubagentId(e);
      if (id === undefined) return;
      const m = this.members.get(id);
      if (m === undefined) return;
      // Production emits `subagent.completed` via `OrchestrationHooks.emit`
      // with the body nested under `payload.resultSummary`. The legacy flat
      // shape (`e.result`) is left untouched here because the renderer's
      // projection already prefers `m.result.result` and ignores `e.result`
      // — keeping the read off the top level prevents stale test mocks
      // from masking production fidelity regressions like the empty XML
      // body bug fixed in this revision.
      const payload = (e as { payload?: { resultSummary?: unknown } }).payload;
      m.status = 'completed';
      m.completedAt = Date.now();
      if (payload?.resultSummary !== undefined) {
        m.result = { result: payload.resultSummary } as unknown as SubagentResult;
      }
      this.resolvePendingCompletions(id);
    });

    off('subagent.failed', (e) => {
      const id = getSubagentId(e);
      if (id === undefined) return;
      const m = this.members.get(id);
      if (m === undefined) return;
      m.status = 'failed';
      m.completedAt = Date.now();
      // The real `OrchestrationEvent` for `subagent.failed` carries the
      // error message under `payload.error` (a string emitted by
      // `SessionSubagentHost.emitSubagentFailed`). Fall back to the flat
      // top-level `error` for older emitters and tests that still use the
      // legacy `AgentEvent` shape.
      const payload = (e as { payload?: { error?: unknown } }).payload;
      const err = payload?.error ?? (e as { error?: unknown }).error;
      const errorInstance =
        err instanceof Error ? err : new Error(typeof err === 'string' ? err : String(err));
      m.result = {
        task: { kind: 'spawn', spec: m.spec },
        agentId: m.agentId,
        status: 'failed',
        error: errorInstance,
      } as unknown as SubagentResult;
      // Record the error so the dispose-time summary can surface it as
      // `errorCount` independent of the member's terminal status. A future
      // member could be retried into a non-failed state while still
      // remembering that it once errored, and we want that history to be
      // visible to callers inspecting `SwarmRunSummary.errorCount`.
      const diag = this.diagnosticState.get(id) ?? {};
      diag.lastError = errorInstance;
      this.diagnosticState.set(id, diag);
      this.resolvePendingCompletions(id);
    });
  }

  async cancelAll(reason: string): Promise<void> {
    if (this.disposed) return;
    this.abortController.abort(reason);
    // Mark any 'spawned' or 'started' members as cancelled immediately;
    // 'completed'/'failed'/'suspended' members stay as-is.
    const now = Date.now();
    for (const m of this.members.values()) {
      if (m.status === 'spawned' || m.status === 'started') {
        m.status = 'cancelled';
        m.completedAt = now;
      }
      this.resolvePendingCompletions(m.subagentId);
    }
  }

  async retryFailed(): Promise<readonly SubagentResult[]> {
    if (this.disposed) return [];
    const failed = Array.from(this.members.values()).filter(
      (m) => m.status === 'failed' && !this.retried.has(m.subagentId),
    );
    if (failed.length === 0) return [];

    for (const m of failed) {
      this.retried.add(m.subagentId);
      try {
        const handle = await this.agent.session.subagentHost.spawn({
          spec: m.spec,
          runInBackground: false,
        });
        // Re-key the Map under the new id so subsequent subagent.* events
        // can find and update this member.
        this.members.delete(m.subagentId);
        m.subagentId = handle.subagentId;
        m.status = 'spawned';
        m.completedAt = undefined;
        this.members.set(m.subagentId, m);
      } catch (error) {
        this.agent.log.warn('SwarmCoordinator.retryFailed spawn error', {
          subagentId: m.subagentId,
          error,
        });
        m.status = 'failed';
        m.result = {
          task: { kind: 'spawn', spec: m.spec },
          agentId: m.agentId,
          status: 'failed',
          error: error instanceof Error ? error : new Error(String(error)),
        } as unknown as SubagentResult;
      }
    }

    // Best-effort: give the new spawns a chance to settle before returning.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    return [];
  }

  async awaitCompletion(
    agentId: string,
    signal?: AbortSignal,
  ): Promise<SubagentResult | undefined> {
    const member = this.members.get(agentId);
    if (member !== undefined && this.isTerminal(member.status)) {
      return member.result;
    }
    if (signal !== undefined && signal.aborted) {
      throw signal.reason ?? new Error('aborted');
    }
    return new Promise<SubagentResult | undefined>((resolve, reject) => {
      this.pendingCompletions.set(agentId, { resolve, reject });
      if (signal !== undefined) {
        const onAbort = () => {
          const pending = this.pendingCompletions.get(agentId);
          if (pending !== undefined) {
            this.pendingCompletions.delete(agentId);
            pending.reject(signal.reason ?? new Error('aborted'));
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  private isTerminal(status: SwarmMemberStatus): boolean {
    return (
      status === 'completed' || status === 'failed' || status === 'cancelled'
    );
  }

  private resolvePendingCompletions(agentId: string): void {
    const member = this.members.get(agentId);
    if (member === undefined) return;
    if (!this.isTerminal(member.status)) return;
    const pending = this.pendingCompletions.get(agentId);
    if (pending !== undefined) {
      this.pendingCompletions.delete(agentId);
      pending.resolve(member.result);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Compute the run summary before clearing state so the onDispose
    // callback observes the same counts the coordinator held at settle
    // time. We snapshot `members.size` first and then tally the terminal
    // statuses; `errorCount` is sourced from `diagnosticState` so it
    // tracks errors that surfaced even on members that were later
    // retried into a non-failed terminal state.
    const completedAt = Date.now();
    const memberCount = this.members.size;
    let cancelledCount = 0;
    let failedCount = 0;
    let completedCount = 0;
    for (const m of this.members.values()) {
      if (m.status === 'cancelled') cancelledCount += 1;
      else if (m.status === 'failed') failedCount += 1;
      else if (m.status === 'completed') completedCount += 1;
    }
    let errorCount = 0;
    for (const diag of this.diagnosticState.values()) {
      if (diag.lastError !== undefined) errorCount += 1;
    }

    for (const [, pending] of this.pendingCompletions) {
      pending.reject(new Error('SwarmCoordinator disposed'));
    }
    this.pendingCompletions.clear();
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.members.clear();
    this.retried.clear();

    this.onDispose?.({
      runId: this.runId,
      startedAt: this.startedAt,
      completedAt,
      memberCount,
      cancelledCount,
      failedCount,
      completedCount,
      errorCount,
    });
  }
}
