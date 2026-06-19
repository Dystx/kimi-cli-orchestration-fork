import { watch, type FSWatcher } from 'node:fs';

import type { Agent } from '..';
import { TODO_STORE_KEY } from '#/tools/builtin/state/todo-list';

import { parsePlanMarkdown } from './plan-parser';
import type { OrchestrationPolicy, OrchestratorResult, TurnContext } from './types';

const SYNC_DEBOUNCE_MS = 250;

export class PlanTrackingPolicy implements OrchestrationPolicy {
  readonly name = 'plan-tracking';
  private lastSyncedContent: string | null = null;
  private watcher: FSWatcher | null = null;
  private watchedPath: string | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly agent: Agent) {}

  async beforeStep(_ctx: TurnContext): Promise<OrchestratorResult> {
    try {
      if (!this.agent.planMode.isActive) {
        this.disposeWatcher();
        return { injections: [] };
      }

      const path = this.agent.planMode.planFilePath;
      if (!path) {
        return { injections: [] };
      }

      this.ensureWatcher(path);
      // If fs.watch could not attach (e.g. platform limits or permission issues),
      // fall back to reading the plan file directly on every step while plan mode
      // is active. The watcher handles live updates when it is available.
      await this.sync(path);
      return { injections: [] };
    } catch (error: unknown) {
      this.logError('beforeStep failed', error);
      return { injections: [] };
    }
  }

  dispose(): void {
    this.disposeWatcher();
    this.clearDebounceTimer();
  }

  private ensureWatcher(path: string): void {
    if (this.watchedPath === path && this.watcher !== null) {
      return;
    }

    this.disposeWatcher();

    try {
      this.watcher = watch(path, () => {
        this.debounceSync(path);
      });
      this.watchedPath = path;
    } catch (error: unknown) {
      this.logError(`could not watch ${path}`, error);
    }
  }

  private disposeWatcher(): void {
    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
      this.watchedPath = null;
    }
  }

  private debounceSync(path: string): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.sync(path);
    }, SYNC_DEBOUNCE_MS);
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private async sync(path: string): Promise<void> {
    let content = '';
    try {
      content = await this.agent.kaos.readText(path);
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code;
      if (code !== 'ENOENT') {
        this.logError(`failed to read ${path}`, error);
      }
      // Treat any unreadable plan as empty so stale todos are cleared.
      content = '';
    }

    if (content === this.lastSyncedContent) {
      return;
    }
    this.lastSyncedContent = content;

    const todos = parsePlanMarkdown(content);
    this.agent.tools.updateStore(TODO_STORE_KEY, todos);
  }

  private logError(message: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.agent.log.warn(`PlanTrackingPolicy ${message}: ${detail}`);
  }
}
