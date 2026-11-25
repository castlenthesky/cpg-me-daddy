// REAL (U3.1.1 part 4, BMO-52): the one graph panel (controller decision 38). Plain node: a panel is a
// PanelSurface, which adapters/webview-transport.ts makes from VS Code's WebviewPanel.

import { join } from 'node:path';
import type { Disposable, GraphHost, WebviewTransport } from './contract';
import { PAGE_SCRIPT, panelHtml } from './panel-page';

/** One WebviewPanel as GraphPanel uses it. */
export interface PanelSurface {
  readonly transport: WebviewTransport;
  /** A local file's URI as this webview may load it. */
  asUri(path: string): string;
  setHtml(html: string): void;
  /** Brings the panel to the front. */
  reveal(): void;
  /** `listener` is called once, when the panel is closed by anyone. */
  onDidDispose(listener: () => void): Disposable;
  /** Closes the panel. */
  dispose(): void;
}

export interface GraphPanelOptions {
  readonly host: Pick<GraphHost, 'attach' | 'detach'>;
  /** Makes a new panel. */
  readonly create: () => PanelSurface;
  /** Where the page bundle is: pageDirectory(). */
  readonly directory: string;
}

/**
 * At most one panel at a time, attached to the host from before its HTML is set (its page's `ready`
 * comes after) until it is closed. A panel closed before its HTML is ready gets none.
 * Closing detaches the host and nothing else: the next `show` makes a new panel.
 */
export class GraphPanel {
  private readonly options: GraphPanelOptions;
  private current: PanelSurface | undefined;

  constructor(options: GraphPanelOptions) {
    this.options = options;
  }

  /** Reveals the panel, or makes it. Resolves when a panel it made has its HTML (panelHtml). */
  async show(): Promise<void> {
    if (this.current !== undefined) {
      this.current.reveal();
      return;
    }
    await this.adopt(this.options.create());
  }

  /**
   * Takes over a panel VS Code restored (WebviewPanelSerializer) as if it had been made here. When there
   * is a panel already, the restored one is closed and the panel is revealed.
   */
  async restore(surface: PanelSurface): Promise<void> {
    if (this.current !== undefined) {
      surface.dispose();
      this.current.reveal();
      return;
    }
    await this.adopt(surface);
  }

  private async adopt(surface: PanelSurface): Promise<void> {
    this.current = surface;
    surface.onDidDispose(() => {
      if (this.current === surface) {
        this.current = undefined;
        this.options.host.detach();
      }
    });
    this.options.host.attach(surface.transport);
    const { directory } = this.options;
    // Asked for now: a panel closed during the await can't answer any more.
    const script = surface.asUri(join(directory, PAGE_SCRIPT));
    const { cspSource } = surface.transport;
    const html = await panelHtml({ directory, asUri: () => script, cspSource });
    if (this.current === surface) surface.setHtml(html);
  }
}
