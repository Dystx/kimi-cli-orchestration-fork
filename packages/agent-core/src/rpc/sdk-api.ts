import type { ContentPart } from '@moonshot-ai/kosong';

import type { RPCMethods } from './client';
import type { AgentEvent, ToolInputDisplay } from './events';
import type { WithAgentId, WithSessionId } from './types';

export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';
export type ApprovalScope = 'session';

export interface ApprovalResponse {
  readonly decision: ApprovalDecision;
  readonly scope?: ApprovalScope | undefined;
  readonly feedback?: string | undefined;
  readonly selectedLabel?: string | undefined;
}

export interface ApprovalRequest {
  readonly turnId?: number | undefined;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: ToolInputDisplay;
}

export interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface QuestionItem {
  readonly question: string;
  readonly header?: string;
  readonly body?: string;
  readonly options: readonly QuestionOption[];
  readonly multiSelect?: boolean;
  readonly otherLabel?: string;
  readonly otherDescription?: string;
}

export type QuestionAnswerMethod = 'enter' | 'space' | 'number_key';
export type QuestionAnswers = Record<string, string | true>;

export interface QuestionResponse {
  readonly answers: QuestionAnswers;
  readonly method?: QuestionAnswerMethod | undefined;
}

export type QuestionResult = null | QuestionAnswers | QuestionResponse;

export interface QuestionRequest {
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly questions: readonly QuestionItem[];
}

export interface ToolCallRequest {
  readonly turnId?: number | undefined;
  readonly toolCallId: string;
  readonly args: unknown;
}

export interface ToolCallResponse {
  readonly output: string | ContentPart[];
  readonly isError?: boolean | undefined;
}

/**
 * Subscription-style methods whose payloads are not JSON-serializable
 * (they carry live function references — listener + unsubscribe — that
 * must be preserved in-process across the proxy layers). The runtime
 * path through `createRPC` and `proxyWithExtraPayload` short-circuits
 * these methods: no simulated wire round-trip, no `Promise` wrapping.
 * `RPCMethods<T>` preserves their original callable shape (it does not
 * wrap function-returning methods in a `Promise`), so the RPC types
 * built from `SDKAgentAPI` naturally carry the direct subscription
 * signature.
 */
export interface SDKAgentSubscriptions {
  /**
   * Subscribe to the per-agent event stream. The SDK delivers events
   * emitted via the agent's RPC channel — `tool.call.started`,
   * `tool.result`, lifecycle events, etc. Returns an unsubscribe
   * function the caller must invoke to detach the listener.
   */
  onEvent: (listener: (event: AgentEvent) => void) => () => void;
}

export interface SDKAgentAPI extends SDKAgentSubscriptions {
  emitEvent: (event: AgentEvent) => void;
  requestApproval: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  requestQuestion: (request: QuestionRequest) => Promise<QuestionResult>;
  toolCall: (request: ToolCallRequest) => Promise<ToolCallResponse>;
}

export type SDKAgentRPC = RPCMethods<SDKAgentAPI>;

export type SDKSessionAPI = WithAgentId<SDKAgentAPI>;
export type SDKSessionRPC = RPCMethods<SDKSessionAPI>;

export type SDKAPI = WithSessionId<SDKSessionAPI>;
export type SDKRPC = RPCMethods<SDKAPI>;
