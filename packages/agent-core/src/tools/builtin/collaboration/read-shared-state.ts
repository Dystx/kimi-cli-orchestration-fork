import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { SessionSharedStore } from '../../../session/shared-store';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export const ReadSharedStateInputSchema = z.object({
  key: z.string().describe('Key to read from the shared store'),
});

export type ReadSharedStateInput = z.infer<typeof ReadSharedStateInputSchema>;

export class ReadSharedStateTool implements BuiltinTool<ReadSharedStateInput> {
  readonly name = 'read_shared_state' as const;
  readonly description =
    'Read a value from the session-level shared key-value store. Use this to access structured data written by other agents (e.g. exploration results, analysis summaries, or coordination flags).';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReadSharedStateInputSchema);

  constructor(private readonly store: SessionSharedStore) {}

  resolveExecution(args: ReadSharedStateInput): ToolExecution {
    return {
      description: `Reading shared state: ${args.key}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private execution(args: ReadSharedStateInput): Promise<ExecutableToolResult> {
    const value = this.store.get(args.key);
    if (value === undefined) {
      return Promise.resolve({ output: `Key "${args.key}" not found in shared store.` });
    }
    return Promise.resolve({ output: JSON.stringify(value, null, 2) });
  }
}
