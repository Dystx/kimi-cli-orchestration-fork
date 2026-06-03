import { basename } from 'pathe';
import { z } from 'zod';

import type { Agent } from '../../../agent';
import type { BuiltinTool } from '../../../agent/tool';
import type { SessionMessageBus } from '../../../session/message-bus';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export const SendMessageInputSchema = z.object({
  to: z.string().describe('Agent ID of the recipient (e.g. "agent-1", "agent-2")'),
  content: z.string().describe('Message content to send'),
});

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

function agentId(agent: Agent): string {
  return agent.homedir ? basename(agent.homedir) : agent.type;
}

export class SendMessageTool implements BuiltinTool<SendMessageInput> {
  readonly name = 'send_message' as const;
  readonly description =
    'Send a direct message to another agent in the same session. The recipient can retrieve it with receive_message. Use this for lightweight coordination between parallel subagents without round-tripping through the parent.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SendMessageInputSchema);

  constructor(
    private readonly agent: Agent,
    private readonly messageBus: SessionMessageBus,
  ) {}

  resolveExecution(args: SendMessageInput): ToolExecution {
    return {
      description: `Message to ${args.to}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private execution(args: SendMessageInput): Promise<ExecutableToolResult> {
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.messageBus.send({
      id,
      from: agentId(this.agent),
      to: args.to,
      content: args.content,
      timestamp: new Date().toISOString(),
    });
    return Promise.resolve({ output: `Message sent to ${args.to}.` });
  }
}
