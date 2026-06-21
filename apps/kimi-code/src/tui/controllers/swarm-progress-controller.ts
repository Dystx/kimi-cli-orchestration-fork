import type { SwarmRunSnapshot, SwarmRunSnapshotEvent } from '@moonshot-ai/kimi-code-sdk';

import { SwarmProgressMessage } from '../components/messages/swarm-progress';
import { UsagePanelComponent } from '../components/messages/usage-panel';
import type { SessionEventHost } from './session-event-handler';

/**
 * Mounts a single live `UsagePanelComponent` while a swarm run is in flight.
 *
 * Behaviour:
 * - On the first in-flight snapshot (`completedAt` absent), mount the panel.
 * - On every subsequent in-flight snapshot, replace the cached lines and
 *   request a re-render. The panel keeps its position in the transcript.
 * - On the first `completedAt`-bearing snapshot for a run, unmount the panel.
 * - `resetRuntimeState()` clears any stale panel when the host resets.
 *
 * The panel always reads the latest snapshot via the `buildLines` callback
 * passed to `UsagePanelComponent`, so theme switches and resizes also pick up
 * the current state.
 */
export class SwarmProgressController {
  private panel: UsagePanelComponent | undefined;
  private currentSnapshot: SwarmRunSnapshot | undefined;

  constructor(private readonly host: SessionEventHost) {}

  resetRuntimeState(): void {
    this.unmountPanel();
    this.currentSnapshot = undefined;
  }

  handleEvent(event: SwarmRunSnapshotEvent): void {
    const snapshot = event.snapshot;
    if (snapshot.completedAt !== undefined) {
      this.unmountPanel();
      this.currentSnapshot = undefined;
      return;
    }
    this.currentSnapshot = snapshot;
    if (this.panel === undefined) {
      this.mountPanel();
      return;
    }
    this.panel.invalidate();
    this.host.state.ui.requestRender();
  }

  private mountPanel(): void {
    const initial = this.currentSnapshot;
    if (initial === undefined) return;
    this.panel = new UsagePanelComponent(
      () => (this.currentSnapshot !== undefined
        ? SwarmProgressMessage({ snapshot: this.currentSnapshot })
        : []),
      'primary',
      ` Swarm ${initial.runId} `,
    );
    this.host.state.transcriptContainer.addChild(this.panel);
    this.host.state.ui.requestRender();
  }

  private unmountPanel(): void {
    if (this.panel === undefined) return;
    // `pi-tui`'s `Container` exposes `removeChild` rather than the DOM-style
    // `.remove()`; the unicorn rule targets the DOM API and does not apply.
    // oxlint-disable-next-line unicorn/prefer-dom-node-remove
    this.host.state.transcriptContainer.removeChild(this.panel);
    this.panel = undefined;
    this.host.state.ui.requestRender();
  }
}