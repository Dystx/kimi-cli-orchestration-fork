import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import type { MemoryStore } from '../../../session/memory-store';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './memory-delete.md?raw';

export const MEMORY_DELETE_TOOL_NAME = 'MemoryDelete' as const;

const MemoryDeleteInputSchema = z.object({
  id: z.string().min(1).describe('Memory entry id to delete.'),
});

export interface MemoryDeleteInput {
  id: string;
}

export class MemoryDeleteTool implements BuiltinTool<MemoryDeleteInput> {
  readonly name = MEMORY_DELETE_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MemoryDeleteInputSchema);

  constructor(private readonly store: MemoryStore) {}

  resolveExecution(args: MemoryDeleteInput): ToolExecution {
    return {
      description: `Deleting memory ${args.id}`,
      approvalRule: this.name,
      execute: async () => {
        const removed = await this.store.delete(args.id);
        if (!removed) {
          return { isError: true, output: `No memory found for id ${args.id}.` };
        }
        return { isError: false, output: `Memory ${args.id} deleted.` };
      },
    };
  }
}
