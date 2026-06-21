import { describe, expect, it, vi } from 'vitest';

import { createRPC, proxyWithExtraPayload } from '../../src/rpc';

interface AgentEvent {
  readonly type: string;
  readonly toolName?: string;
}

interface CoreSide {
  // Empty — the Core side is a no-op for this test; only the
  // SDK subscription / emission path matters.
}

interface TestSDKAgentAPI {
  emitEvent: (event: AgentEvent) => void;
  onEvent: (listener: (event: AgentEvent) => void) => () => void;
  requestApproval: (request: { toolName: string }) => Promise<{ decision: 'approved' }>;
}

/**
 * Stand-in for `ClientAPI` (`packages/node-sdk/src/rpc.ts`). The real
 * SDK RPC surface that backs `KimiCore.sdk` and is wrapped by every
 * `proxyWithExtraPayload` layer in the session/agent RPC chain.
 */
class TestClientAPI {
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  emitEvent(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async requestApproval(): Promise<{ decision: 'approved' }> {
    return { decision: 'approved' };
  }
}

describe('proxyWithExtraPayload + createRPC onEvent forwarding', () => {
  it('forwards onEvent across the session + agent proxy layers', async () => {
    // Mirrors the production wiring in `KimiCore.createSession`:
    //   `rpc: proxyWithExtraPayload(await this.sdk, { sessionId })`
    // followed by `Session.instantiateAgent`:
    //   `rpc: proxyWithExtraPayload(this.rpc, { agentId: id })`
    const [coreClient, sdkClient] = createRPC<CoreSide, TestSDKAgentAPI>();
    const sdkImpl = new TestClientAPI();
    void sdkClient(sdkImpl);

    // `coreClient` is `leftClient` — returns the proxy that the Core
    // uses to call the SDK side. Wrap it for the session first, then
    // for the agent — the order matters: the inner (agent) proxy
    // forwards payloads to the session proxy, which forwards to the
    // SDK.
    const sessionRpc = proxyWithExtraPayload(
      await coreClient({}),
      { sessionId: 'ses-1' },
    );
    const agentRpc = proxyWithExtraPayload(sessionRpc, { agentId: 'agent-1' });

    // Subscribe via the deepest proxy — the shape the subagent-host
    // bridge actually uses.
    const received: AgentEvent[] = [];
    const unsubscribe = agentRpc.onEvent((event) => {
      received.push(event);
    });
    expect(typeof unsubscribe).toBe('function');

    // Emit via the deepest proxy — the shape `agent.rpc.emitEvent`
    // uses. `proxyWithExtraPayload` merges the agentId and sessionId
    // into the event payload, mirroring how the real SDK client
    // receives events tagged with the originating session/agent.
    await agentRpc.emitEvent({ type: 'tool.call.started', toolName: 'read_file' });

    // The listener receives the event stamped with both ids.
    expect(received).toEqual([
      {
        type: 'tool.call.started',
        toolName: 'read_file',
        agentId: 'agent-1',
        sessionId: 'ses-1',
      },
    ]);

    // Unsubscribe severs the listener immediately.
    unsubscribe();
    received.length = 0;
    await agentRpc.emitEvent({ type: 'tool.result' });
    expect(received).toEqual([]);
  });

  it('does not JSON-serialize the listener when forwarding onEvent', async () => {
    // Regression guard: the listener function reference must survive
    // `proxyWithExtraPayload` and `createRPC`. If either layer wrapped
    // the call in the simulated JSON wire, the listener would arrive as
    // `undefined` and the bridge would never fire.
    const [coreClient, sdkClient] = createRPC<CoreSide, TestSDKAgentAPI>();
    const sdkImpl = new TestClientAPI();
    void sdkClient(sdkImpl);
    const sessionRpc = proxyWithExtraPayload(
      await coreClient({}),
      { sessionId: 'ses-2' },
    );
    const agentRpc = proxyWithExtraPayload(sessionRpc, { agentId: 'agent-2' });

    const listener = vi.fn();
    agentRpc.onEvent(listener);

    await agentRpc.emitEvent({ type: 'tool.call.started', toolName: 'shell' });

    // The listener identity is preserved (no JSON.stringify round-trip
    // would survive `vi.fn` reference equality). The bridge relies on
    // this so the wrapper closure inside `attachChildToolEventBridge`
    // runs as written.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      type: 'tool.call.started',
      toolName: 'shell',
      agentId: 'agent-2',
      sessionId: 'ses-2',
    });
  });
});
