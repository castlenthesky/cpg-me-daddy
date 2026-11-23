// The cosmos.gl config the page builds its Graph with: the archive's (21754b4 visualizer.ts:175-255),
// with the visualizer's SurfaceEvents as the callbacks. The physics values deviate from cosmos.gl's
// defaults on purpose and the archive recorded why (L-05); these pin that they survived the port.
// Part 3a (controller decision 14): the canvas and hover colours are the page's computed system
// colours, passed in, so the picture follows light or dark mode; no literal colour remains for them.

import { describe, expect, it } from 'vitest';
import { LINK_DISTANCE, SPACE_SIZE } from './layout';
import { DEFAULT_LINK_COLOR_HEX } from './node-types';
import { graphConfig, type PageColours } from './surface-config';
import type { SurfaceEvents } from './visualizer';

const LIGHT: PageColours = { background: 'rgb(255, 255, 255)', hover: 'rgb(0, 0, 0)' };
const DARK: PageColours = { background: 'rgb(30, 30, 30)', hover: 'rgb(204, 204, 204)' };

function events(): SurfaceEvents {
  return {
    onSimulationTick: () => {},
    onSimulationEnd: () => {},
    onZoomStart: () => {},
    onPointMouseOver: () => {},
    onPointMouseOut: () => {},
    onPointClick: () => {},
    onLinkMouseOver: () => {},
    onLinkMouseOut: () => {},
  };
}

describe('graphConfig', () => {
  it("hands cosmos.gl exactly the visualizer's callbacks", () => {
    const handlers = events();
    const config = graphConfig(handlers, LIGHT);
    const names = [
      'onSimulationTick',
      'onSimulationEnd',
      'onZoomStart',
      'onPointMouseOver',
      'onPointMouseOut',
      'onPointClick',
      'onLinkMouseOver',
      'onLinkMouseOut',
    ] as const;
    expect(Object.keys(handlers).toSorted()).toEqual([...names].toSorted());
    expect(names.filter((name) => config[name] !== handlers[name])).toEqual([]);
  });

  it('takes point clicks from onPointClick, never the canvas-wide onClick', () => {
    expect(graphConfig(events(), LIGHT).onClick).toBeUndefined();
  });

  it('frames the camera itself once data exists (no fit on init)', () => {
    expect(graphConfig(events(), LIGHT).fitViewOnInit).toBe(false);
  });

  it('shares the seed layout space and link distance', () => {
    const config = graphConfig(events(), LIGHT);
    expect(config.spaceSize).toBe(SPACE_SIZE);
    expect(config.simulationLinkDistance).toBe(LINK_DISTANCE);
  });

  it.each([
    ['randomSeed', 'cpg-me-daddy'],
    ['pointDefaultSize', 8],
    ['linkDefaultColor', DEFAULT_LINK_COLOR_HEX],
    ['linkColorInterpolateFromEndpoints', true],
    ['simulationGravity', 0.15],
    ['simulationRepulsion', 1.4],
    ['simulationCollision', 0.5],
    ['simulationFriction', 0.8],
    ['simulationDecay', 600],
    ['renderHoveredPointRing', true],
    ['hoveredPointCursor', 'pointer'],
    ['hoveredLinkCursor', 'pointer'],
    ['hoveredLinkWidthIncrease', 2],
  ] as const)('keeps the archive value %s = %j', (key, value) => {
    expect(graphConfig(events(), LIGHT)[key]).toBe(value);
  });

  it('builds a fresh config per call', () => {
    const handlers = events();
    expect(graphConfig(handlers, LIGHT)).not.toBe(graphConfig(handlers, LIGHT));
  });

  it.each([
    ['light', LIGHT],
    ['dark', DARK],
  ] as const)(
    'takes the canvas and hover colours from the page (%s; decision 14)',
    (_name, colours) => {
      const config = graphConfig(events(), colours);
      expect(config.backgroundColor).toBe(colours.background);
      expect(config.hoveredPointRingColor).toBe(colours.hover);
      expect(config.hoveredLinkColor).toBe(colours.hover);
    },
  );
});
