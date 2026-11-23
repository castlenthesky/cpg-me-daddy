// SEAT (U2b.1 part 2a, BMO-35): the camera-follow controller split out of
// 21754b4:packages/graph-visualizer/src/visualizer.ts (followCamera, onZoomStart, onSimulationEnd).

/** The most often the camera refits while the simulation settles, and the refit's duration. */
export const CAMERA_FOLLOW_THROTTLE_MS = 250;

function seat(what: string): never {
  throw new Error(`SEAT: ${what} is not built yet (U2b.1 part 2a)`);
}

/**
 * Follows the settling simulation with the camera until the user zooms or pans by hand. Starts
 * following, with the last refit at time 0.
 */
export class CameraFollow {
  constructor(private readonly now: () => number) {}

  /** Whether the camera still follows the simulation (no user zoom since the last reset). */
  get following(): boolean {
    return seat('CameraFollow.following');
  }

  /** A fresh render: follow again, last refit at time 0. */
  reset(): void {
    seat('CameraFollow.reset');
  }

  /** A simulation tick: true when the caller should refit now (following, and the throttle has passed). */
  tick(): boolean {
    return seat('CameraFollow.tick');
  }

  /** A zoom started; a user-driven one stops the following. */
  zoomStarted(_userDriven: boolean): void {
    seat('CameraFollow.zoomStarted');
  }
}
