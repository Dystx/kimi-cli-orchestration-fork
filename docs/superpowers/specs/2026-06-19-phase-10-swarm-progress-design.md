# Phase 10 — Real-Time Swarm Progress Panel + SDK Plumbing — Design

## Status

Design approved. Ready for implementation planning.

## Goal

Two deliverables that close out the swarm-visibility arc:

1. **SDK plumbing** — expose `subscribeSwarmRuns`, `getActiveSwarmRun`, `getSwarmRunHistory` on `Session` so the TUI can read live and historical swarm state without going through the TUI's existing snapshot pipeline.
2. **Real-time progress panel** — TUI auto-mounts a `<SwarmProgressMessage>` component when a swarm starts; auto-unmounts when it completes. Renders per-member status (queued / running / completed / failed / cancelled).

This closes the known follow-up from Phase 9 Task 3 (where `getSwarmRuns` was deferred behind SDK plumbing) and adds a long-requested live monitoring surface.

## Non-goals

- Per-member tool-call activity or intermediate output (Phase 11+).
- Persisting swarm runs across sessions (deferred; the existing in-memory `swarmRuns` map stays).
- Customizable panel formatting / user preferences.
- Aggregating swarm member output into a final synthesis message.

## Context

Phase 9 shipped `/diag` as a snapshot view but its `swarmRuns` line shows an empty array because `apps/kimi-code` depends on `kimi-code-sdk` (not `agent-core`) and the SDK does not yet expose `getSwarmRuns`. Phase 10 fixes this gap and adds live monitoring.

The existing event channel (Phase 5) emits per-member state changes via `orchestrationHooks.on(...)`. The coordinator already handles each event to maintain its internal state — Phase 10 extends the same handlers to also emit a `SwarmRunSnapshot` to SDK subscribers.

## Architecture

Two layers, six components:

**SDK layer** (agent-core + protocol):

```
SwarmCoordinator
  onMemberStateChange(memberId, newStatus)
    ↓
  builds SwarmRunSnapshot
    ↓
  fires to session.subscribers[]
    ↓
  emits OrchestrationEvent (existing behavior unchanged)

Session
  swarmRuns: Map<runId, SwarmRunSummary>           ← Phase 9, completed runs
  activeRuns: Map<runId, SwarmRunSnapshot>        ← new, in-flight
  subscribers: Set<(snapshot) => void>             ← new
  subscribeSwarmRuns(cb): () => void              ← new
  getActiveSwarmRun(runId?): SwarmRunSnapshot | undefined   ← new
  getSwarmRunHistory(): readonly SwarmRunSummary[]          ← new (replaces Phase 9 gap)
```

**TUI layer** (kimi-code):

```
useSwarmProgress(session)
  ↓ subscribeSwarmRuns on mount, unsubscribe on unmount
  ↓ state: SwarmRunSnapshot | undefined
<SwarmProgressMessage snapshot={snapshot}>
  renders per-member status with tick/cross icons
Transcript mounts the component when getActiveSwarmRun() !== undefined
Transcript unmounts on completion (snapshot === undefined)
```

## Components

### 1. `packages/protocol/src/swarm.ts` (new)

```typescript
export interface SwarmMemberSnapshot {
  readonly memberId: string;
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly errorMessage?: string;
}

export interface SwarmRunSnapshot {
  readonly runId: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly memberCount: number;
  readonly members: readonly SwarmMemberSnapshot[];
  readonly totals: {
    readonly queued: number;
    readonly running: number;
    readonly completed: number;
    readonly failed: number;
    readonly cancelled: number;
  };
}
```

### 2. `packages/agent-core/src/session/index.ts`

Add to `Session`:

```typescript
private readonly activeRuns = new Map<string, SwarmRunSnapshot>();
private readonly swarmSubscribers = new Set<(snapshot: SwarmRunSnapshot) => void>();

subscribeSwarmRuns(cb: (snapshot: SwarmRunSnapshot) => void): () => void {
  this.swarmSubscribers.add(cb);
  return () => this.swarmSubscribers.delete(cb);
}

getActiveSwarmRun(runId?: string): SwarmRunSnapshot | undefined {
  if (runId !== undefined) return this.activeRuns.get(runId);
  // Return the most recent active run (startedAt desc).
  const values = Array.from(this.activeRuns.values());
  if (values.length === 0) return undefined;
  return values.toSorted((a, b) => b.startedAt - a.startedAt)[0];
}

getSwarmRunHistory(): readonly SwarmRunSummary[] {
  return this.getSwarmRuns();  // Phase 9 already implements this.
}

// Internal, called by SwarmCoordinator.
emitSwarmSnapshot(snapshot: SwarmRunSnapshot): void {
  if (snapshot.completedAt !== undefined) {
    this.activeRuns.delete(snapshot.runId);
    this.recordSwarmRun(toSwarmRunSummary(snapshot));
  } else {
    this.activeRuns.set(snapshot.runId, snapshot);
  }
  for (const cb of this.swarmSubscribers) {
    try { cb(snapshot); }
    catch (err) { this.log.warn('swarm subscriber threw', err); }
  }
}
```

### 3. `packages/agent-core/src/agent/swarm/coordinator.ts`

Extend the existing event handlers. After each `subagent.*` event updates the member's `status`, call a new `emitSnapshot()` helper:

```typescript
private emitSnapshot(): void {
  const snapshot: SwarmRunSnapshot = {
    runId: this.runId,
    startedAt: this.startedAt,
    completedAt: this.disposed ? Date.now() : undefined,
    memberCount: this.members.size,
    members: Array.from(this.members.values()).map(m => ({
      memberId: m.id,
      status: m.status,
      startedAt: m.startedAt,
      completedAt: m.completedAt,
      errorMessage: m.error?.message,
    })),
    totals: this.computeTotals(),
  };
  this.session?.emitSwarmSnapshot(snapshot);
}
```

Call `emitSnapshot()` from each existing event handler (`onSubagentStarted`, `onSubagentCompleted`, `onSubagentFailed`, `onSubagentCancelled`, etc.) AND from `dispose()` (with `completedAt` set).

### 4. `packages/agent-core/test/session/swarm-subscribe.test.ts` (new)

Unit tests:
- `subscribeSwarmRuns` callback fires on every emit.
- Returning the unsubscribe function stops further emissions.
- Subscriber callback errors are isolated (other subscribers still fire).
- `getActiveSwarmRun` returns the latest snapshot during the run.
- `getActiveSwarmRun` returns `undefined` after dispose.
- `getSwarmRunHistory` returns all completed runs sorted desc.

### 5. `apps/kimi-code/src/tui/components/messages/swarm-progress.tsx` (new)

React/Ink component:

```tsx
import type { SwarmRunSnapshot, SwarmMemberSnapshot } from '@moonshot-ai/agent-core';

const STATUS_ICON = {
  queued: '·',
  running: '◐',
  completed: '✓',
  failed: '✗',
  cancelled: '⊘',
} as const;

export function SwarmProgressMessage({ snapshot }: { snapshot: SwarmRunSnapshot }) {
  const { totals } = snapshot;
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Swarm {snapshot.runId}</Text>
      <Text>
        {' '}{totals.completed}/{snapshot.memberCount} done ·{' '}
        {totals.running} running · {totals.failed} failed · {totals.cancelled} cancelled
      </Text>
      {snapshot.members.map(m => (
        <Text key={m.memberId}>
          {'  '}{STATUS_ICON[m.status]} {m.memberId}
        </Text>
      ))}
    </Box>
  );
}
```

### 6. `apps/kimi-code/src/tui/hooks/use-swarm-progress.ts` (new)

React hook:

```typescript
import { useEffect, useState } from 'react';
import type { SwarmRunSnapshot } from '@moonshot-ai/agent-core';

export function useSwarmProgress(session: Session): SwarmRunSnapshot | undefined {
  const [snapshot, setSnapshot] = useState<SwarmRunSnapshot | undefined>(
    session.getActiveSwarmRun(),
  );
  useEffect(() => {
    const unsubscribe = session.subscribeSwarmRuns(setSnapshot);
    return unsubscribe;
  }, [session]);
  return snapshot;
}
```

### 7. TUI transcript wiring (modify)

In `apps/kimi-code/src/tui/hooks/...` or wherever the transcript is mounted, use `useSwarmProgress(session)` and render `<SwarmProgressMessage snapshot={snapshot} />` conditionally (only when `snapshot !== undefined`).

## Data flow

1. **Swarm start**: `AgentSwarmTool.runSwarm` creates `SwarmCoordinator`. Coordinator's first `subagent.started` event triggers `emitSnapshot()` → `session.emitSwarmSnapshot(snapshot)`. Subscribers receive; TUI hook sets state; component mounts.

2. **During swarm**: each `subagent.*` event updates one member's status → `emitSnapshot()` fires → subscribers receive → component re-renders with updated totals.

3. **Swarm end**: `coordinator.dispose()` computes final snapshot with `completedAt` set → `session.emitSwarmSnapshot(final)` → `activeRuns.delete(runId)` + `recordSwarmRun(summary)` → subscribers receive final → TUI hook sees `snapshot.completedAt !== undefined` → component unmounts.

4. **History**: `/diag` reads `session.getSwarmRunHistory()` (was `getSwarmRuns()` in Phase 9 — same data, exposed via SDK now).

## Error handling

- Subscriber callbacks wrapped in try/catch; one failing subscriber does not block others.
- Snapshot emit is no-throw from coordinator's perspective (errors in subscribers are logged, not propagated).
- Hook unsubscribe on React unmount prevents stale callbacks.

## Testing

- Unit (agent-core): subscribe API + active/history getters.
- Unit (agent-core): coordinator emits snapshot on every member state change.
- Unit (agent-core): dispose emits final snapshot.
- TUI (manual): start a swarm in the TUI, watch the panel mount; complete it, watch unmount; trigger `/diag`, confirm history line is no longer empty.

## Risks

| Risk | Mitigation |
|------|------------|
| Re-render storm on rapid member changes | Coordinator only emits when at least one member's status changed since last emit. |
| Hook leaks on session change | React `useEffect` cleanup unsubscribes. |
| SDK surface drift between agent-core and kimi-code-sdk | Both consume `SwarmRunSnapshot` from `@moonshot-ai/protocol`. |
| Subscriber callback blocks emit loop | Errors caught + logged; sync emit only. |

## Out of scope

- Persisting swarm runs across sessions.
- Per-member tool-call activity display.
- Customizable panel formatting / user preferences.
- Aggregating member output into a final synthesis message.

## Open questions

None for v1.