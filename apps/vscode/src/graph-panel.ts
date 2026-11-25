// SEAT (U3.1.1 part 4, BMO-52): the one graph panel (controller decision 38). Plain node: a panel is a
// PanelSurface, which adapters/webview-transport.ts makes from VS Code's WebviewPanel.

import type { Disposable, GraphHost, WebviewTransport } from './contract';

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

  constructor(options: GraphPanelOptions) {
    this.options = options;
  }

  /** Reveals the panel, or makes it. Resolves when a panel it made has its HTML (panelHtml). */
  show(): Promise<void> {
    throw new Error('SEAT: GraphPanel.show (U3.1.1 part 4)');
  }

  /**
   * Takes over a panel VS Code restored (WebviewPanelSerializer) as if it had been made here. When there
   * is a panel already, the restored one is closed and the panel is revealed.
   */
  restore(_surface: PanelSurface): Promise<void> {
    throw new Error('SEAT: GraphPanel.restore (U3.1.1 part 4)');
  }
}
