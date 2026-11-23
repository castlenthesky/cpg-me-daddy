// REAL (U2b.1 part 2a, BMO-35): ported from 21754b4:packages/graph-visualizer/src/visualizer.ts (followCamera, onZoomStart, onSimulationEnd).

export const CAMERA_FOLLOW_THROTTLE_MS = 250;

/** Follows the settling simulation until a user-driven zoom stops it. */
export class CameraFollow {
  private isFollowing = true;
  private lastFitAt = 0;

  constructor(private readonly now: () => number) {}

  get following(): boolean {
    return this.isFollowing;
  }

  reset(): void {
    this.isFollowing = true;
    this.lastFitAt = 0;
  }

  tick(): boolean {
    if (!this.isFollowing) return false;
    const now = this.now();
    if (now - this.lastFitAt < CAMERA_FOLLOW_THROTTLE_MS) return false;
    this.lastFitAt = now;
    return true;
  }

  zoomStarted(userDriven: boolean): void {
    if (userDriven) {
      this.isFollowing = false;
    }
  }
}
