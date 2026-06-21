/**
 * Verifies that `AgentSwarmTool.runSwarm` dispatches `subagentHost.spawn()`
 * calls in parallel rather than awaiting each one before starting the next.
 *
 * Phase 6 switched the swarm implementation from sequential `await spawn`
 * to `Promise.all(spawnable.map(spawn))`. This test pins that contract:
 * after the tool starts, all three spawns must be in-flight concurrently
 * (peak ≥ 3) before any of them resolves.
 *
 * The spawn mock returns a pending `Promise<SubagentHandle>` that only
 * resolves when the test fires its queued resolver. That lets us observe
 * `peak === 3` between `runSwarm` scheduling the spawns and the first
 * resolver firing.
 *
 * `orchestrationHooks.on` retains subscribers in a Map so the coordinator's
 * `subscribe()` actually receives `subagent.completed` notifications. A
 * `vi.fn(() => () => undefined)` would have left the coordinator empty and
 * made `awaitCompletion` hang forever — this test instead mirrors the
 * working wiring used in `agent-swarm-coordinator.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';

import { AgentSwarmTool } from '../../../src/tools/builtin/collaboration/agent-swarm';

describe('AgentSwarmTool parallel dispatch', () => {
  it('dispatches all spawn() calls concurrently', async () => {
    let inFlight = 0;
    let peak = 0;
    const resolves: Array<() => void> = [];
    const completionTriggers: Array<string> = [];

    const spawn = vi.fn().mockImplementation((_options: unknown) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<{ agentId: string }>((resolve) => {
        const agentId = `agent-${resolves.length}`;
        resolves.push(() => {
          inFlight -= 1;
          completionTriggers.push(agentId);
          resolve({ agentId });
        });
      });
    });

    // `AgentSwarmTool.execution` reads `session.orchestrationHooks.on`
    // directly — the coordinator's `subscribe()` registers
    // `subagent.started/completed/failed` handlers via that contract, so
    // they only fire if we actually retain them here and dispatch on
    // `emit`. Without that wiring `awaitCompletion` would never observe a
    // terminal state and the test would time out at 300s.
    const handlers = new Map<string, Array<(event: unknown) => void>>();
    const orchestrationHooks = {
      on(event: string, handler: (event: unknown) => void): () => void {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return () => undefined;
      },
      emit(event: { type: string; payload?: Record<string, unknown> }): void {
        const list = handlers.get(event.type) ?? [];
        for (const h of list) h(event);
      },
    };

    const session = {
      orchestrationHooks,
      log: { warn: vi.fn() },
      // Phase 10: SwarmCoordinator calls `session.emitSwarmSnapshot` on
      // every member transition and on dispose (with `completedAt` set);
      // Session routes the final snapshot through `recordSwarmRun`
      // internally. Mock the entry point so the coordinator can dispatch
      // without throwing — the parallel-dispatch assertion only cares
      // about the spawn/awaitCompletion ordering.
      emitSwarmSnapshot: vi.fn(),
    };

    const swarmMode = { enter: vi.fn(), exit: vi.fn() };
    const tool = new AgentSwarmTool(
      { spawn } as never,
      swarmMode as never,
      session as never,
    );

    const args = {
      description: 'parallel test',
      prompt_template: '{{item}}',
      items: ['a', 'b', 'c'],
    } as never;
    const ctx = {
      turnId: 't',
      toolCallId: 'call-parallel',
      signal: new AbortController().signal,
    } as never;

    const execution = tool.resolveExecution(args);
    const promise = (execution as unknown as { execute: (ctx: never) => Promise<unknown> }).execute(ctx);

    // Let all three spawns start. `Promise.all(spawnable.map(spawn))` calls
    // each `spawn` synchronously inside the same microtask, so by the time
    // this `setTimeout(20)` fires all three should be in-flight concurrently.
    await new Promise((r) => setTimeout(r, 20));
    expect(peak).toBeGreaterThanOrEqual(3);

    // Resolve all spawns. The `.then` chain on `Promise.all` (which calls
    // `coordinator.registerMember` for each handle) is queued as a
    // microtask, so we must drain it before emitting `subagent.completed`:
    // the coordinator's handler bails out via `this.members.get(id)` when
    // no member is registered yet, which would leave members in `spawned`
    // state and `awaitCompletion` would never settle.
    for (const r of resolves) r();
    await new Promise((r) => setTimeout(r, 0));

    // Fire completion events. The coordinator's handler runs synchronously
    // and resolves the per-member `awaitCompletion` promise; `runSwarm`
    // then renders the result and the outer execution returns.
    for (const agentId of completionTriggers) {
      orchestrationHooks.emit({
        type: 'subagent.completed',
        payload: { subagentId: agentId, resultSummary: 'ok' },
      });
    }

    await promise;
    expect(peak).toBe(3);
    expect(spawn).toHaveBeenCalledTimes(3);
  });
});