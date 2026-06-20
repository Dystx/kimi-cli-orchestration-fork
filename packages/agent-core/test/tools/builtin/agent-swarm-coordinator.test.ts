/**
 * Verifies that `AgentSwarmTool.execution` always pairs `swarmMode.enter()`
 * with a matching `swarmMode.exit()`:
 *   - on a successful run (exit must be called once),
 *   - when `subagentHost.spawn` rejects (exit must still run so we don't
 *     leak the active swarm-mode state into the next turn),
 *   - when `swarmMode.enter` itself throws (exit must NOT run because the
 *     tool never entered swarm mode in the first place).
 *
 * The third case guards the `entered` flag in `AgentSwarmTool.execution`:
 * the `finally` block only calls `swarmMode.exit()` if `enter()` actually
 * returned, otherwise a failing `enter` would leave the tool with a phantom
 * exit call.
 *
 * After Phase 5 Task 5, `runSwarm` switched from a batched
 * `subagentHost.runQueued(...)` call to a sequential `subagentHost.spawn`
 * per task. The mocks below mirror that shape: `spawn` returns a
 * `SubagentHandle`, the coordinator subscribes to `subagent.completed`
 * through `orchestrationHooks.on`, and the spawn mock fires the matching
 * `subagent.completed` event so `waitFor` resolves on the next poll tick.
 */

import { describe, it, expect, vi } from 'vitest';

import { AgentSwarmTool } from '../../../src/tools/builtin/collaboration/agent-swarm';
import type { ExecutableToolContext, ExecutableToolResult } from '../../../src/loop';
import type { RunnableToolExecution } from '../../../src/loop/types';

function makeSession(): {
  orchestrationHooks: {
    on(event: string, handler: (e: unknown) => void): () => void;
    emit(event: string, payload: unknown): void;
  };
  log: { warn: ReturnType<typeof vi.fn> };
} {
  // The session mock needs the two surfaces the tool reaches for:
  // `orchestrationHooks.on` (wrapped by the SwarmCoordinator subscription
  // shim) and `log.warn` (used by the coordinator on retry errors). The shim
  // inspects the real `orchestrationHooks` for an `on(event, handler)` method
  // and forwards subscriptions into it, so the mock must actually retain the
  // registered handlers — otherwise `spawn`-time `emit` calls would have no
  // listeners and the coordinator's members would stay in `spawned` state
  // until the 300s `waitFor` timeout fires.
  const handlers = new Map<string, Array<(e: unknown) => void>>();
  const orchestrationHooks = {
    on(event: string, handler: (e: unknown) => void): () => void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => undefined;
    },
    emit(event: string, payload: unknown): void {
      for (const h of handlers.get(event) ?? []) h(payload);
    },
  };
  return {
    orchestrationHooks,
    log: { warn: vi.fn() },
  };
}

function makeContext(toolCallId: string): ExecutableToolContext {
  return {
    turnId: 't',
    toolCallId,
    signal: new AbortController().signal,
  };
}

const validArgs = {
  description: 'd',
  prompt_template: '{{item}}',
  items: ['a', 'b'],
} as never;

describe('AgentSwarmTool + SwarmCoordinator lifecycle', () => {
  it('exits swarm mode even when spawn rejects', async () => {
    // No need to wire `orchestrationHooks.emit` here — the spawn rejection
    // bubbles out of `runSwarm` before `registerMember`/`waitFor` ever run,
    // so the coordinator stays empty. The outer try/catch in `execution`
    // converts the thrown error into a structured `{ isError: true, output }`
    // result and the inner finally still fires `swarmMode.exit()`.
    const spawn = vi.fn().mockRejectedValue(new Error('host down'));
    const swarmMode = { enter: vi.fn(), exit: vi.fn() };
    const subagentHost = { spawn };
    const tool = new AgentSwarmTool(subagentHost as never, swarmMode as never, makeSession() as never);

    const result: ExecutableToolResult = await (tool.resolveExecution(validArgs) as RunnableToolExecution).execute(makeContext('call-1'));

    // The outer try/catch in `execution` converts thrown errors into a
    // structured `{ isError: true, output }` result, so the promise resolves
    // rather than rejecting. The error message should surface verbatim.
    expect(result.isError).toBe(true);
    expect(result.output).toBe('host down');
    expect(swarmMode.enter).toHaveBeenCalledTimes(1);
    expect(swarmMode.enter).toHaveBeenCalledWith('tool');
    // The whole point of the test: `spawn` threw, but `exit` still ran
    // because the inner `finally` is reached on the rejection path.
    expect(swarmMode.exit).toHaveBeenCalledTimes(1);
  });

  it('exits swarm mode on success', async () => {
    // Build a session whose `orchestrationHooks` retains its subscribers,
    // then have `spawn` fire `subagent.completed` after `runSwarm`'s
    // `registerMember` has had a chance to run. The cleanest way to order
    // "registerMember before emit" is to defer the emit one macrotask via
    // `setTimeout(..., 0)`: the spawn promise resolves first (so the
    // continuation runs registerMember + starts `waitFor`), and only then
    // does the queued emit fire and flip the member to `completed`. The
    // following `waitFor` poll tick (100ms later) then resolves the promise
    // and the loop proceeds to the next item.
    const session = makeSession();
    let counter = 0;
    const spawn = vi.fn().mockImplementation(() => {
      counter += 1;
      const agentId = `agent-${counter}`;
      setTimeout(() => {
        session.orchestrationHooks.emit('subagent.completed', {
          type: 'subagent.completed',
          payload: { subagentId: agentId },
        });
      }, 0);
      return Promise.resolve({
        agentId,
        profileName: 'coder',
        resumed: false,
        completion: Promise.resolve(),
      });
    });
    const swarmMode = { enter: vi.fn(), exit: vi.fn() };
    const subagentHost = { spawn };
    const tool = new AgentSwarmTool(subagentHost as never, swarmMode as never, session as never);

    const result: ExecutableToolResult = await (tool.resolveExecution(validArgs) as RunnableToolExecution).execute(makeContext('call-2'));

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('completed: 2');
    expect(swarmMode.enter).toHaveBeenCalledTimes(1);
    expect(swarmMode.enter).toHaveBeenCalledWith('tool');
    expect(swarmMode.exit).toHaveBeenCalledTimes(1);
  });

  it('does not call swarmMode.exit if swarmMode.enter threw', async () => {
    const spawn = vi.fn();
    const enterError = new Error('enter failed');
    const swarmMode = {
      enter: vi.fn(() => {
        throw enterError;
      }),
      exit: vi.fn(),
    };
    const subagentHost = { spawn };
    const tool = new AgentSwarmTool(subagentHost as never, swarmMode as never, makeSession() as never);

    const result: ExecutableToolResult = await (tool.resolveExecution(validArgs) as RunnableToolExecution).execute(makeContext('call-3'));

    // The thrown `enter` error is caught by the outer try/catch and reported
    // as a tool-level error, but the `entered` guard inside `execution` must
    // keep `exit` from being called when `enter` never succeeded.
    expect(result.isError).toBe(true);
    expect(result.output).toBe('enter failed');
    expect(swarmMode.enter).toHaveBeenCalledTimes(1);
    expect(swarmMode.exit).not.toHaveBeenCalled();
    // `spawn` should never have been reached because the tool bailed out
    // before constructing the swarm.
    expect(spawn).not.toHaveBeenCalled();
  });
});