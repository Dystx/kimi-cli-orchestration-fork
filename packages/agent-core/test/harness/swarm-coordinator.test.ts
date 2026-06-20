import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import type { SessionSubagentHost } from '../../src/session/subagent-host';
import { testAgent } from '../agent/harness/agent';

/**
 * Integration coverage for `AgentSwarmTool` running through the full
 * `testAgent` harness. The valuable property under test is that
 * `SwarmMode.isActive` returns to `false` after the swarm's tool call
 * finishes — both when a real `AgentSwarm` invocation happens and when a
 * normal text-only turn runs without ever touching swarm mode.
 *
 * The "exit always runs" property is already covered exhaustively by the
 * unit tests in `test/tools/builtin/agent-swarm-coordinator.test.ts`
 * (success, host rejection, `enter` throws). This file exists so the
 * lifecycle is exercised through the harness — same plumbing real turns
 * use — and a regression in the wire-up of `AgentSwarmTool` to the
 * `Agent` (constructor order, `swarmMode` binding, tool registration)
 * surfaces here.
 */
describe('SwarmCoordinator integration', () => {
  it('AgentSwarmTool leaves SwarmMode inactive after a normal run', async () => {
    // Phase 5 Task 5: `runSwarm` calls `subagentHost.spawn(spec)` per task
    // (sequential) and waits for terminal state via `waitFor` polling the
    // coordinator. The mock returns a `SubagentHandle` and emits a
    // `subagent.completed` event through a Session-scoped
    // `orchestrationHooks` mock so the coordinator sees the event.
    //
    // `testAgent({ subagentHost })` wires a fresh subagentHost into the
    // harness but does NOT construct a real `Session`, so `agent.session`
    // is undefined and the SwarmCoordinator is never constructed. The
    // tool therefore falls back to the no-coordinator path and `runSwarm`
    // returns after both `spawn` calls complete. The smoke property under
    // test is still that `swarmMode.isActive` returns to `false` after
    // the swarm's tool call finishes — the actual lifecycle invariants
    // (success, rejection, enter-throws) are covered at the unit level
    // in `test/tools/builtin/agent-swarm-coordinator.test.ts`.
    const spawn = vi.fn().mockImplementation(async (_spec: unknown) => {
      return { agentId: `agent-${Math.random().toString(36).slice(2, 8)}` };
    });
    const subagentHost = { spawn } as unknown as SessionSubagentHost;

    const ctx = testAgent({ subagentHost });
    ctx.configure({ tools: ['AgentSwarm'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    expect(ctx.agent.swarmMode.isActive).toBe(false);

    const swarmCall: ToolCall = {
      type: 'function',
      id: 'call_swarm',
      name: 'AgentSwarm',
      arguments: JSON.stringify({
        description: 'echo test',
        prompt_template: '{{item}}',
        items: ['a', 'b'],
      }),
    };

    ctx.mockNextResponse({ type: 'text', text: 'Running the swarm.' }, swarmCall);
    ctx.mockNextResponse({ type: 'text', text: 'Swarm finished.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Use AgentSwarm' }] });
    await ctx.untilTurnEnd();

    expect(ctx.agent.swarmMode.isActive).toBe(false);
  });

  it('keeps SwarmMode inactive across a normal text-only turn', async () => {
    // Companion smoke test: a turn that never touches AgentSwarm must also
    // leave swarm mode inactive. This guards against a regression where the
    // turn loop flips swarm mode on for unrelated work.
    const ctx = testAgent();
    ctx.configure();

    ctx.mockNextResponse({ type: 'text', text: 'Hello to you too.' });
    expect(ctx.agent.swarmMode.isActive).toBe(false);

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hi' }] });
    await ctx.untilTurnEnd();

    expect(ctx.agent.swarmMode.isActive).toBe(false);
  });

  // Phase 7 Task 4: the harness does not construct a `Session`, so
  // `agent.session` is undefined and `agent.orchestrationHooks` is
  // also undefined (it is populated from `AgentOptions.orchestration`,
  // which the harness does not pass). Reaching the on/emit channel
  // end-to-end through this harness would require wiring a real
  // `Session` (with homedir, kaos, rpc, ...), which is out of scope
  // for the swarm-coordinator smoke suite.
  //
  // The behaviour we want to cover here — `OrchestrationHooks.on(event,
  // handler)` receiving emitted events through the real channel — is
  // already exercised at the unit level in
  // `test/session/orchestration-hooks.test.ts` (`OrchestrationHooks.on`
  // describe block). The body below is preserved so the case is
  // trivially re-enableable the moment the harness exposes a session
  // accessor on the agent.
  it.skip(
    'OrchestrationHooks.on receives emitted events through the real channel',
    async () => {
      const ctx = testAgent({});
      const agent = ctx.agent as unknown as {
        session: {
          orchestrationHooks: {
            on: (e: string, h: (ev: unknown) => void) => () => void;
            emit: (e: { type: string; payload: unknown }) => void;
          };
        };
      };
      const handler = vi.fn();
      agent.session.orchestrationHooks.on('subagent.started', handler);
      agent.session.orchestrationHooks.emit({
        type: 'subagent.started',
        payload: { subagentId: 'agent-real-1' },
      });
      expect(handler).toHaveBeenCalledTimes(1);
    },
  );
});