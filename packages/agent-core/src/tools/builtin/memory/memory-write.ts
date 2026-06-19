import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import type { MemoryStore } from '../../../session/memory-store';
import { toInputJsonSchema } from '../../support/input-schema';
import type { MemoryType } from '../../../agent/memory/types';
import DESCRIPTION from './memory-write.md?raw';

export const MEMORY_WRITE_TOOL_NAME = 'MemoryWrite' as const;

const MemoryWriteInputSchema = z.object({
  content: z.string().min(1).describe('Fact, insight, decision, preference, or snippet to remember.'),
  tags: z.array(z.string()).optional().describe('Optional tags to attach to the memory.'),
  type: z
    .enum(['fact', 'insight', 'decision', 'preference', 'snippet'])
    .optional()
    .describe('Optional classification; defaults to "fact".'),
});

export interface MemoryWriteInput {
  content: string;
  tags?: string[];
  type?: MemoryType;
}

export class MemoryWriteTool implements BuiltinTool<MemoryWriteInput> {
  readonly name = MEMORY_WRITE_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MemoryWriteInputSchema);

  constructor(private readonly store: MemoryStore) {}

  resolveExecution(args: MemoryWriteInput): ToolExecution {
    return {
      description: `Writing memory: ${args.content.slice(0, 60)}`,
      approvalRule: this.name,
      execute: async () => {
        const memory = await this.store.write({
          content: args.content,
          tags: args.tags,
          type: args.type,
        });
        return {
          isError: false,
          output: `Memory stored with id ${memory.id}.`,
        };
      },
    };
  }
}
