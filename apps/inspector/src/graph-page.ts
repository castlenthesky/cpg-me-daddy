// REAL wiring (U2b.1 parts 2b and 3a, BMO-35): the page bundle's entry (tools/build-inspector.mjs).
// It needs the DOM and the ESM-only cosmos.gl at runtime, so tsc -b skips it and tsconfig.page.json
// typechecks it; like apps/cli/src/main.ts, vitest cannot run it.

import { Graph } from '@cosmos.gl/graph';
import { startGraphApp } from './graph-app';
import { queuedChannel, SOCKET_PATH } from './page-channel';
import { GRAPH_CONTAINER_ID, VERIFICATION_ID } from './shell';
import { graphConfig } from './surface-config';

const container = document.getElementById(GRAPH_CONTAINER_ID);
const banner = document.getElementById(VERIFICATION_ID);
if (!(container instanceof HTMLDivElement) || !(banner instanceof HTMLDivElement)) {
  throw new Error(
    `@cpg/inspector: the page has no <div id="${GRAPH_CONTAINER_ID}"> or <div id="${VERIFICATION_ID}">`,
  );
}

// Controller decision 14: the canvas and the hover highlight take the shell's system colours, which
// follow the user's light or dark mode.
const bodyStyle = getComputedStyle(document.body);
const colours = { background: bodyStyle.backgroundColor, hover: bodyStyle.color };

// Owner decision 8a: the browser's own WebSocket, to the one origin the CSP allows (decision 10a).
const socket = new WebSocket(`ws://${location.host}${SOCKET_PATH}`);
const channel = queuedChannel((text) => socket.send(text));
socket.addEventListener('open', () => channel.open());
socket.addEventListener('message', (event) => channel.receive(event.data));

startGraphApp(
  {
    document,
    container,
    banner,
    makeSurface: (events) => new Graph(container, graphConfig(events, colours)),
  },
  channel,
);
