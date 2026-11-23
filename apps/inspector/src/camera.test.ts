// The camera-follow controller (BMO-35 line 2, "camera controller"). Semantics from the archive's
// followCamera / onZoomStart / onSimulationEnd (21754b4:packages/graph-visualizer/src/visualizer.ts):
// refit at most every 250 ms while following; a user-driven zoom stops following; a render resets
// following and the last-refit time to 0.

import { describe, expect, it } from 'vitest';
import { CameraFollow } from './camera';

function clocked(): { camera: CameraFollow; at: (ms: number) => void } {
  let now = 0;
  const camera = new CameraFollow(() => now);
  return {
    camera,
    at: (ms: number) => {
      now = ms;
    },
  };
}

describe('CameraFollow', () => {
  it('starts following, with the last refit at time 0', () => {
    const { camera, at } = clocked();
    expect(camera.following).toBe(true);
    at(0);
    expect(camera.tick()).toBe(false);
    at(249);
    expect(camera.tick()).toBe(false);
    at(250);
    expect(camera.tick()).toBe(true);
  });

  it('measures the throttle from the last refit, not from the last tick', () => {
    const { camera, at } = clocked();
    at(250);
    expect(camera.tick()).toBe(true);
    at(400);
    expect(camera.tick()).toBe(false);
    at(499);
    expect(camera.tick()).toBe(false);
    at(500);
    expect(camera.tick()).toBe(true);
  });

  it('keeps following through a programmatic zoom and stops on a user-driven one', () => {
    const { camera, at } = clocked();
    camera.zoomStarted(false);
    expect(camera.following).toBe(true);
    camera.zoomStarted(true);
    expect(camera.following).toBe(false);
    at(10_000);
    expect(camera.tick()).toBe(false);
    camera.zoomStarted(false);
    expect(camera.following).toBe(false);
  });

  it('reset follows again and forgets the last refit', () => {
    const { camera, at } = clocked();
    at(1000);
    expect(camera.tick()).toBe(true);
    camera.zoomStarted(true);
    at(1100);
    camera.reset();
    expect(camera.following).toBe(true);
    // 1100 - 0 >= 250: the refit at 1000 is forgotten (it would block until 1250 otherwise).
    expect(camera.tick()).toBe(true);
  });
});
