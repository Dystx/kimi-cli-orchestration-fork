import { basename } from 'pathe';
import { z } from 'zod';

import type { Agent } from '../../../agent';
import type { BuiltinTool } from '../../../agent/tool';
import type { SessionMessageBus } from '../../../session/message-bus';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export const ReceiveMessageInputSchema = z.object({
  mark_read: z
    .boolean()
    .optional()
    .default(true)
    .describe('If true (default), consumed messages are removed from the inbox.'),
});

export type ReceiveMessageInput = z.infer<typeof ReceiveMessageInputSchema>;

function agentId(agent: Agent): string {
  return agent.homedir ? basename(agent.homedir) : agent.type;
}

export class ReceiveMessageTool implements BuiltinTool<ReceiveMessageInput> {
  readonly name = 'receive_message' as const;
  readonly description =
    'Retrieve messages sent to this agent by other agents in the same session. Returns all pending messages; by default they are removed from the inbox after retrieval.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReceiveMessageInputSchema);

  constructor(
    private readonly agent: Agent,
    private readonly messageBus: SessionMessageBus,
  ) {}

  resolveExecution(args: ReceiveMessageInput): ToolExecution {
    return {
      description: 'Checking inbox',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private execution(args: ReceiveMessageInput): Promise<ExecutableToolResult> {
    const id = agentId(this.agent);
    const messages = args.mark_read ? this.messageBus.receive(id) : [...this.messageBus.peek(id)];
    if (messages.length === 0) {
      return Promise.resolve({ output: 'No new messages.' });
    }
    const lines: string[] = [`Received ${messages.length} message(s):`, ''];
    for (const msg of messages) {
      lines.push(`From: ${msg.from}  (${msg.timestamp})`);
      lines.push(msg.content);
      lines.push('');
    }
    return Promise.resolve({ output: lines.join('\n') });
  }
}
