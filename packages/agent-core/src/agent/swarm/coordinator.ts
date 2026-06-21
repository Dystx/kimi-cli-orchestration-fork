import type {
  SwarmMemberSnapshot,
  SwarmMemberStatus as ProtocolMemberStatus,
  SwarmMemberToolCall,
  SwarmRunSnapshot,
} from '@moonshot-ai/protocol';

import type { OrchestrationEvent } from '../../session/orchestration/types';
import type { SwarmRunSummary } from '../../session';
import type { SubagentResult } from '../../session/subagent-batch';
import type { AgentSwarmSpec } from '../../tools/builtin/collaboration/agent-swarm';
import { summarizeArgs } from './args-summary';

export type SwarmMemberStatus =
  | 'spawned'
  | 'started'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SwarmMember {
  /** Coordinator-stable id (the `registerMember` key). Stays put across retries. */
  readonly id: string;
  /**
   * Orchestration id assigned by the subagent host when the member is spawned.
   * Populated lazily when the `subagent.spawned` event arrives; until then
   * the member is just `queued` from the orchestration's point of view.
   */
  subagentId?: string;
  readonly spec: AgentSwarmSpec;
  readonly agentId?: string;
  status: SwarmMemberStatus;
  startedAt?: number;
  completedAt?: number;
  result?: SubagentResult;
  /**
   * Most-recent in-flight tool call surfaced on the next snapshot; cleared
   * when the matching `tool.result` arrives. Tracker state — never exposed
   * on `SwarmProgress`.
   */
  currentToolCall?: SwarmMemberToolCall;
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

// Map the coordinator's internal lifecycle status onto the protocol's
// user-facing `SwarmMemberStatus`. The protocol omits the coordinator's
// non-terminal `spawned` and `suspended` variants — `spawned` is exposed
// as `queued` so a freshly registered subagent reads as "waiting to
// start", and `suspended` (paused mid-flight, awaiting resume) reads as
// `running` so consumers see it as still in progress rather than done.
function toProtocolStatus(status: SwarmMemberStatus): ProtocolMemberStatus {
  switch (status) {
    case 'spawned':
      return 'queued';
    case 'started':
    case 'suspended':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

function extractErrorMessage(m: SwarmMember): string | undefined {
  const result = m.result as { error?: unknown } | undefined;
  const err = result?.error;
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return undefined;
}

export class SwarmCoordinator {
  readonly runId: string;
  private readonly members = new Map<string, SwarmMember>();
  /**
   * Reverse lookup from orchestration id (`subagentId`) to coordinator id
   * (`memberId`). Populated lazily when `subagent.spawned` arrives; used by
   * the tool-call handlers (`tool.call.started`, `tool.result`) to update
   * the right member without scanning `members`.
   */
  private readonly memberBySubagentId = new Map<string, string>();
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
  private readonly session?: {
    emitSwarmSnapshot(snapshot: SwarmRunSnapshot): void;
  };
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
        emitSwarmSnapshot(snapshot: SwarmRunSnapshot): void;
      };
      log: { warn(msg: string, meta?: unknown): void };
    },
    private readonly abortController: AbortController,
    onDispose?: (summary: SwarmRunSummary) => void,
  ) {
    this.runId = runId;
    this.startedAt = Date.now();
    this.onDispose = onDispose;
    this.session = agent.session;
    this.subscribe();
  }

  registerMember(memberId: string, spec: AgentSwarmSpec, agentId?: string): void {
    this.members.set(memberId, {
      id: memberId,
      spec,
      agentId,
      status: 'spawned',
    });
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
    // Resolve the coordinator member for an event carrying a `subagentId`.
    // Production goes through `subagent.spawned` first so the reverse map
    // has the answer; tests and legacy emitters that fire only the
    // terminal events fall back to the legacy convention where
    // `memberId === subagentId`.
    const memberIdFor = (subagentId: string): string | undefined =>
      this.memberBySubagentId.get(subagentId) ?? (this.members.has(subagentId) ? subagentId : undefined);

    off('subagent.spawned', (e) => {
      const subagentId = getSubagentId(e);
      if (subagentId === undefined) return;
      // Best-effort: link to the first registered-but-unstarted member
      // (status === 'spawned' from the protocol side reads as `queued`).
      // Members are registered by the call site before their host spawns
      // them, so iterating in insertion order is the natural FIFO pairing.
      for (const [memberId, member] of this.members.entries()) {
        if (member.subagentId === undefined && member.status === 'spawned') {
          member.subagentId = subagentId;
          this.memberBySubagentId.set(subagentId, memberId);
          break;
        }
      }
      this.emitSnapshot();
    });

    off('subagent.started', (e) => {
      const subagentId = getSubagentId(e);
      if (subagentId === undefined) return;
      const memberId = memberIdFor(subagentId);
      if (memberId === undefined) return;
      const m = this.members.get(memberId);
      if (m === undefined) return;
      m.status = 'started';
      m.startedAt = Date.now();
      this.resolvePendingCompletions(memberId);
      this.emitSnapshot();
    });

    off('subagent.suspended', (e) => {
      const subagentId = getSubagentId(e);
      if (subagentId === undefined) return;
      const memberId = memberIdFor(subagentId);
      if (memberId === undefined) return;
      const m = this.members.get(memberId);
      if (m === undefined) return;
      m.status = 'suspended';
      this.resolvePendingCompletions(memberId);
      this.emitSnapshot();
    });

    off('subagent.completed', (e) => {
      const subagentId = getSubagentId(e);
      if (subagentId === undefined) return;
      const memberId = memberIdFor(subagentId);
      if (memberId === undefined) return;
      const m = this.members.get(memberId);
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
      this.resolvePendingCompletions(memberId);
      this.emitSnapshot();
    });

    off('subagent.failed', (e) => {
      const subagentId = getSubagentId(e);
      if (subagentId === undefined) return;
      const memberId = memberIdFor(subagentId);
      if (memberId === undefined) return;
      const m = this.members.get(memberId);
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
      const diag = this.diagnosticState.get(memberId) ?? {};
      diag.lastError = errorInstance;
      this.diagnosticState.set(memberId, diag);
      this.resolvePendingCompletions(memberId);
      this.emitSnapshot();
    });

    off('tool.call.started', (e) => {
      const payload = (e as { payload?: { subagentId?: unknown; toolName?: unknown; args?: unknown } }).payload;
      const subagentId = payload?.subagentId;
      // TODO(phase-12): turn/index.ts emits `tool.call.started` without
      // `subagentId`; subagent-host should re-emit these events through
      // `orchestrationHooks` stamped with the child id. Until that lands,
      // production child-agent tool calls will silently fall through here.
      if (typeof subagentId !== 'string') return;
      const memberId = this.memberBySubagentId.get(subagentId);
      if (memberId === undefined) return;
      const m = this.members.get(memberId);
      if (m === undefined) return;
      const toolName = typeof payload?.toolName === 'string' ? payload.toolName : '<unknown>';
      m.currentToolCall = {
        toolName,
        argsSummary: typeof payload?.toolName === 'string' ? summarizeArgs(payload.toolName, payload?.args) : undefined,
      };
      this.emitSnapshot();
    });

    off('tool.result', (e) => {
      const payload = (e as { payload?: { subagentId?: unknown } }).payload;
      const subagentId = payload?.subagentId;
      if (typeof subagentId !== 'string') return;
      const memberId = this.memberBySubagentId.get(subagentId);
      if (memberId === undefined) return;
      const m = this.members.get(memberId);
      if (m === undefined || m.currentToolCall === undefined) return;
      m.currentToolCall = undefined;
      this.emitSnapshot();
    });
  }

  async cancelAll(reason: string): Promise<void> {
    if (this.disposed) return;
    this.abortController.abort(reason);
    // Mark any 'spawned' or 'started' members as cancelled immediately;
    // 'completed'/'failed'/'suspended' members stay as-is.
    const now = Date.now();
    for (const [memberId, m] of this.members.entries()) {
      if (m.status === 'spawned' || m.status === 'started') {
        m.status = 'cancelled';
        m.completedAt = now;
      }
      this.resolvePendingCompletions(memberId);
    }
    this.emitSnapshot();
  }

  async retryFailed(): Promise<readonly SubagentResult[]> {
    if (this.disposed) return [];
    const failed = Array.from(this.members.entries()).filter(
      ([, m]) => m.status === 'failed' && !this.retried.has(m.id),
    );
    if (failed.length === 0) return [];

    for (const [memberId, m] of failed) {
      this.retried.add(memberId);
      try {
        const handle = await this.agent.session.subagentHost.spawn({
          spec: m.spec,
          runInBackground: false,
        });
        // Map key is the coordinator member id — it stays put across retries.
        // Just point the orchestration id at the new spawn so subsequent
        // `subagent.*` and tool events route back here.
        if (m.subagentId !== undefined) {
          this.memberBySubagentId.delete(m.subagentId);
        }
        m.subagentId = handle.subagentId;
        m.status = 'spawned';
        m.completedAt = undefined;
        m.currentToolCall = undefined;
        this.memberBySubagentId.set(handle.subagentId, memberId);
      } catch (error) {
        this.agent.log.warn('SwarmCoordinator.retryFailed spawn error', {
          memberId,
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

    // Emit the final snapshot before clearing `members` so subscribers see
    // the full per-member state at settle time. `this.disposed` is already
    // true at this point, so `buildSnapshot` will stamp `completedAt` and
    // route the snapshot through `Session.recordSwarmRun` via
    // `emitSwarmSnapshot`. We deliberately keep the legacy `onDispose`
    // callback path for callers that wired it directly (e.g. test fixtures);
    // production callers should rely on `session.emitSwarmSnapshot` instead.
    this.emitSnapshot();

    for (const [, pending] of this.pendingCompletions) {
      pending.reject(new Error('SwarmCoordinator disposed'));
    }
    this.pendingCompletions.clear();
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.members.clear();
    this.memberBySubagentId.clear();
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

  // Build a protocol-shaped snapshot from the coordinator's current
  // member state. `completedAt` is set iff the coordinator has been
  // disposed so `Session.emitSwarmSnapshot` can route it through
  // `recordSwarmRun` for the history registry.
  private buildSnapshot(): SwarmRunSnapshot {
    const members: SwarmMemberSnapshot[] = Array.from(this.members.values()).map((m) => ({
      memberId: m.id,
      status: toProtocolStatus(m.status),
      startedAt: m.startedAt,
      completedAt: m.completedAt,
      errorMessage: extractErrorMessage(m),
      currentToolCall: m.currentToolCall,
    }));
    const totals = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const m of members) {
      if (m.status === 'queued') totals.queued += 1;
      else if (m.status === 'running') totals.running += 1;
      else if (m.status === 'completed') totals.completed += 1;
      else if (m.status === 'failed') totals.failed += 1;
      else if (m.status === 'cancelled') totals.cancelled += 1;
    }
    return {
      runId: this.runId,
      startedAt: this.startedAt,
      completedAt: this.disposed ? Date.now() : undefined,
      memberCount: this.members.size,
      members,
      totals,
    };
  }

  // Hand the current snapshot to the session so live subscribers (TUI
  // progress panel) and the active/history registries stay in sync with
  // every member transition. No-op when no session is wired (test
  // harnesses that build an Agent without a Session).
  private emitSnapshot(): void {
    this.session?.emitSwarmSnapshot(this.buildSnapshot());
  }
}
