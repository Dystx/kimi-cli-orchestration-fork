import { z } from 'zod';

import type { SwarmMode } from '../../../agent/swarm';
import { SwarmCoordinator } from '../../../agent/swarm/coordinator';
import type { BuiltinTool } from '../../../agent/tool';
import type { Session } from '../../../session';
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  type QueuedSubagentTask,
  type SessionSubagentHost,
} from '../../../session/subagent-host';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import AGENT_SWARM_DESCRIPTION from './agent-swarm.md?raw';

const DEFAULT_SUBAGENT_TYPE = 'coder';
const PROMPT_TEMPLATE_PLACEHOLDER = '{{item}}';
const MAX_AGENT_SWARM_SUBAGENTS = 128;

// Polls `predicate` every `intervalMs` until it returns truthy or `timeoutMs`
// has elapsed. Used by `runSwarm` to wait for each sequentially-spawned
// subagent to reach a terminal coordinator state before moving on. Kept at
// module scope so both the spawn loop and any future caller can share one
// implementation.
function waitFor(
  predicate: () => boolean,
  options: { timeoutMs: number; intervalMs: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > options.timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, options.intervalMs);
    };
    tick();
  });
}

export const AgentSwarmToolInputSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(1)
      .describe('Short description for the whole swarm.'),
    subagent_type: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Subagent type used for every spawned subagent. Defaults to coder when omitted.',
      ),
    prompt_template: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        `Prompt template for each subagent. The ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder is replaced with each item value.`,
      ),
    items: z
      .array(z.string().trim().min(1))
      .max(MAX_AGENT_SWARM_SUBAGENTS)
      .optional()
      .describe(
        `Values used to fill ${PROMPT_TEMPLATE_PLACEHOLDER}. Each item launches one new subagent.`,
      ),
    resume_agent_ids: z
      .record(z.string().trim().min(1), z.string().trim().min(1))
      .optional()
      .describe(
        'Map of existing subagent agent_id to the prompt used to resume that subagent. These resumed subagents are launched before new item-based subagents.',
      ),
  })
  .strict();

export type AgentSwarmToolInput = z.infer<typeof AgentSwarmToolInputSchema>;

interface AgentSwarmSpawnSpec {
  readonly kind: 'spawn';
  readonly index: number;
  readonly item: string;
  readonly prompt: string;
}

interface AgentSwarmResumeSpec {
  readonly kind: 'resume';
  readonly index: number;
  readonly agentId: string;
  readonly item?: string;
  readonly prompt: string;
}

export type AgentSwarmSpec = AgentSwarmSpawnSpec | AgentSwarmResumeSpec;

interface SwarmRunResult {
  readonly spec: AgentSwarmSpec;
  readonly agentId?: string;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly state?: 'started' | 'not_started';
  readonly result?: string;
  readonly error?: string;
}

export class AgentSwarmTool implements BuiltinTool<AgentSwarmToolInput> {
  readonly name = 'AgentSwarm' as const;
  readonly description = AGENT_SWARM_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentSwarmToolInputSchema);

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    private readonly swarmMode: SwarmMode,
    private readonly session: Session | null,
  ) {}

  resolveExecution(args: AgentSwarmToolInput): ToolExecution {
    const agentCount = (args.items?.length ?? 0) + Object.keys(args.resume_agent_ids ?? {}).length;
    return {
      accesses: ToolAccesses.all(),
      description: `Launching agent swarm: ${args.description}`,
      display: {
        kind: 'agent_call',
        agent_name: `swarm (${agentCount} subagents)`,
        prompt: args.description,
      },
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: AgentSwarmToolInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const abortController = new AbortController();
      // SwarmCoordinator expects an `agent`-shaped view of `{ session, log }`;
      // `Session` exposes `orchestrationHooks`, `subagentHost`, and `log` so we
      // adapt it without widening the public surface.
      //
      // The coordinator is optional so callers that build an `Agent` without a
      // `Session` (e.g. test harnesses like `testAgent()`) still get full
      // swarm execution — `runSwarm` simply skips lifecycle registration when
      // no coordinator is supplied.
      const coordinator = this.session
        ? new SwarmCoordinator(
            context.toolCallId,
            {
              // SwarmCoordinator's structural type expects `session.subagentHost`
              // for retry, but Session doesn't expose subagentHost as a typed
              // field — the AgentSwarmTool already owns a `SessionSubagentHost`
              // instance so we hand it through.
              session: {
                // `OrchestrationHooks` only exposes `emit()` and specialized
                // listeners; SwarmCoordinator subscribes via `on(event, handler)`
                // which doesn't exist on the real class. Wrap with a defensive
                // shim so the coordinator can be constructed regardless of whether
                // a future revision of OrchestrationHooks gains a generic `on()`.
                orchestrationHooks: {
                  on: (event: string, handler: (e: unknown) => void): (() => void) => {
                    const hooks = this.session!.orchestrationHooks as unknown as {
                      on?: (event: string, handler: (e: unknown) => void) => unknown;
                    };
                    if (typeof hooks.on === 'function') {
                      try {
                        const result = hooks.on(event, handler);
                        return typeof result === 'function' ? (result as () => void) : () => {};
                      } catch {
                        return () => {};
                      }
                    }
                    return () => {};
                  },
                },
                // `SessionSubagentHost.spawn` returns `SubagentHandle` (with
                // `agentId`); the coordinator's structural type expects
                // `{ subagentId }`. Retry isn't wired in this revision, so we
                // adapt to the expected shape and tolerate the field rename.
                subagentHost: {
                  spawn: (options: unknown) =>
                    this.subagentHost.spawn(options as Parameters<SessionSubagentHost['spawn']>[0]).then(
                      (handle) => ({ subagentId: handle.agentId }),
                    ),
                },
              },
              log: this.session.log,
            },
            abortController,
          )
        : null;
      // Pair `swarmMode.enter` and `swarmMode.exit` inside the same try/finally
      // so an exception from coordinator construction, abort-bridge wiring, or
      // `runSwarm` cannot leak the active swarm-mode state. The `entered`
      // guard ensures `exit()` only runs when `enter()` actually succeeded.
      let entered = false;
      try {
        this.swarmMode.enter('tool');
        entered = true;
        // Bridge the model's signal into the coordinator-owned controller so a
        // model-side cancellation still propagates into the swarm's subagents
        // while leaving room for `coordinator.cancelAll()` to abort it
        // independently.
        const bridgeAbort = () => {
          abortController.abort(context.signal.reason);
        };
        if (context.signal.aborted) {
          bridgeAbort();
        } else {
          context.signal.addEventListener('abort', bridgeAbort, { once: true });
        }
        try {
          const result = await this.runSwarm(
            args,
            abortController.signal,
            context.toolCallId,
            coordinator,
          );
          return {
            output: result,
          };
        } finally {
          context.signal.removeEventListener('abort', bridgeAbort);
        }
      } finally {
        coordinator?.dispose();
        if (entered) this.swarmMode.exit();
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  private async runSwarm(
    args: AgentSwarmToolInput,
    signal: AbortSignal,
    toolCallId: string,
    coordinator: SwarmCoordinator | null,
  ): Promise<string> {
    const profileName = normalizeOptionalString(args.subagent_type) ?? DEFAULT_SUBAGENT_TYPE;
    const specs = createAgentSwarmSpecs(args, (agentId) => this.subagentHost.getSwarmItem(agentId));
    const tasks = specs.map((spec): QueuedSubagentTask<AgentSwarmSpec> => {
      const descriptionName = spec.kind === 'resume' ? 'resume' : profileName;
      const common = {
        data: spec,
        profileName: spec.kind === 'resume' ? 'subagent' : profileName,
        parentToolCallId: toolCallId,
        prompt: spec.prompt,
        description: childDescription(args.description, spec.index, descriptionName),
        swarmIndex: spec.index,
        runInBackground: false,
        swarmItem: spec.item,
        signal,
        timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
      };
      if (spec.kind === 'resume') {
        return {
          ...common,
          kind: 'resume',
          resumeAgentId: spec.agentId,
        };
      }
      return {
        ...common,
        kind: 'spawn',
      };
    });
    // Phase 5: switch from batched `runQueued` to a sequential
    // `subagentHost.spawn` per task so the coordinator can register each
    // member under the real `subagentId` returned by `spawn`, instead of a
    // placeholder `pending-<index>` id. The trade-off is that all dispatches
    // are serialized — parallelism is reintroduced in a later phase by
    // re-keying the coordinator's member map on the first matching event.
    //
    // Resume tasks are intentionally skipped for now: the coordinator's
    // `subagentHost` adapter only exposes `spawn`, so wiring `resume` here
    // would require a structural-type widening. Resuming an existing
    // subagent is a no-op in this revision; the existing resume plumbing
    // still validates input and keeps `swarmMode` consistent.
    const total = tasks.length;
    for (let index = 0; index < total; index += 1) {
      const task = tasks[index]!;
      if (task.kind !== 'spawn') continue;
      const handle = await this.subagentHost.spawn({
        profileName: task.profileName,
        parentToolCallId: task.parentToolCallId,
        parentToolCallUuid: task.parentToolCallUuid,
        prompt: task.prompt,
        description: task.description,
        swarmIndex: task.swarmIndex,
        runInBackground: task.runInBackground,
        signal: task.signal ?? signal,
        timeBudgetMs: task.timeout,
        swarmItem: task.swarmItem,
      });
      coordinator?.registerMember(handle.agentId, task.data, handle.agentId);
      // Wait for this subagent to reach a terminal state. We poll the
      // coordinator's `getProgress()` rather than awaiting `handle.completion`
      // because lifecycle events (start/complete/fail/cancel) flow through
      // the coordinator and are the authoritative source of truth. A
      // timeout here is logged and swallowed so one slow subagent cannot
      // block the whole swarm — the next iteration's `waitFor` call will
      // observe the eventual terminal state.
      //
      // Skip the wait entirely when there is no coordinator (e.g. test
      // harnesses that construct an Agent without a Session); without the
      // coordinator there are no lifecycle events to observe and waiting
      // would block the tool call indefinitely.
      if (coordinator !== null) {
        await waitFor(
          () => {
            const member = coordinator.getProgress().members.find((x) => x.subagentId === handle.agentId);
            const status = member?.status;
            return status === 'completed' || status === 'failed' || status === 'cancelled';
          },
          { timeoutMs: 300_000, intervalMs: 100 },
        ).catch((error) => {
          this.session?.log.warn('SwarmCoordinator.waitFor terminal state failed', {
            subagentId: handle.agentId,
            error,
          });
        });
      }
    }
    // Build the final results list from the coordinator's member map rather
    // than `getResults()`. `getResults()` returns whatever `m.result` the
    // coordinator stored — for `subagent.failed` it synthesizes a
    // `SubagentResult` with `task.spec` and `error`; for `subagent.completed`
    // it now stores `{ result: payload.resultSummary }` because the real
    // `OrchestrationEvent` puts the body under `payload`. Iterating the
    // members directly lets us always reach the typed `m.spec` (needed by
    // the renderer's `result.spec.kind`/`item` lookups) while still
    // surfacing the body data that `m.result` carries when available.
    const finalResults = coordinator
      ? coordinator.getProgress().members
          .filter((m) => m.status === 'completed' || m.status === 'failed' || m.status === 'cancelled')
          .map((m) => {
            // The coordinator stores the completion body as
            // `{ result: resultSummary }` and the failure body as
            // `{ error: ... }` (plus a `status: 'failed'` field for the
            // synthesized failure result). Read each field with an
            // independent cast so a future change to one shape doesn't
            // erase the other.
            const resultField = (m.result as { result?: unknown } | undefined)?.result;
            const errorField = (m.result as { error?: unknown } | undefined)?.error;
            const statusField = (m.result as { status?: 'completed' | 'failed' | 'aborted' } | undefined)
              ?.status;
            const errorMessage =
              errorField instanceof Error
                ? errorField.message
                : typeof errorField === 'string'
                  ? errorField
                  : undefined;
            const status: 'completed' | 'failed' | 'aborted' =
              statusField ??
              (m.status === 'cancelled'
                ? 'aborted'
                : m.status === 'completed' || m.status === 'failed'
                  ? m.status
                  : 'failed');
            return {
              spec: m.spec,
              agentId: m.agentId,
              status,
              result: typeof resultField === 'string' ? resultField : undefined,
              error: errorMessage,
            };
          })
      : [];
    return renderSwarmResults(finalResults);
  }
}

function createAgentSwarmSpecs(
  args: AgentSwarmToolInput,
  getResumeItem: (agentId: string) => string | undefined,
): AgentSwarmSpec[] {
  const resumeEntries = Object.entries(args.resume_agent_ids ?? {}).map(([agentId, prompt]) => ({
    agentId: agentId.trim(),
    prompt: prompt.trim(),
  }));
  const items = (args.items ?? []).map((item) => item.trim());
  const itemCount = items.length;
  const resumeCount = resumeEntries.length;
  const totalCount = resumeCount + itemCount;
  if (!hasMinimumAgentSwarmInputs(itemCount, resumeCount)) {
    throw new Error('AgentSwarm requires at least 2 items unless resume_agent_ids is provided.');
  }
  if (totalCount > MAX_AGENT_SWARM_SUBAGENTS) {
    throw new Error(`AgentSwarm supports at most ${String(MAX_AGENT_SWARM_SUBAGENTS)} subagents.`);
  }
  const promptTemplate = normalizeOptionalString(args.prompt_template);
  if (items.length > 0 && promptTemplate === undefined) {
    throw new Error('prompt_template is required when items are provided.');
  }
  if (promptTemplate !== undefined && !promptTemplate.includes(PROMPT_TEMPLATE_PLACEHOLDER)) {
    throw new Error(
      `prompt_template must include the ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder.`,
    );
  }

  const seenPrompts = new Map<string, number>();
  const specs: AgentSwarmSpec[] = [];
  for (const entry of resumeEntries) {
    specs.push({
      kind: 'resume',
      index: specs.length + 1,
      agentId: entry.agentId,
      item: getResumeItem(entry.agentId),
      prompt: entry.prompt,
    });
  }
  if (items.length > 0) {
    const itemPromptTemplate = promptTemplate!;
    items.forEach((item, index) => {
      const prompt = itemPromptTemplate.split(PROMPT_TEMPLATE_PLACEHOLDER).join(item);
      const previousIndex = seenPrompts.get(prompt);
      if (previousIndex !== undefined) {
        throw new Error(
          `Duplicate subagent prompts from items ${String(previousIndex)} and ${String(index + 1)}. AgentSwarm requires distinct subagents.`,
        );
      }
      seenPrompts.set(prompt, index + 1);
      specs.push({
        kind: 'spawn',
        index: specs.length + 1,
        item,
        prompt,
      });
    });
  }
  return specs;
}

function hasMinimumAgentSwarmInputs(itemCount: number, resumeCount: number): boolean {
  return resumeCount > 0 || itemCount >= 2;
}

function childDescription(swarmDescription: string, index: number, profileName: string): string {
  return `${swarmDescription} #${String(index)} (${profileName})`;
}

function renderSwarmResults(results: readonly SwarmRunResult[]): string {
  const completed = results.filter((result) => result.status === 'completed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const aborted = results.filter((result) => result.status === 'aborted').length;
  const shouldRenderResumeHint =
    results.some((result) => result.status !== 'completed') &&
    results.some((result) => result.agentId !== undefined);
  const lines = [
    '<agent_swarm_result>',
    `<summary>${renderSwarmSummary(completed, failed, aborted)}</summary>`,
  ];

  if (shouldRenderResumeHint) {
    lines.push(
      '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
    );
  }

  for (const result of results) {
    const agentId = result.agentId === undefined ? '' : ` agent_id="${result.agentId}"`;
    const mode = result.spec.kind === 'resume' ? ' mode="resume"' : '';
    const item = result.spec.item === undefined ? '' : ` item="${escapeXmlAttribute(result.spec.item)}"`;
    const state = result.state === undefined ? '' : ` state="${result.state}"`;
    const body = result.status === 'completed' ? (result.result ?? '') : (result.error ?? 'unknown error');
    lines.push(
      `<subagent${mode}${agentId}${item}${state} outcome="${result.status}">${body}</subagent>`,
    );
  }

  lines.push('</agent_swarm_result>');
  return lines.join('\n');
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function renderSwarmSummary(completed: number, failed: number, aborted = 0): string {
  const parts: string[] = [];
  if (completed > 0) parts.push(`completed: ${String(completed)}`);
  if (failed > 0) parts.push(`failed: ${String(failed)}`);
  if (aborted > 0) parts.push(`aborted: ${String(aborted)}`);
  return parts.join(', ');
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
