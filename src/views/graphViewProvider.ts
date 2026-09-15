import * as vscode from 'vscode';
// Deep imports, deliberately: the package's main entry (index.ts) pulls in
// @cosmos.gl/graph (browser/DOM code, ESM-only) via visualizer.ts, which the
// CommonJS extension host cannot load, and whose types the host's tsconfig
// (no "dom" in lib) can't resolve either. contract.ts and shell.ts have no
// dependencies of their own — importing them directly never pulls that in.
// See packages/graph-visualizer/AGENTS.md.
import { applyGraphDelta, type GraphDelta, type GraphPayload } from '@cpg/graph-visualizer/dist/contract';
import { graphWebviewHtml } from '@cpg/graph-visualizer/dist/shell';

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return nonce;
}

export class GraphViewProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private ready = false;
	// The last payload we were asked to show. Re-sent whenever the webview
	// (re)announces readiness, since a hide/reload can reset `ready` without
	// this class being told to post again.
	private lastPayload?: GraphPayload;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly log: (message: string) => void = () => {}
	) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		this.ready = false;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'out')],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);

		// The webview's script runs asynchronously after this HTML is set, so
		// posting a message right here can arrive before its listener exists.
		// The webview announces readiness instead; only then do we flush.
		webviewView.webview.onDidReceiveMessage((message: { type?: string }) => {
			this.log(`graph webview message: ${JSON.stringify(message)}`);
			if (message?.type === 'ready') {
				this.ready = true;
				this.flushPayload();
			}
		});
	}

	postGraph(payload: GraphPayload): void {
		this.lastPayload = payload;
		this.flushPayload();
	}

	/**
	 * Applies an incremental `GraphDelta` — the file-watcher's orchestrated
	 * update path, as opposed to `postGraph`'s full snapshot. Always merges
	 * into `lastPayload` (via `applyGraphDelta`) so a webview that
	 * reconnects later still gets a fully up-to-date snapshot from
	 * `flushPayload`, but only posts the lightweight delta itself to an
	 * already-ready webview — never a full re-send.
	 */
	postDelta(delta: GraphDelta): void {
		this.lastPayload = this.lastPayload ? applyGraphDelta(this.lastPayload, delta) : { nodes: delta.addedNodes, edges: delta.addedEdges };
		if (this.view && this.ready) {
			this.log(`posting graph delta to webview (+${delta.addedNodes.length}/-${delta.removedNodeIds.length} nodes)`);
			this.view.webview.postMessage({ type: 'graph-delta', delta });
		}
	}

	private flushPayload(): void {
		if (this.view && this.ready && this.lastPayload) {
			this.log(`posting graph to webview (${this.lastPayload.nodes.length} nodes, ${this.lastPayload.edges.length} edges)`);
			this.view.webview.postMessage({ type: 'graph', payload: this.lastPayload });
		}
	}

	private getHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'webview', 'graph.js'));
		const nonce = getNonce();
		return graphWebviewHtml({
			scriptUri: scriptUri.toString(),
			cspSource: webview.cspSource,
			nonce,
		});
	}
}
