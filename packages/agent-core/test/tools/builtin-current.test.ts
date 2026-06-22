/**
 * Current builtin tool smoke coverage.
 *
 * This complements focused tool tests by ensuring every current builtin
 * has at least one schema assertion and one execution/error-path assertion.
 */

import { Readable, type Writable } from 'node:stream';

import type { Kaos, KaosProcess } from '@moonshot-ai/kaos';
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import type { SwarmMode } from '../../src/agent/swarm';
import { FLAG_DEFINITIONS, FlagResolver } from '../../src/flags';
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  type QueuedSubagentRunResult,
  type QueuedSubagentTask,
  type SessionSubagentHost,
} from '../../src/session/subagent-host';
import { SessionSkillRegistry } from '../../src/skill';
import { TaskListInputSchema } from '../../src/tools/background/task-list';
import { TaskOutputInputSchema } from '../../src/tools/background/task-output';
import { TaskStopInputSchema } from '../../src/tools/background/task-stop';
import { AgentTool, AgentToolInputSchema } from '../../src/tools/builtin/collaboration/agent';
import {
  AskUserQuestionInputSchema,
  AskUserQuestionTool,
} from '../../src/tools/builtin/collaboration/ask-user';
import { SkillTool, SkillToolInputSchema } from '../../src/tools/builtin/collaboration/skill-tool';
import { EditInputSchema, EditTool } from '../../src/tools/builtin/file/edit';
import { GlobInputSchema, GlobTool } from '../../src/tools/builtin/file/glob';
import { GrepInputSchema, GrepTool } from '../../src/tools/builtin/file/grep';
import { ReadInputSchema, ReadTool } from '../../src/tools/builtin/file/read';
import { WriteInputSchema, WriteTool } from '../../src/tools/builtin/file/write';
import { BashInputSchema, BashTool } from '../../src/tools/builtin/shell/bash';
import type { WorkspaceConfig } from '../../src/tools/support/workspace';
import { createFakeKaos } from './fixtures/fake-kaos';
import { executeTool } from './fixtures/execute-tool';
import { createBackgroundManager } from '../agent/background/helpers';
import {
  AgentSwarmTool,
  AgentSwarmToolInputSchema,
} from '../../src/tools/builtin/collaboration/agent-swarm';

const signal = new AbortController().signal;
const workspace: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs: [] };
const regularFileStat = {
  stMode: 0o100_644,
  stIno: 1,
  stDev: 1,
  stNlink: 1,
  stUid: 1000,
  stGid: 1000,
  stSize: 0,
  stAtime: 0,
  stMtime: 0,
  stCtime: 0,
} satisfies Awaited<ReturnType<Kaos['stat']>>;
const directoryStat = {
  ...regularFileStat,
  stMode: 0o040_755,
} satisfies Awaited<ReturnType<Kaos['stat']>>;

function context<Input>(args: Input, toolCallId = 'call_1') {
  return { turnId: '0', toolCallId, args, signal };
}

function mockSubagentHost<T extends Partial<SessionSubagentHost>>(
  host: T,
): T & SessionSubagentHost {
  return {
    spawn: vi.fn(),
    resume: vi.fn(),
    runQueued: vi.fn(),
    getSwarmItem: vi.fn(),
    ...host,
  } as unknown as T & SessionSubagentHost;
}

function agentTool(host: SessionSubagentHost): AgentTool {
  return new AgentTool(host, createBackgroundManager().manager);
}

function mockSwarmMode(): SwarmMode {
  return { enter: vi.fn(), exit: vi.fn() } as unknown as SwarmMode;
}

type MockSessionHandle = {
  orchestrationHooks: {
    on: ReturnType<typeof vi.fn>;
    emit: (event: { type: string; subagentId?: string; result?: unknown; error?: unknown; payload?: Record<string, unknown> }) => void;
  };
  log: { warn: ReturnType<typeof vi.fn> };
  recordSwarmRun: ReturnType<typeof vi.fn>;
  getSwarmRuns: ReturnType<typeof vi.fn>;
  emitSwarmSnapshot: ReturnType<typeof vi.fn>;
};

function mockSession(): MockSessionHandle & ConstructorParameters<typeof AgentSwarmTool>[2] {
  // AgentSwarmTool only requires a session that exposes the orchestration
  // hooks used by SwarmCoordinator.subscribe() and the log sink it adapts to
  // when wrapping for SwarmCoordinator's `{ session, log }` view.
  //
  // The Phase 5 `runSwarm` waits for each subagent to reach a terminal
  // coordinator state before rendering results, so the hooks mock captures
  // every registered handler and re-dispatches via `emit()` — tests can
  // drive the coordinator to `completed`/`failed` by emitting the matching
  // `subagent.*` event after the corresponding `spawn()` resolves.
  const handlers: Record<string, Array<(event: unknown) => void>> = {};
  const on = vi.fn((event: string, handler: (event: unknown) => void) => {
    (handlers[event] ??= []).push(handler);
    return () => {
      const arr = handlers[event];
      if (arr === undefined) return;
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
    };
  });
  const emit: MockSessionHandle['orchestrationHooks']['emit'] = (event) => {
    const arr = handlers[event.type];
    if (arr === undefined) return;
    for (const handler of arr.slice()) handler(event);
  };
  return {
    orchestrationHooks: { on, emit },
    log: { warn: vi.fn() },
    // Phase 9: SwarmCoordinator.dispose() now calls `session.recordSwarmRun`
    // and downstream consumers (e.g. /status, /diag) may call `getSwarmRuns`.
    // The mock session previously omitted these methods, which caused the
    // tool to surface `this.session?.recordSwarmRun is not a function` in
    // its result. Provide no-op implementations so the tool can finish.
    recordSwarmRun: vi.fn(),
    getSwarmRuns: vi.fn(() => []),
    // Phase 10: SwarmCoordinator calls `session.emitSwarmSnapshot` on every
    // member transition and on dispose (with `completedAt` set); Session
    // routes the final snapshot through `recordSwarmRun` internally. Mock
    // the entry point so the coordinator can dispatch without throwing.
    emitSwarmSnapshot: vi.fn(),
  } as unknown as MockSessionHandle & ConstructorParameters<typeof AgentSwarmTool>[2];
}

// Returns a `spawn` mock that auto-completes each spawned subagent by
// emitting `subagent.completed` (or `subagent.failed`) on the supplied
// session's hooks after the tool's `registerMember` call lands. The event
// is scheduled via `setTimeout(0)` (not `queueMicrotask`) so it fires
// after the current microtask queue drains — i.e. after the tool resumes
// from `await this.subagentHost.spawn(...)` and after
// `coordinator.registerMember` has inserted the member into its map. A
// microtask would fire too early and the event handler would not find
// the member it's looking for. The `results` array provides one entry
// per expected spawn in the order `spawn` is called. Calls beyond the
// array length still return a handle but DO NOT emit a terminal event —
// the corresponding `waitFor` in the tool will time out and the test
// will fail loudly on its own timeout, which is the right signal for
// "you didn't tell the mock how to settle this spawn."
function autoCompletingSpawn(
  session: MockSessionHandle,
  results: ReadonlyArray<{
    readonly agentId: string;
    readonly status?: 'completed' | 'failed';
    readonly result?: string;
    readonly error?: string;
  }>,
) {
  let callIndex = 0;
  return vi.fn().mockImplementation(async () => {
    const spec = results[callIndex];
    callIndex += 1;
    const agentId = spec?.agentId ?? `agent-${String(callIndex)}`;
    const status = spec?.status ?? 'completed';
    if (spec !== undefined) {
      setTimeout(() => {
        if (status === 'failed') {
          // Mirror the real `OrchestrationEvent` shape: the failure
          // message lives under `payload.error` because
          // `SessionSubagentHost.emitSubagentFailed` routes the message
          // through `orchestrationHooks.emit({ type, payload })`.
          session.orchestrationHooks.emit({
            type: 'subagent.failed',
            payload: { subagentId: agentId, error: spec.error ?? 'subagent failed' },
          });
        } else {
          // Mirror the real `OrchestrationEvent` shape: the body lives
          // under `payload.resultSummary`. `getSubagentId` still picks the
          // id out of `payload.subagentId` so the coordinator sees the
          // same member it just registered.
          session.orchestrationHooks.emit({
            type: 'subagent.completed',
            payload: { subagentId: agentId, resultSummary: spec.result ?? '' },
          });
        }
      }, 0);
    }
    return {
      agentId,
      profileName: 'coder',
      resumed: false,
      completion: Promise.resolve({ result: spec?.result ?? '', usage: undefined, changes: undefined }),
    };
  });
}

function processWithOutput(stdout: string, exitCode = 0): KaosProcess {
  const stdoutStream = Readable.from([stdout]);
  const stderrStream = Readable.from([]);
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: stdoutStream,
    stderr: stderrStream,
    pid: 123,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode),
    kill: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(async () => {
      stdoutStream.destroy();
      stderrStream.destroy();
    }),
  };
}

describe('current builtin file and shell tools', () => {
  it('Read exposes parameters and reads text content', async () => {
    const content = 'alpha\nbeta\n';
    const bytes = Buffer.from(content, 'utf8');
    const tool = new ReadTool(
      createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue(regularFileStat),
        readBytes: vi.fn<Kaos['readBytes']>().mockImplementation(async (_path, n) => {
          return n === undefined ? bytes : bytes.subarray(0, n);
        }),
        readLines: vi.fn<Kaos['readLines']>().mockImplementation(async function* readLines() {
          yield 'alpha\n';
          yield 'beta\n';
        }),
      }),
      workspace,
    );

    expect(ReadInputSchema.safeParse({ path: '/workspace/a.txt' }).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } },
    });

    const result = await executeTool(tool, context({ path: '/workspace/a.txt' }));
    expect(result.output).toBe(
      [
        '1\talpha',
        '2\tbeta',
        '<system>2 lines read from file starting from line 1. Total lines in file: 2. End of file reached.</system>',
      ].join('\n'),
    );
  });

  it('Write exposes parameters and writes through kaos', async () => {
    const writeText = vi.fn().mockResolvedValue(5);
    const tool = new WriteTool(
      createFakeKaos({ writeText, stat: vi.fn<Kaos['stat']>().mockResolvedValue(directoryStat) }),
      workspace,
    );

    expect(WriteInputSchema.safeParse({ path: '/workspace/a.txt', content: 'hello' }).success).toBe(
      true,
    );
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { content: { type: 'string' } },
    });

    const result = await executeTool(tool, context({ path: '/workspace/a.txt', content: 'hello' }));
    expect(writeText).toHaveBeenCalledWith('/workspace/a.txt', 'hello');
    expect(result.output).toContain('Wrote 5 bytes');
  });

  it('Edit exposes parameters and errors when old_string is missing', async () => {
    const tool = new EditTool(
      createFakeKaos({ readText: vi.fn().mockResolvedValue('alpha\nbeta\n') }),
      workspace,
    );

    expect(
      EditInputSchema.safeParse({
        path: '/workspace/a.txt',
        old_string: 'gamma',
        new_string: 'delta',
      }).success,
    ).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { old_string: { type: 'string' } },
    });

    const result = await executeTool(tool,
      context({ path: '/workspace/a.txt', old_string: 'gamma', new_string: 'delta' }),
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('old_string not found');
  });

  it('Glob exposes parameters and walks pure-wildcard patterns capped at MAX_MATCHES', async () => {
    // Pure wildcards used to be rejected up-front; now they walk like
    // any other pattern and the 100-match cap is the only safety.
    const glob = vi.fn().mockReturnValue(
      (async function* () {
        yield '/workspace/a.ts';
      })(),
    );
    const tool = new GlobTool(
      createFakeKaos({
        glob,
        stat: vi.fn().mockResolvedValue({ stMtime: 1, stMode: 0o100000 }),
      }),
      workspace,
    );

    expect(GlobInputSchema.safeParse({ pattern: '*.ts' }).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { pattern: { type: 'string' } },
    });

    const result = await executeTool(tool, context({ pattern: '**' }));
    expect(result.isError).toBeFalsy();
    expect(glob).toHaveBeenCalledWith('/workspace', '**');
    expect(result.output).toContain('a.ts');
  });

  it('Grep exposes parameters and rejects relative workspace escapes before spawning rg', async () => {
    const kaos = createFakeKaos({ exec: vi.fn() });
    const tool = new GrepTool(kaos, workspace);

    expect(GrepInputSchema.safeParse({ pattern: 'needle' }).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { pattern: { type: 'string' } },
    });

    const result = await executeTool(tool, context({ pattern: 'needle', path: '../outside' }));
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('outside the working directory');
    expect(kaos.exec).not.toHaveBeenCalled();
  });

  it('Bash exposes parameters and returns foreground stdout', async () => {
    const tool = new BashTool(
      createFakeKaos({
        execWithEnv: vi.fn().mockResolvedValue(processWithOutput('ok\n')),
        osEnv: {
          osKind: 'Linux',
          osArch: 'arm64',
          osVersion: 'test',
          shellPath: '/bin/bash',
          shellName: 'bash',
        },
      }),
      '/workspace',
      createBackgroundManager().manager,
    );

    expect(BashInputSchema.safeParse({ command: 'printf ok' }).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { command: { type: 'string' } },
    });

    const result = await executeTool(tool, context({ command: 'printf ok', timeout: 1000 }));
    expect(result).toMatchObject({ output: 'ok\n' });
  });
});

describe('current builtin collaboration tools', () => {
  it('AskUserQuestion exposes parameters and asks through rpc in yolo mode', async () => {
    const tool = new AskUserQuestionTool({
      experimentalFlags: new FlagResolver({}, FLAG_DEFINITIONS),
      permission: { mode: 'yolo' },
      rpc: {
        requestQuestion: vi.fn(async () => ({ 'Which path?': 'A' })),
      },
      telemetry: { track: vi.fn() },
    } as unknown as Agent);

    const input = {
      questions: [
        {
          question: 'Which path?',
          header: 'Path',
          options: [
            { label: 'A', description: 'Use A' },
            { label: 'B', description: 'Use B' },
          ],
          multi_select: false,
        },
      ],
    };
    expect(AskUserQuestionInputSchema.safeParse(input).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { questions: { type: 'array' } },
    });

    const result = await executeTool(tool, context(input));
    expect(result.output).toBe(JSON.stringify({ answers: { 'Which path?': 'A' } }));
  });

  it('Agent exposes parameters and returns a foreground subagent summary', async () => {
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion: Promise.resolve({ result: 'child result' }),
      }),
    });
    const tool = agentTool(host);

    const input = { prompt: 'Investigate', description: 'Find cause' };
    expect(AgentToolInputSchema.safeParse(input).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { prompt: { type: 'string' } },
    });

    const result = await executeTool(tool, context(input, 'call_agent'));
    expect(host.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'coder',
        parentToolCallId: 'call_agent',
        prompt: 'Investigate',
        description: 'Find cause',
        runInBackground: false,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.output).toContain('child result');
  });

  it('AgentSwarm applies one subagent_type across templated subagents', async () => {
    const session = mockSession();
    const spawn = autoCompletingSpawn(session, [
      { agentId: 'agent-explore-1', status: 'completed', result: 'explore result a' },
      { agentId: 'agent-explore-2', status: 'completed', result: 'explore result b' },
    ]);
    const host = mockSubagentHost({ spawn: spawn as unknown as SessionSubagentHost['spawn'] });
    const swarmMode = mockSwarmMode();
    const tool = new AgentSwarmTool(host, swarmMode, session);
    const input = {
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
      subagent_type: 'explore',
    };

    expect(AgentSwarmToolInputSchema.safeParse(input).success).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
        ...input,
        items: Array.from({ length: 128 }, (_, index) => `src/${String(index + 1)}.ts`),
      }).success,
    ).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
        ...input,
        items: Array.from({ length: 129 }, (_, index) => `src/${String(index + 1)}.ts`),
      }).success,
    ).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        subagent_type: { type: 'string' },
      },
    });
    expect(Object.keys(tool.parameters['properties'] as Record<string, unknown>).at(-1)).toBe(
      'resume_agent_ids',
    );

    const result = await executeTool(tool, context(input, 'call_swarm'));

    expect(swarmMode.enter).toHaveBeenCalledWith('tool');
    // Phase 5: dispatch is sequential via `subagentHost.spawn`, not batched
    // `runQueued`. Each call must carry the templated prompt and the shared
    // `parentToolCallId` so the coordinator can correlate lifecycle events
    // back to the parent tool call.
    expect(host.runQueued).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        profileName: 'explore',
        parentToolCallId: 'call_swarm',
        prompt: 'Review src/a.ts',
        description: 'Review files #1 (explore)',
        swarmIndex: 1,
        swarmItem: 'src/a.ts',
        runInBackground: false,
        timeBudgetMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
      }),
    );
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        profileName: 'explore',
        parentToolCallId: 'call_swarm',
        prompt: 'Review src/b.ts',
        description: 'Review files #2 (explore)',
        swarmIndex: 2,
        swarmItem: 'src/b.ts',
        runInBackground: false,
        timeBudgetMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
      }),
    );
    expect(result.output).toBe([
      '<agent_swarm_result>',
      '<summary>completed: 2</summary>',
      '<subagent agent_id="agent-explore-1" item="src/a.ts" outcome="completed">explore result a</subagent>',
      '<subagent agent_id="agent-explore-2" item="src/b.ts" outcome="completed">explore result b</subagent>',
      '<post_swarm_reminder>The AgentSwarm run has finished. Synthesize the subagent results above and respond to the user. Do not call AgentSwarm again unless the user explicitly asks for more parallel subagents.</post_swarm_reminder>',
      '</agent_swarm_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
  });

  it('AgentSwarm does not expose permission rule argument matching', () => {
    const tool = new AgentSwarmTool(mockSubagentHost({}), mockSwarmMode(), mockSession());
    const execution = tool.resolveExecution({
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
    });
    if (execution.isError === true) throw new Error('AgentSwarm resolveExecution returned an error');

    expect(execution.approvalRule).toBe('AgentSwarm');
    expect(execution.matchesRule).toBeUndefined();
  });

  it('AgentSwarm rejects more than 128 subagents at execution time', async () => {
    const host = mockSubagentHost({ runQueued: vi.fn() });
    const swarmMode = mockSwarmMode();
    const tool = new AgentSwarmTool(host, swarmMode, mockSession());

    const result = await executeTool(
      tool,
      context({
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: Array.from({ length: 129 }, (_, index) => `src/${String(index + 1)}.ts`),
      }),
    );

    expect(result.output).toBe('AgentSwarm supports at most 128 subagents.');
    expect(result.isError).toBe(true);
    expect(host.runQueued).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'a single item without resumed agents',
      input: {
        description: 'Review one file',
        prompt_template: 'Review {{item}}',
        items: ['src/only.ts'],
      },
      output: 'AgentSwarm requires at least 2 items unless resume_agent_ids is provided.',
    },
    {
      name: 'items without a prompt template',
      input: {
        description: 'Review files',
        items: ['src/a.ts', 'src/b.ts'],
      },
      output: 'prompt_template is required when items are provided.',
    },
    {
      name: 'a prompt template without the item placeholder',
      input: {
        description: 'Review files',
        prompt_template: 'Review files',
        items: ['src/a.ts', 'src/b.ts'],
      },
      output: 'prompt_template must include the {{item}} placeholder.',
    },
  ])('AgentSwarm rejects $name at execution time', async ({ input, output }) => {
    const host = mockSubagentHost({ runQueued: vi.fn() });
    const swarmMode = mockSwarmMode();
    const tool = new AgentSwarmTool(host, swarmMode, mockSession());

    const result = await executeTool(tool, context(input));

    expect(result.output).toBe(output);
    expect(result.isError).toBe(true);
    expect(host.runQueued).not.toHaveBeenCalled();
  });

  it('AgentSwarm resumes mapped agents before spawning item subagents', async () => {
    // Phase 5: resume tasks are intentionally not dispatched by the new
    // sequential loop — the coordinator's `subagentHost` adapter only
    // exposes `spawn`, so wiring `resume` would require a structural-type
    // widening that's deferred to a later phase. The schema still accepts
    // `resume_agent_ids` and the input is still valid; only the dispatched
    // spawns (the one item) are observed.
    const session = mockSession();
    const spawn = autoCompletingSpawn(session, [
      { agentId: 'agent-new-3', status: 'completed', result: 'result 3' },
    ]);
    const persistedItems: Record<string, string> = {
      'agent-old-1': 'src/old-a.ts',
      'agent-old-2': 'src/old-b.ts',
    };
    const host = mockSubagentHost({
      getSwarmItem: vi.fn((agentId: string) => persistedItems[agentId]),
      spawn: spawn as unknown as SessionSubagentHost['spawn'],
    });
    const swarmMode = mockSwarmMode();
    const tool = new AgentSwarmTool(host, swarmMode, session);
    const input = {
      description: 'Finish review',
      subagent_type: 'explore',
      prompt_template: 'Review {{item}}',
      items: ['src/new.ts'],
      resume_agent_ids: {
        'agent-old-1': 'Continue previous review A',
        'agent-old-2': 'Continue previous review B',
      },
    };

    expect(AgentSwarmToolInputSchema.safeParse(input).success).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
        description: 'Resume two agents',
        resume_agent_ids: {
          'agent-old-1': 'Continue previous review A',
          'agent-old-2': 'Continue previous review B',
        },
      }).success,
    ).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
        description: 'Resume one agent',
        resume_agent_ids: {
          'agent-old-1': 'Continue previous review A',
        },
      }).success,
    ).toBe(true);

    const result = await executeTool(tool, context(input, 'call_swarm'));

    // Only the spawn (item) is dispatched; the two resume entries are
    // skipped by the Phase 5 loop. The rendered XML therefore contains
    // a single `<subagent>` for the new agent.
    expect(host.runQueued).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'explore',
        parentToolCallId: 'call_swarm',
        prompt: 'Review src/new.ts',
        description: 'Finish review #3 (explore)',
        swarmIndex: 3,
        swarmItem: 'src/new.ts',
      }),
    );
    expect(result.output).toBe([
      '<agent_swarm_result>',
      '<summary>completed: 1</summary>',
      '<subagent agent_id="agent-new-3" item="src/new.ts" outcome="completed">result 3</subagent>',
      '<post_swarm_reminder>The AgentSwarm run has finished. Synthesize the subagent results above and respond to the user. Do not call AgentSwarm again unless the user explicitly asks for more parallel subagents.</post_swarm_reminder>',
      '</agent_swarm_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
  });

  it('AgentSwarm allows a single resumed subagent without item subagents', async () => {
    // Phase 5: the schema still accepts `resume_agent_ids` as the sole input
    // (no items) and `getSwarmItem` is consulted for the persisted item, but
    // the sequential loop does not dispatch resume tasks. Add a second item
    // so the input also has a dispatched spawn, which gives the test a
    // non-empty swarm to assert against.
    const session = mockSession();
    const spawn = autoCompletingSpawn(session, [
      { agentId: 'agent-new-a', status: 'completed', result: 'result a' },
      { agentId: 'agent-new-b', status: 'completed', result: 'result b' },
    ]);
    const host = mockSubagentHost({
      getSwarmItem: vi.fn((agentId: string) =>
        agentId === 'agent-old-1' ? 'src/old-a.ts' : undefined,
      ),
      spawn: spawn as unknown as SessionSubagentHost['spawn'],
    });
    const swarmMode = mockSwarmMode();
    const tool = new AgentSwarmTool(host, swarmMode, session);
    const input = {
      description: 'Resume review',
      prompt_template: 'Review {{item}}',
      items: ['src/new-a.ts', 'src/new-b.ts'],
      resume_agent_ids: {
        'agent-old-1': 'Continue previous review A',
      },
    };

    expect(AgentSwarmToolInputSchema.safeParse(input).success).toBe(true);

    const result = await executeTool(tool, context(input, 'call_swarm'));

    expect(host.runQueued).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(result.output).toBe([
      '<agent_swarm_result>',
      '<summary>completed: 2</summary>',
      '<subagent agent_id="agent-new-a" item="src/new-a.ts" outcome="completed">result a</subagent>',
      '<subagent agent_id="agent-new-b" item="src/new-b.ts" outcome="completed">result b</subagent>',
      '<post_swarm_reminder>The AgentSwarm run has finished. Synthesize the subagent results above and respond to the user. Do not call AgentSwarm again unless the user explicitly asks for more parallel subagents.</post_swarm_reminder>',
      '</agent_swarm_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
  });

  it('AgentSwarm reports failed subagents inside the XML result without failing the tool', async () => {
    const session = mockSession();
    const spawn = autoCompletingSpawn(session, [
      { agentId: 'agent-coder-1', status: 'completed', result: 'imports are stable' },
      { agentId: 'agent-coder-2', status: 'failed', error: 'Agent timed out after 30s.' },
    ]);
    const host = mockSubagentHost({ spawn: spawn as unknown as SessionSubagentHost['spawn'] });
    const swarmMode = mockSwarmMode();
    const tool = new AgentSwarmTool(host, swarmMode, session);

    const result = await executeTool(
      tool,
      context(
        {
          description: 'Review files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts'],
        },
        'call_swarm',
      ),
    );

    expect(result.output).toBe([
      '<agent_swarm_result>',
      '<summary>completed: 1, failed: 1</summary>',
      '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
      '<subagent agent_id="agent-coder-1" item="src/a.ts" outcome="completed">imports are stable</subagent>',
      '<subagent agent_id="agent-coder-2" item="src/b.ts" outcome="failed">Agent timed out after 30s.</subagent>',
      '<post_swarm_reminder>The AgentSwarm run has finished. Synthesize the subagent results above and respond to the user. Do not call AgentSwarm again unless the user explicitly asks for more parallel subagents.</post_swarm_reminder>',
      '</agent_swarm_result>',
    ].join('\n'));
    expect(swarmMode.enter).toHaveBeenCalledWith('tool');
    expect(result.isError).toBeUndefined();
  });

  it('AgentSwarm always renders the resume hint when any subagent is incomplete', async () => {
    // The old "omits resume hint" branch (no `agent_id` → no hint) no
    // longer applies under Phase 5: `registerMember` is always called with
    // the real `agentId` from `subagentHost.spawn`, so every member has
    // an `agent_id` once the swarm finishes. The renderer's
    // `shouldRenderResumeHint` check therefore always fires when at least
    // one subagent is incomplete — this test pins that behavior so a
    // future regression that drops the hint will be caught.
    const session = mockSession();
    const spawn = autoCompletingSpawn(session, [
      { agentId: 'agent-failed-a', status: 'failed', error: 'Agent did not start.' },
      { agentId: 'agent-failed-b', status: 'failed', error: 'Agent also did not start.' },
    ]);
    const host = mockSubagentHost({ spawn: spawn as unknown as SessionSubagentHost['spawn'] });
    const swarmMode = mockSwarmMode();
    const tool = new AgentSwarmTool(host, swarmMode, session);

    const result = await executeTool(
      tool,
      context(
        {
          description: 'Review files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts'],
        },
        'call_swarm',
      ),
    );

    expect(result.output).toBe([
      '<agent_swarm_result>',
      '<summary>failed: 2</summary>',
      '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
      '<subagent agent_id="agent-failed-a" item="src/a.ts" outcome="failed">Agent did not start.</subagent>',
      '<subagent agent_id="agent-failed-b" item="src/b.ts" outcome="failed">Agent also did not start.</subagent>',
      '<post_swarm_reminder>The AgentSwarm run has finished. Synthesize the subagent results above and respond to the user. Do not call AgentSwarm again unless the user explicitly asks for more parallel subagents.</post_swarm_reminder>',
      '</agent_swarm_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
  });

  it('AgentSwarm renders multiple completed subagents in spawn order', async () => {
    // The old "partial aborted" branch from the `runQueued` path no longer
    // applies: the new sequential loop waits for each subagent's terminal
    // coordinator state, and the renderer only includes members whose
    // status is `completed`/`failed`/`cancelled`. A subagent that stays in
    // `spawned` would block the tool's `waitFor` for its full 5-minute
    // budget, which is the wrong signal for a test. This test instead
    // covers the next-most-useful scenario: multiple completed spawns
    // rendered in the order they were dispatched, which guards against a
    // future refactor accidentally re-ordering or dropping members from
    // the final XML.
    const session = mockSession();
    const spawn = autoCompletingSpawn(session, [
      { agentId: 'agent-coder-1', status: 'completed', result: 'result a' },
      { agentId: 'agent-coder-2', status: 'completed', result: 'result b' },
      { agentId: 'agent-coder-3', status: 'completed', result: 'result c' },
    ]);
    const host = mockSubagentHost({ spawn: spawn as unknown as SessionSubagentHost['spawn'] });
    const swarmMode = mockSwarmMode();
    const tool = new AgentSwarmTool(host, swarmMode, session);

    const result = await executeTool(
      tool,
      context(
        {
          description: 'Review files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        },
        'call_swarm',
      ),
    );

    expect(result.output).toBe([
      '<agent_swarm_result>',
      '<summary>completed: 3</summary>',
      '<subagent agent_id="agent-coder-1" item="src/a.ts" outcome="completed">result a</subagent>',
      '<subagent agent_id="agent-coder-2" item="src/b.ts" outcome="completed">result b</subagent>',
      '<subagent agent_id="agent-coder-3" item="src/c.ts" outcome="completed">result c</subagent>',
      '<post_swarm_reminder>The AgentSwarm run has finished. Synthesize the subagent results above and respond to the user. Do not call AgentSwarm again unless the user explicitly asks for more parallel subagents.</post_swarm_reminder>',
      '</agent_swarm_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
  });

  it('Skill exposes parameters and reports unknown skills as tool errors', async () => {
    const tool = new SkillTool({
      skills: {
        registry: new SessionSkillRegistry(),
        recordActivation: vi.fn(),
      },
      context: {
        appendSystemReminder: vi.fn(),
      },
    } as unknown as Agent);

    expect(SkillToolInputSchema.safeParse({ skill: 'missing' }).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { skill: { type: 'string' } },
    });

    const result = await executeTool(tool, context({ skill: 'missing' }));
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('not found');
  });
});

describe('current builtin background tool schemas', () => {
  it('background task schemas and manager-backed tools are covered', () => {
    const manager = createBackgroundManager().manager;

    expect(TaskListInputSchema.safeParse({ active_only: true }).success).toBe(true);
    expect(TaskOutputInputSchema.safeParse({ task_id: 'bash-1' }).success).toBe(true);
    expect(TaskStopInputSchema.safeParse({ task_id: 'bash-1' }).success).toBe(true);
    expect(manager.list()).toEqual([]);
  });
});
