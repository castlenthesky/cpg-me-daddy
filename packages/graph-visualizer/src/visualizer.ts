import { Graph } from '@cosmos.gl/graph';
import type { GraphDelta, GraphNode, GraphPayload } from './contract';
import { buildLegend } from './legend';
import { childPointSize, linkWidthForSizes, layoutPayload, LINK_DISTANCE, ROOT_POINT_SIZE, SPACE_SIZE } from './layout';
import { GRAPH_VISUALIZER_STYLES } from './styles';
import { DEFAULT_LINK_COLOR_HEX, DEFAULT_NODE_COLOR, NODE_TYPE_COLORS } from './nodeTypes';

const CAMERA_FOLLOW_THROTTLE_MS = 250;
// Vertical clearance between the hovered point's edge and the tooltip, so it
// doesn't overlap the dot (or its hover ring) it's describing.
const TOOLTIP_GAP_PX = 6;
// Where a newly-added node with no locatable parent seeds from — the same
// point the seed layout in layout.ts centres its own radial placement on.
const SPACE_CENTER = SPACE_SIZE / 2;

/** Appends `extra` to `base` without disturbing existing indices. */
function concatFloat32(base: Float32Array, extra: number[]): Float32Array {
	if (extra.length === 0) {
		return base;
	}
	const result = new Float32Array(base.length + extra.length);
	result.set(base);
	result.set(extra, base.length);
	return result;
}

export interface GraphVisualizerOptions {
	/**
	 * Edge type that defines parent/child containment for the radial seed
	 * layout (see layout.ts). Defaults to `'CONTAINS'`.
	 */
	hierarchyEdgeType?: string;
}

/**
 * Renders a `GraphPayload` into `container` using cosmos.gl, and owns the
 * fit-view button and type legend overlaid on top of it. One instance per
 * mounted graph — construct a new one (after `dispose()`-ing the old one) to
 * remount elsewhere.
 */
export class GraphVisualizer {
	private readonly graph: Graph | undefined;
	private readonly legendEl: HTMLDivElement;
	private readonly tooltipEl: HTMLDivElement;
	private readonly hierarchyEdgeType: string;

	// Per-dataset legend state: which type each point index is (so a swatch
	// click knows which points to hide) and each point's last known real
	// position (so re-showing a type restores it there instead of at the
	// origin). hiddenTypes persists across `render()` calls on purpose — a
	// re-render (e.g. triggered by the file watcher) shouldn't silently
	// un-hide a type the user just hid.
	private types: string[] = [];
	private basePositions: Float32Array = new Float32Array(0);
	// Parallel to types/basePositions/ids — kept as instance state (rather
	// than a local in renderInternal, like before) so applyDelta can append
	// to them without recomputing the layout of everything else.
	private colors: Float32Array = new Float32Array(0);
	private links: Float32Array = new Float32Array(0);
	// Parallel to types/basePositions/ids/colors (sizes) and to links
	// (linkWidths) — see layout.ts's sizing/taper comments.
	private sizes: Float32Array = new Float32Array(0);
	private linkWidths: Float32Array = new Float32Array(0);
	private readonly hiddenTypes = new Set<string>();
	private cameraFollowing = true;
	private lastFitAt = 0;

	// Per-dataset hover state: node id per point index (parallel to types/
	// basePositions above), and the GraphNode each id resolves to — the
	// hover callbacks below only ever hand back a point index.
	private ids: string[] = [];
	private nodesById = new Map<string, GraphNode>();

	constructor(container: HTMLDivElement, options: GraphVisualizerOptions = {}) {
		this.hierarchyEdgeType = options.hierarchyEdgeType ?? 'CONTAINS';

		// The fit-view button and legend are positioned absolutely against
		// this element — it needs to be a positioning context. Only set it if
		// the caller hasn't already (e.g. via the shell's own #graph-container
		// CSS), so we don't clobber a deliberate choice.
		if (getComputedStyle(container).position === 'static') {
			container.style.position = 'relative';
		}

		const styleEl = document.createElement('style');
		styleEl.textContent = GRAPH_VISUALIZER_STYLES;
		container.appendChild(styleEl);

		const fitViewButton = document.createElement('button');
		fitViewButton.type = 'button';
		fitViewButton.id = 'fit-view-button';
		fitViewButton.title = 'Zoom to fit';
		fitViewButton.innerHTML =
			'<svg viewBox="0 0 24 24"><path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" /></svg>';
		fitViewButton.addEventListener('click', () => this.graph?.fitView());
		container.appendChild(fitViewButton);

		this.legendEl = document.createElement('div');
		this.legendEl.id = 'legend';
		container.appendChild(this.legendEl);

		this.tooltipEl = document.createElement('div');
		this.tooltipEl.id = 'node-tooltip';
		this.tooltipEl.hidden = true;
		container.appendChild(this.tooltipEl);

		// Constructed defensively: a WebGL/device init failure here must not
		// throw past the constructor — the caller (e.g. the webview) still
		// needs to know construction completed so it can announce readiness;
		// render() below reports the failure again if called anyway.
		try {
			this.graph = new Graph(container, {
				backgroundColor: '#1e1e1e',
				spaceSize: SPACE_SIZE,
				randomSeed: 'cpg-me-daddy',
				// We frame the camera ourselves once real data exists (see
				// renderInternal's fitViewByPointPositions) — fitViewOnInit
				// would instead frame the empty canvas at construction time.
				fitViewOnInit: false,
				pointDefaultSize: 8,
				linkDefaultColor: DEFAULT_LINK_COLOR_HEX,
				// Each link's RGB is interpolated from its two endpoint points'
				// own colours (set via setPointColors) instead of a flat per-link
				// colour — a directory-to-directory edge reads as solid directory
				// orange, a directory-to-file edge fades from orange to blue.
				// linkDefaultColor above still supplies the alpha channel (and
				// the RGB fallback for a point with no resolved colour).
				linkColorInterpolateFromEndpoints: true,
				simulationLinkDistance: LINK_DISTANCE,
				// The seed layout (see layout.ts) is already centred on
				// spaceSize/2 — cosmos.gl's gravity target — so gravity only
				// needs to gently compact the tree, not haul it in from a corner.
				simulationGravity: 0.15,
				// Higher than the 1.0 default so the physics visibly reshapes
				// the jittered seed (unconnected branches pushing apart into
				// organic clusters) instead of barely moving it.
				simulationRepulsion: 1.4,
				// Dense sibling clusters (many points with no link between
				// them, all pulled toward the same parent) settle by pushing
				// apart on contact instead of relying solely on many-body
				// repulsion to keep them separated.
				simulationCollision: 0.5,
				// Damps residual oscillation faster than the 0.85 default,
				// working with simulationDecay below to settle without
				// overshooting.
				simulationFriction: 0.8,
				// Alpha decays as e^(-6.9 * tick / simulationDecay), so this
				// settles in ~10s at 60fps — long enough to actually see the
				// layout reshape, well short of the 5000 default's ~83s.
				simulationDecay: 600,
				onSimulationTick: () => this.followCamera(),
				onSimulationEnd: () => {
					if (this.cameraFollowing) {
						this.graph?.fitView();
					}
				},
				// Once the user pans/zooms by hand, stop auto-refitting out
				// from under them — the fit-view button remains the explicit
				// way to reframe after that.
				onZoomStart: (_event, userDriven) => {
					if (userDriven) {
						this.cameraFollowing = false;
					}
				},
				renderHoveredPointRing: true,
				hoveredPointRingColor: '#ffffff',
				hoveredPointCursor: 'pointer',
				// pointPosition (space coordinates) is used instead of the
				// MouseEvent argument: this callback also fires from zooming,
				// panning, and the force simulation moving points — cases
				// where there's no mouse event to read a screen position
				// from — so the tooltip has to be re-anchored to the point
				// on every fire regardless of what triggered it.
				onPointMouseOver: (index, pointPosition) => this.showTooltip(index, pointPosition),
				onPointMouseOut: () => {
					this.tooltipEl.hidden = true;
				},
			});
		} catch (error) {
			console.error('@cpg/graph-visualizer: failed to construct Graph', error);
		}
	}

	/** Renders (or re-renders) `payload`, replacing whatever was shown before. */
	render(payload: GraphPayload): void {
		if (!this.graph) {
			console.error('@cpg/graph-visualizer: got a payload but Graph failed to initialize, see earlier error');
			return;
		}
		try {
			this.renderInternal(this.graph, payload);
		} catch (error) {
			console.error('@cpg/graph-visualizer: failed to render graph', error);
		}
	}

	/**
	 * Applies a `GraphDelta` (see `@cpg/file-watcher`'s `WorkspaceGraphIndex`)
	 * in place: existing points keep their index and current simulated
	 * position (no relayout of anything the delta didn't touch); added nodes
	 * are seeded near their parent's current position (falling back to the
	 * space centre) so they visibly grow out of where they belong instead of
	 * popping in from the seed layout's origin; removed nodes are marked
	 * absent the same way `applyVisibility` hides a legend type — a NaN
	 * position, which cosmos.gl fades out in place along with any link still
	 * touching it (see `maskHidden`).
	 */
	applyDelta(delta: GraphDelta): void {
		if (!this.graph) {
			console.error('@cpg/graph-visualizer: got a delta but Graph failed to initialize, see earlier error');
			return;
		}
		if (delta.addedNodes.length === 0 && delta.removedNodeIds.length === 0) {
			return;
		}
		try {
			this.applyDeltaInternal(this.graph, delta);
		} catch (error) {
			console.error('@cpg/graph-visualizer: failed to apply graph delta', error);
		}
	}

	/** Reframes the camera on the current graph. */
	fitView(): void {
		this.graph?.fitView();
	}

	/** Releases the underlying WebGL resources. The instance is unusable afterwards. */
	dispose(): void {
		this.graph?.destroy();
	}

	private renderInternal(graph: Graph, payload: GraphPayload): void {
		const { positions, colors, links, types, ids, sizes, linkWidths } = layoutPayload(payload, this.hierarchyEdgeType);
		console.log(`@cpg/graph-visualizer: rendering graph — ${positions.length / 2} points, ${links.length / 2} links`);

		this.types = types;
		this.basePositions = positions;
		this.colors = colors;
		this.links = links;
		this.ids = ids;
		this.sizes = sizes;
		this.linkWidths = linkWidths;
		this.nodesById = new Map(payload.nodes.map((node) => [node.id, node]));
		// A fresh payload (e.g. a file-watcher triggered re-render) may no
		// longer contain whatever the tooltip was last pointing at.
		this.tooltipEl.hidden = true;

		graph.setPointColors(colors);
		graph.setPointSizes(sizes);
		graph.setLinks(links);
		graph.setLinkWidths(linkWidths);
		graph.setPointPositions(positions);
		// The root (or, with multiple roots, the synthetic centre — see
		// layout.ts) is always index 0 and sits at the space centre by
		// construction — pinning it keeps the camera anchored on a fixed
		// point instead of chasing a moving centroid while the rest of the
		// layout relaxes.
		graph.setPinnedPoints([0]);
		graph.render();

		// Frame the exact seed layout with no animation, so the very first
		// painted frame is already correct — fitViewOnInit is disabled above
		// for this same reason: it would otherwise frame an empty canvas.
		graph.fitViewByPointPositions(Array.from(positions), 0);
		this.cameraFollowing = true;
		this.lastFitAt = 0;

		// cosmos.gl never runs its force simulation on its own —
		// setPointPositions and render() only push data to the GPU, they
		// don't flip the internal isSimulationRunning flag that gates every
		// tick's gravity/repulsion/link-spring/collision pass. Without this
		// explicit start(), the graph sits frozen at the seed layout forever
		// and onSimulationTick/End (which followCamera and the auto-refit
		// above depend on) never fire either.
		graph.start(1);

		buildLegend(this.legendEl, types, this.hiddenTypes, (type) => this.toggleNodeType(type));
		// Re-apply any legend selections the user already made — a fresh
		// payload (e.g. from the file watcher) shouldn't silently un-hide a
		// type.
		if (this.hiddenTypes.size > 0) {
			this.applyVisibility();
		}
	}

	private followCamera(): void {
		if (!this.cameraFollowing) {
			return;
		}
		const now = performance.now();
		if (now - this.lastFitAt < CAMERA_FOLLOW_THROTTLE_MS) {
			return;
		}
		this.lastFitAt = now;
		this.graph?.fitView(CAMERA_FOLLOW_THROTTLE_MS);
	}

	private toggleNodeType(type: string): void {
		if (this.hiddenTypes.has(type)) {
			this.hiddenTypes.delete(type);
		} else {
			this.hiddenTypes.add(type);
		}
		this.applyVisibility();
		buildLegend(this.legendEl, this.types, this.hiddenTypes, (t) => this.toggleNodeType(t));
	}

	private applyVisibility(): void {
		if (!this.graph || this.types.length === 0) {
			return;
		}

		// Snapshot where the simulation actually left every currently-visible
		// point before hiding anything, so re-showing a type restores it
		// there rather than at its original seed position. Absent points
		// read back as NaN, so this only ever overwrites entries for points
		// still on screen.
		const live = this.graph.getPointPositions();
		for (let i = 0; i < this.types.length; i++) {
			if (!this.hiddenTypes.has(this.types[i]) && Number.isFinite(live[i * 2])) {
				this.basePositions[i * 2] = live[i * 2];
				this.basePositions[i * 2 + 1] = live[i * 2 + 1];
			}
		}

		this.graph.setPointPositions(this.maskHidden(this.basePositions));
		this.graph.render();
		// setPointPositions auto-pauses the simulation for its transition and
		// leaves it paused — resume it, but gently (a full-energy reheat
		// would reintroduce the exact flinging this whole change removes).
		this.graph.unpause();
		this.graph.start(0.1);
	}

	/**
	 * A NaN position is cosmos.gl's "absent point": it fades out in place,
	 * keeps its index, and drops out of the force layout — and (per
	 * draw-line.vert's exitPresence calculation) any link touching it fades
	 * out in sync, so no per-link colour/width bookkeeping is needed here.
	 * Shared by `applyVisibility` (hiding a legend type) and `applyDelta`
	 * (a removed node should stay absent even once it's back in view).
	 */
	private maskHidden(positions: Float32Array): Float32Array {
		const next = new Float32Array(positions.length);
		for (let i = 0; i < this.types.length; i++) {
			const hidden = this.hiddenTypes.has(this.types[i]);
			next[i * 2] = hidden ? NaN : positions[i * 2];
			next[i * 2 + 1] = hidden ? NaN : positions[i * 2 + 1];
		}
		return next;
	}

	private applyDeltaInternal(graph: Graph, delta: GraphDelta): void {
		const indexById = new Map(this.ids.map((id, index) => [id, index]));

		for (const id of delta.removedNodeIds) {
			const index = indexById.get(id);
			if (index === undefined) {
				continue;
			}
			this.basePositions[index * 2] = NaN;
			this.basePositions[index * 2 + 1] = NaN;
			this.nodesById.delete(id);
		}

		// First (only) incoming CONTAINS edge per added node, same "first
		// parent wins" convention buildHierarchy uses in layout.ts.
		const parentOf = new Map<string, string>();
		for (const edge of delta.addedEdges) {
			if (!parentOf.has(edge.target)) {
				parentOf.set(edge.target, edge.source);
			}
		}

		const appendedPositions: number[] = [];
		const appendedColors: number[] = [];
		const appendedTypes: string[] = [];
		const appendedIds: string[] = [];
		const appendedSizes: number[] = [];

		for (const node of delta.addedNodes) {
			const parentId = parentOf.get(node.id);
			const [x, y] = this.seedPosition(parentId, indexById);
			const color = NODE_TYPE_COLORS.get(node.type) ?? DEFAULT_NODE_COLOR;
			// Sized off the parent's already-known size (see layout.ts's
			// childPointSize) — there's no layout pass here to hand this node a
			// depth. A parent that isn't locatable (not in this delta, or
			// removed) falls back to a size one level below the root, matching
			// seedPosition's own space-centre fallback for "don't know where
			// this really belongs".
			const parentIndex = parentId !== undefined ? indexById.get(parentId) : undefined;
			const size = parentIndex !== undefined ? childPointSize(this.sizes[parentIndex]) : childPointSize(ROOT_POINT_SIZE);

			const existingIndex = indexById.get(node.id);
			if (existingIndex !== undefined) {
				// Re-adds an id still occupying an index — typically one this
				// same delta (or an earlier one) just tombstoned above, e.g. an
				// editor's delete+recreate save. Restore it in place instead of
				// growing the arrays with a duplicate id.
				this.basePositions[existingIndex * 2] = x;
				this.basePositions[existingIndex * 2 + 1] = y;
				this.colors.set(color, existingIndex * 4);
				this.types[existingIndex] = node.type;
				this.sizes[existingIndex] = size;
				this.nodesById.set(node.id, node);
				continue;
			}

			indexById.set(node.id, this.ids.length + appendedIds.length);
			appendedPositions.push(x, y);
			appendedColors.push(...color);
			appendedTypes.push(node.type);
			appendedIds.push(node.id);
			appendedSizes.push(size);
			this.nodesById.set(node.id, node);
		}

		this.basePositions = concatFloat32(this.basePositions, appendedPositions);
		this.colors = concatFloat32(this.colors, appendedColors);
		this.types = this.types.concat(appendedTypes);
		this.ids = this.ids.concat(appendedIds);
		this.sizes = concatFloat32(this.sizes, appendedSizes);

		const appendedLinks: number[] = [];
		const appendedLinkWidths: number[] = [];
		for (const edge of delta.addedEdges) {
			const source = indexById.get(edge.source);
			const target = indexById.get(edge.target);
			if (source === undefined || target === undefined) {
				continue;
			}
			appendedLinks.push(source, target);
			appendedLinkWidths.push(linkWidthForSizes(this.sizes[source], this.sizes[target]));
		}
		this.links = concatFloat32(this.links, appendedLinks);
		this.linkWidths = concatFloat32(this.linkWidths, appendedLinkWidths);

		graph.setPointColors(this.colors);
		graph.setPointSizes(this.sizes);
		graph.setLinks(this.links);
		graph.setLinkWidths(this.linkWidths);
		graph.setPointPositions(this.hiddenTypes.size > 0 ? this.maskHidden(this.basePositions) : this.basePositions);
		// Index 0 (the root, or the synthetic multi-root anchor) never moves
		// across a delta — only appends happen — so the pin from the last
		// full render() is still valid; re-asserted here since
		// setPointPositions can drop it.
		graph.setPinnedPoints([0]);
		graph.render();
		// Same gentle reheat as applyVisibility — a full graph.start(1) reheat
		// would refling every already-settled existing point right along with
		// the handful the delta actually touched.
		graph.unpause();
		graph.start(0.1);

		// Added/removed nodes can change a type's count to or from zero.
		buildLegend(this.legendEl, this.types, this.hiddenTypes, (type) => this.toggleNodeType(type));
	}

	/** Seeds a newly-added node near its parent's current position, or the space centre if the parent isn't locatable. */
	private seedPosition(parentId: string | undefined, indexById: Map<string, number>): [number, number] {
		const parentIndex = parentId !== undefined ? indexById.get(parentId) : undefined;
		if (parentIndex !== undefined) {
			const px = this.basePositions[parentIndex * 2];
			const py = this.basePositions[parentIndex * 2 + 1];
			if (Number.isFinite(px) && Number.isFinite(py)) {
				return [px + (Math.random() - 0.5) * LINK_DISTANCE * 2, py + (Math.random() - 0.5) * LINK_DISTANCE * 2];
			}
		}
		return [SPACE_CENTER + (Math.random() - 0.5) * LINK_DISTANCE * 2, SPACE_CENTER + (Math.random() - 0.5) * LINK_DISTANCE * 2];
	}

	private showTooltip(index: number, pointPosition: [number, number]): void {
		const node = this.nodesById.get(this.ids[index] ?? '');
		// No GraphNode means this index is the synthetic multi-root anchor
		// (see layout.ts's VIRTUAL_ROOT_ID) rather than real graph data; a
		// hidden type or an absent (NaN) point both mean there's nothing
		// visible here to describe — in every case, show nothing.
		if (!this.graph || !node || this.hiddenTypes.has(node.type) || !Number.isFinite(pointPosition[0])) {
			this.tooltipEl.hidden = true;
			return;
		}
		this.tooltipEl.textContent = `${node.type}: ${node.name ?? node.id}`;
		const [screenX, screenY] = this.graph.spaceToScreenPosition(pointPosition);
		const radius = this.graph.spaceToScreenRadius(this.graph.getPointRadiusByIndex(index) ?? 0);
		this.tooltipEl.style.left = `${screenX}px`;
		this.tooltipEl.style.top = `${screenY - radius - TOOLTIP_GAP_PX}px`;
		this.tooltipEl.hidden = false;
	}
}
