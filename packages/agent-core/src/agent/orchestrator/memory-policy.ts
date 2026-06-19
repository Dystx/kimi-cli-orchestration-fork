import type { Agent } from '../index';
import type { OrchestrationPolicy, OrchestratorResult, TurnContext } from './types';

const MEMORY_VARIANT_ORIGIN = { kind: 'injection', variant: 'memory-policy' } as const;
const REFRESH_EVERY_ASSISTANT_TURNS = 6;

export class MemoryPolicy implements OrchestrationPolicy {
  readonly name = 'memory-policy';
  private compactedSinceLastInject = false;
  private lastAssistantTurnCount = -1;

  constructor(private readonly agent: Agent) {}

  async beforeStep(_ctx: TurnContext): Promise<OrchestratorResult> {
    const store = this.agent.memoryStore;
    if (store === undefined) return { injections: [] };

    const assistantTurnCount = this.countAssistantTurns();
    const shouldInject =
      this.compactedSinceLastInject || assistantTurnCount - this.lastAssistantTurnCount >= REFRESH_EVERY_ASSISTANT_TURNS;
    if (!shouldInject) return { injections: [] };

    this.compactedSinceLastInject = false;
    this.lastAssistantTurnCount = assistantTurnCount;

    try {
      const lastUserText = this.getLastUserMessage();
      if (lastUserText.length === 0) return { injections: [] };
      const workDirTag = `workdir:${this.agent.config.cwd}`;
      const relevant = await store.findRelevant(lastUserText.slice(0, 500), undefined, 5, workDirTag);
      if (relevant.length === 0) return { injections: [] };
      return {
        injections: [
          {
            content: store.formatForInjection(relevant),
            origin: MEMORY_VARIANT_ORIGIN,
          },
        ],
      };
    } catch {
      return { injections: [] };
    }
  }

  onContextCompacted(): void {
    this.compactedSinceLastInject = true;
  }

  onContextClear(): void {
    this.compactedSinceLastInject = false;
    this.lastAssistantTurnCount = -1;
  }

  private countAssistantTurns(): number {
    let count = 0;
    for (const msg of this.agent.context.history) {
      if (msg.role === 'assistant') count += 1;
    }
    return count;
  }

  private getLastUserMessage(): string {
    for (let i = this.agent.context.history.length - 1; i >= 0; i -= 1) {
      const msg = this.agent.context.history[i];
      if (msg?.role === 'user') {
        return msg.content
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join(' ');
      }
    }
    return '';
  }
}
