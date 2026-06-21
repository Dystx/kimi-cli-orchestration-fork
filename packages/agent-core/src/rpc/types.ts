import type { RPCMethods } from './client';

type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

/**
 * Merges `U` into the payload of each RPC method on `T`, except for
 * subscription-style methods (`onEvent`) whose payload is a live
 * function reference that cannot be merged with extra payload — those
 * pass through untouched so the caller keeps the raw listener +
 * unsubscribe shape. See `createRPC` (`rpc/client.ts`) for the
 * matching runtime short-circuit.
 */
type WithExtraPayload<T, U> = {
  [K in keyof T]: K extends 'onEvent'
    ? T[K]
    : T[K] extends (payload: infer P) => infer R
      ? (payload: Prettify<P & U>) => R
      : never;
};

export type WithAgentId<T> = WithExtraPayload<T, { readonly agentId: string }>;
export type WithSessionId<T> = WithExtraPayload<T, { readonly sessionId: string }>;

export function proxyWithExtraPayload<T, U>(
  methods: RPCMethods<WithExtraPayload<T, U>>,
  extraPayload: U,
): RPCMethods<T> {
  return new Proxy(methods as any, {
    get(target, prop) {
      // `onEvent` carries a live listener (function reference) that
      // must survive across the proxy layers untouched. Merging the
      // session/agent id into a function payload would destroy the
      // reference, and the unsubscribe function it returns also needs
      // to reach the caller as a direct callable (the subagent-host
      // tool-event bridge invokes it synchronously on child shutdown).
      // The companion `createRPC` short-circuits the same method so
      // the listener never crosses the simulated JSON wire.
      if (typeof prop === 'string' && prop === 'onEvent') {
        return target[prop as keyof typeof target];
      }
      const origMethod = target[prop as keyof typeof target];
      if (typeof origMethod !== 'function') {
        return origMethod;
      }
      return (payload: any, ...args: any) => origMethod({ ...payload, ...extraPayload }, ...args);
    },
  });
}
