import { GraphVisualizer, type GraphDelta, type GraphPayload, type WebviewToHost } from '@cpg/graph-visualizer';

// Typed as WebviewToHost rather than `unknown` so this side of the channel
// can't post a message the host has no case for — the contract is checked
// here, at the one place messages leave the webview.
declare function acquireVsCodeApi(): { postMessage(message: WebviewToHost): void };
const vscodeApi = acquireVsCodeApi();

const container = document.getElementById('graph-container') as HTMLDivElement;

// Constructed defensively: a WebGL/device init failure inside GraphVisualizer
// must not stop this script short of sending 'ready' below, or the extension
// host has no way to know the webview loaded at all.
let visualizer: GraphVisualizer | undefined;
try {
	visualizer = new GraphVisualizer(container, {
		// Only the id travels — the host resolves it against the payload it
		// already holds. See WebviewToHost in the visualizer's contract.ts.
		onNodeClick: (node) => vscodeApi.postMessage({ type: 'reveal', nodeId: node.id }),
	});
} catch (error) {
	console.error('cpg-me-daddy: failed to construct GraphVisualizer', error);
}

window.addEventListener('message', (event: MessageEvent<{ type?: string; payload?: GraphPayload; delta?: GraphDelta }>) => {
	console.log('cpg-me-daddy: received message', event.data);
	if (event.data?.type !== 'graph' && event.data?.type !== 'graph-delta') {
		return;
	}
	if (!visualizer) {
		console.error('cpg-me-daddy: got a graph message but GraphVisualizer failed to initialize, see earlier error');
		return;
	}
	if (event.data.type === 'graph' && event.data.payload) {
		visualizer.render(event.data.payload);
	} else if (event.data.type === 'graph-delta' && event.data.delta) {
		visualizer.applyDelta(event.data.delta);
	}
});

// Tells the extension host it's now safe to postMessage — a message sent
// right after webview.html is set can otherwise arrive before this
// listener above exists.
console.log('cpg-me-daddy: webview script loaded, announcing ready');
vscodeApi.postMessage({ type: 'ready' });
