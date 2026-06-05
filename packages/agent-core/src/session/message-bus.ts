import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'pathe';

export interface AgentMessage {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly content: string;
  readonly timestamp: string;
}

/**
 * Simple in-memory message bus for inter-agent communication within a session.
 * Messages are queued per recipient and consumed (not persisted) when received.
 */
export class SessionMessageBus {
  private readonly queues = new Map<string, AgentMessage[]>();

  send(message: AgentMessage): void {
    const queue = this.queues.get(message.to) ?? [];
    queue.push(message);
    this.queues.set(message.to, queue);
  }

  receive(agentId: string): AgentMessage[] {
    const queue = this.queues.get(agentId) ?? [];
    this.queues.delete(agentId);
    return queue;
  }

  peek(agentId: string): readonly AgentMessage[] {
    return this.queues.get(agentId) ?? [];
  }

  hasMessages(agentId: string): boolean {
    return (this.queues.get(agentId)?.length ?? 0) > 0;
  }

  clear(): void {
    this.queues.clear();
  }

  async save(homedir: string): Promise<void> {
    const path = join(homedir, '.omk', 'state', 'messages.json');
    await mkdir(dirname(path), { recursive: true });
    const data: Record<string, AgentMessage[]> = {};
    for (const [agentId, messages] of this.queues) {
      data[agentId] = messages;
    }
    await writeFile(path, JSON.stringify(data), 'utf-8');
  }

  async load(homedir: string): Promise<void> {
    try {
      const path = join(homedir, '.omk', 'state', 'messages.json');
      const text = await readFile(path, 'utf-8');
      const data = JSON.parse(text) as Record<string, AgentMessage[]>;
      for (const [agentId, messages] of Object.entries(data)) {
        this.queues.set(agentId, messages);
      }
    } catch {
      // ignore
    }
  }
}
