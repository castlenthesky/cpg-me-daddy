import * as vscode from 'vscode';
// Deep imports, deliberately: the package's main entry (index.ts) pulls in
// @cosmos.gl/graph (browser/DOM code, ESM-only) via visualizer.ts, which the
// CommonJS extension host cannot load, and whose types the host's tsconfig
// (no "dom" in lib) can't resolve either. contract.ts and shell.ts have no
// dependencies of their own — importing them directly never pulls that in.
// See packages/graph-visualizer/AGENTS.md.
import {
	applyGraphDelta,
	nodeLocation,
	type GraphDelta,
	type GraphPayload,
	type SourceRange,
	type WebviewToHost,
} from '@cpg/graph-visualizer/dist/contract';
import { graphWebviewHtml } from '@cpg/graph-visualizer/dist/shell';

/**
 * A `SourceRange` is already in `vscode.Position`'s coordinate system —
 * zero-based rows, UTF-16 code-unit columns — so this is a straight
 * transcription with no conversion. See `SourceRange`'s own doc comment for
 * why that holds and what would break it.
 */
function toRange(range: SourceRange): vscode.Range {
	return new vscode.Range(new vscode.Position(range.startRow, range.startColumn), new vscode.Position(range.endRow, range.endColumn));
}

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
		webviewView.webview.onDidReceiveMessage((message: WebviewToHost) => {
			this.log(`graph webview message: ${JSON.stringify(message)}`);
			if (message?.type === 'ready') {
				this.ready = true;
				this.flushPayload();
			} else if (message?.type === 'reveal') {
				// Deliberately not awaited: nothing here depends on the editor
				// having opened, and a rejected open is already handled inside.
				void this.revealNode(message.nodeId);
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

	/**
	 * Opens the source behind a clicked graph node and puts the cursor on it.
	 *
	 * The node id is resolved against `lastPayload` rather than trusting a
	 * location sent up from the webview — that field is already kept merged
	 * and current for webview reconnects, so it's the authoritative answer to
	 * "where does this node point?" with no extra state to maintain. The scan
	 * is linear, which is the right trade for a human-paced, one-per-click
	 * lookup: an index would have to be rebuilt on every delta.
	 */
	private async revealNode(nodeId: string): Promise<void> {
		const node = this.lastPayload?.nodes.find((candidate) => candidate.id === nodeId);
		if (!node) {
			// Not an error — a click can race a delta that removed the node.
			this.log(`cannot reveal unknown node '${nodeId}'`);
			return;
		}

		// An AST node carries an explicit location; a `file` node doesn't need
		// one (its id is the path, and the whole file is the target); a
		// `directory` has nothing to open at all.
		const location = nodeLocation(node);
		const filePath = location?.filePath ?? (node.type === 'file' ? node.id : undefined);
		if (filePath === undefined) {
			return;
		}

		try {
			const editor = await vscode.window.showTextDocument(vscode.Uri.file(filePath), {
				// Reuses one preview tab across clicks, so exploring the graph
				// doesn't leave a trail of pinned editors behind.
				preview: true,
				// The name range when there is one — landing the caret on
				// `foo`, not on the `function` keyword that starts the
				// construct.
				...(location ? { selection: toRange(location.nameRange ?? location.range) } : {}),
			});
			// Then frame the construct's full extent, so a method opens with
			// its body on screen instead of scrolled to its signature.
			if (location) {
				editor.revealRange(toRange(location.range), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			}
		} catch (error) {
			// Routine rather than exceptional: the file may have been deleted
			// or renamed since the graph last saw it.
			this.log(`failed to reveal ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
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
