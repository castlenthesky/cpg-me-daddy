// REAL wiring (U2b.1 part 2b, BMO-35), with a SEAT channel: the page bundle's entry
// (tools/build-inspector.mjs). It needs the DOM and the ESM-only cosmos.gl at runtime, so tsc -b
// skips it and tsconfig.page.json typechecks it; like apps/cli/src/main.ts, vitest cannot run it.

import { Graph } from '@cosmos.gl/graph';
import { startGraphApp, type PageChannel } from './graph-app';
import { GRAPH_CONTAINER_ID } from './shell';
import { graphConfig } from './surface-config';

const container = document.getElementById(GRAPH_CONTAINER_ID);
if (!(container instanceof HTMLDivElement)) {
  throw new Error(`@cpg/inspector: the page has no <div id="${GRAPH_CONTAINER_ID}">`);
}

startGraphApp(
  { document, container, makeSurface: (events) => new Graph(container, graphConfig(events)) },
  connectChannel(),
);

/** SEAT (U2b.1 part 3): the browser's WebSocket to the connect source the shell allows (decisions 8a, 10a). */
function connectChannel(): PageChannel {
  throw new Error('SEAT: the page channel (a WebSocket to the inspector) is U2b.1 part 3');
}
