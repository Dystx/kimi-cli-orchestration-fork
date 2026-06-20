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
    const runQueued = vi.fn().mockResolvedValue([
      {
        task: {
          kind: 'spawn',
          data: { kind: 'spawn', index: 1, item: 'a', prompt: 'echo a' },
          profileName: 'coder',
          parentToolCallId: 'call_swarm',
          prompt: 'echo a',
          description: 'echo test #1 (coder)',
          runInBackground: false,
        },
        agentId: 'agent-1',
        status: 'completed',
        result: 'ok a',
      },
      {
        task: {
          kind: 'spawn',
          data: { kind: 'spawn', index: 2, item: 'b', prompt: 'echo b' },
          profileName: 'coder',
          parentToolCallId: 'call_swarm',
          prompt: 'echo b',
          description: 'echo test #2 (coder)',
          runInBackground: false,
        },
        agentId: 'agent-2',
        status: 'completed',
        result: 'ok b',
      },
    ]);
    const subagentHost = { runQueued } as unknown as SessionSubagentHost;

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

    // The harness actually exercised `AgentSwarmTool.execution` through the
    // tool loop, which is the property we want covered at the integration
    // level. Without a real subagentHost mock the tool would not run.
    expect(runQueued).toHaveBeenCalledTimes(1);
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

  // Skipped: `testAgent({})` constructs only an `Agent` (not a `Session`),
  // and `Agent.session` / `Agent.orchestrationHooks` are both `undefined`
  // in that mode. Reaching `session.orchestrationHooks.on(...)` therefore
  // requires wiring up a real `Session` via `new Session(...)` (with a
  // real homedir, kaos, rpc, etc.), which is outside the scope of the
  // swarm-coordinator harness. The behaviour we want to cover here —
  // `OrchestrationHooks.on(event, handler)` receiving emitted events
  // through the real channel — is already exercised end-to-end at the
  // unit level in `test/session/orchestration-hooks.test.ts`
  // (`OrchestrationHooks.on` describe block). Re-enable this case once
  // the harness exposes a `session` accessor on the agent.
  it.skipIf(true)(
    'OrchestrationHooks.on receives emitted events through the real channel',
    async () => {
      const ctx = await testAgent({});
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