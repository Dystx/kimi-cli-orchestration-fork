import { MoonLoader } from '../components/chrome/moon-loader';
import { StatusMessageComponent } from '../components/messages/status-message';
import {
  formatMcpStartupStatusSummary,
  mcpServerStatusKey,
  type McpServerStatusSnapshot,
} from '../utils/mcp-server-status';
import { currentTheme } from '#/tui/theme';
import type { ColorToken } from '#/tui/theme';
import type { SessionEventHost } from './session-event-handler';

export class McpStatusController {
  private readonly renderedMcpServerStatusKeys: Map<string, string> = new Map();
  private readonly mcpServerStatusSpinners: Map<string, MoonLoader> = new Map();
  private readonly mcpServers: Map<string, McpServerStatusSnapshot> = new Map();

  constructor(private readonly host: SessionEventHost) {}

  resetRuntimeState(): void {
    this.renderedMcpServerStatusKeys.clear();
    this.mcpServers.clear();
    this.stopAllSpinners();
  }

  stopAllSpinners(): void {
    for (const spinner of this.mcpServerStatusSpinners.values()) {
      spinner.stop();
    }
    this.mcpServerStatusSpinners.clear();
  }

  handleServerStatus(server: McpServerStatusSnapshot): void {
    const key = mcpServerStatusKey(server);
    if (this.renderedMcpServerStatusKeys.get(server.name) === key) return;
    this.renderedMcpServerStatusKeys.set(server.name, key);
    this.mcpServers.set(server.name, server);
    const summary = formatMcpStartupStatusSummary([...this.mcpServers.values()]);
    this.host.setAppState({ mcpServersSummary: summary || null });

    switch (server.status) {
      case 'connected': {
        const toolStr = `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`;
        const message = `MCP server "${server.name}" connected · ${toolStr} (${server.transport})`;
        this.finalizeRow(server.name, message, 'success');
        return;
      }
      case 'failed': {
        const message = `MCP server "${server.name}" failed${server.error !== undefined ? `: ${server.error}` : ''}`;
        this.finalizeRow(server.name, message, 'error');
        return;
      }
      case 'needs-auth': {
        const message = `MCP server "${server.name}" needs OAuth — run /mcp-config login ${server.name}`;
        this.finalizeRow(server.name, message, 'warning');
        return;
      }
      case 'disabled':
        this.finalizeRow(
          server.name,
          `MCP server "${server.name}" disabled`,
          'textMuted',
        );
        return;
      case 'pending':
        this.showSpinner(server.name);
        return;
    }
  }

  private showSpinner(name: string): void {
    const { state } = this.host;
    const label = `MCP server "${name}" connecting…`;
    const existing = this.mcpServerStatusSpinners.get(name);
    if (existing !== undefined) {
      existing.setLabel(label);
      return;
    }
    const tint = (s: string): string => currentTheme.fg('textMuted', s);
    const spinner = new MoonLoader(state.ui, 'braille', tint, label);
    state.transcriptContainer.addChild(spinner);
    this.mcpServerStatusSpinners.set(name, spinner);
    state.ui.requestRender();
  }

  private finalizeRow(name: string, message: string, color: ColorToken): void {
    const { state } = this.host;
    const spinner = this.mcpServerStatusSpinners.get(name);
    if (spinner === undefined) {
      this.host.showStatus(message, color);
      return;
    }
    spinner.stop();
    const status = new StatusMessageComponent(message, color);
    const children = state.transcriptContainer.children;
    const idx = children.indexOf(spinner);
    if (idx >= 0) {
      children[idx] = status;
      state.transcriptContainer.invalidate();
    } else {
      state.transcriptContainer.addChild(status);
    }
    this.mcpServerStatusSpinners.delete(name);
    state.ui.requestRender();
  }

  isAlreadyRendered(server: McpServerStatusSnapshot): boolean {
    return this.renderedMcpServerStatusKeys.has(server.name);
  }

  setRenderedKey(server: McpServerStatusSnapshot): void {
    this.renderedMcpServerStatusKeys.set(server.name, mcpServerStatusKey(server));
  }
}
