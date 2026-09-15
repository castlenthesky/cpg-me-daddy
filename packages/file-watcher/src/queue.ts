// Type-only, deep import — see the note at the top of index.ts for why this
// package always imports @cpg/graph-visualizer's contract.ts directly rather
// than its barrel.
import type { GraphDelta } from '@cpg/graph-visualizer/dist/contract';

/**
 * PASSTHROUGH — see the project plan ("ParseWorkspace / MonitorWorkspace —
 * the eventual structure"). Serializes graph updates between the
 * ParseWorkspace and MonitorWorkspace phases, so "parse THEN monitor" is
 * true by construction instead of true only because today's parse happens
 * to be synchronous.
 *
 * Today `enqueue` delivers immediately: nothing calls `pause()` yet, because
 * `parseWorkspace`'s body is still synchronous underneath, so no change can
 * possibly arrive mid-parse. `pause`/`resume` exist now so that wiring in a
 * genuinely async, yielding parse later is a body change at the call site
 * (`pause()` before starting it, `resume()` once it settles) rather than a
 * restructuring of this class.
 */
export class UpdateQueue {
	private paused = false;
	private readonly buffered: GraphDelta[] = [];

	constructor(private readonly onDelta?: (delta: GraphDelta) => void) {}

	enqueue(delta: GraphDelta): void {
		if (this.paused) {
			this.buffered.push(delta);
			return;
		}
		this.onDelta?.(delta);
	}

	pause(): void {
		this.paused = true;
	}

	/** Resumes delivery and flushes anything buffered while paused, in order. */
	resume(): void {
		this.paused = false;
		const pending = this.buffered.splice(0, this.buffered.length);
		for (const delta of pending) {
			this.onDelta?.(delta);
		}
	}
}
