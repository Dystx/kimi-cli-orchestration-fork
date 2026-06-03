import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { SessionSharedStore } from '../../../session/shared-store';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export const ListSharedStateInputSchema = z.object({});

export type ListSharedStateInput = z.infer<typeof ListSharedStateInputSchema>;

export class ListSharedStateTool implements BuiltinTool<ListSharedStateInput> {
  readonly name = 'list_shared_state' as const;
  readonly description =
    'List all keys in the session-level shared key-value store. Use this to discover what state other agents have shared.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ListSharedStateInputSchema);

  constructor(private readonly store: SessionSharedStore) {}

  resolveExecution(_args: ListSharedStateInput): ToolExecution {
    return {
      description: 'Listing shared state keys',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(),
    };
  }

  private execution(): Promise<ExecutableToolResult> {
    const keys = this.store.keys();
    if (keys.length === 0) {
      return Promise.resolve({ output: 'Shared store is empty.' });
    }
    return Promise.resolve({ output: `Shared store keys:\n${keys.map((k) => `- ${k}`).join('\n')}` });
  }
}
