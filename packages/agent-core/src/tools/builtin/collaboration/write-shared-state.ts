import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { SessionSharedStore } from '../../../session/shared-store';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export const WriteSharedStateInputSchema = z.object({
  key: z.string().describe('Key to write to the shared store'),
  value: z.string().describe('JSON-encoded value to store'),
  ttl_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Optional TTL in milliseconds. Entry will be auto-deleted after this duration.'),
});

export type WriteSharedStateInput = z.infer<typeof WriteSharedStateInputSchema>;

export class WriteSharedStateTool implements BuiltinTool<WriteSharedStateInput> {
  readonly name = 'write_shared_state' as const;
  readonly description =
    'Write a JSON value to the session-level shared key-value store. Other agents in the same session can read it with read_shared_state. Use this to share structured findings, intermediate results, or coordination state across parallel subagents.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WriteSharedStateInputSchema);

  constructor(private readonly store: SessionSharedStore) {}

  resolveExecution(args: WriteSharedStateInput): ToolExecution {
    return {
      description: `Writing shared state: ${args.key}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private execution(args: WriteSharedStateInput): Promise<ExecutableToolResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.value);
    } catch {
      // If not valid JSON, store as plain string
      parsed = args.value;
    }
    this.store.set(args.key, parsed, args.ttl_ms);
    return Promise.resolve({ output: `Stored "${args.key}" in shared store.` });
  }
}
