// REAL wiring (U2b.1 parts 2b and 3a, BMO-35; U3.1.1 part 3, BMO-52): the page bundle's entry
// (tools/build-inspector.mjs). It needs the DOM and the ESM-only cosmos.gl at runtime, so tsc -b
// skips it and tsconfig.page.json typechecks it; tools/graph-page.test.mjs runs its bundle in a vm.

import { Graph } from '@cosmos.gl/graph';
import { startGraphApp } from './graph-app';
import { pageChannel, SOCKET_PATH } from './page-channel';
import { GRAPH_CONTAINER_ID, VERIFICATION_ID } from './shell';
import { colourConfig, graphConfig, type PageColours } from './surface-config';

const container = document.getElementById(GRAPH_CONTAINER_ID);
const banner = document.getElementById(VERIFICATION_ID);
if (!(container instanceof HTMLDivElement) || !(banner instanceof HTMLDivElement)) {
  throw new Error(
    `@cpg/inspector: the page has no <div id="${GRAPH_CONTAINER_ID}"> or <div id="${VERIFICATION_ID}">`,
  );
}

// Controller decisions 14 and 32: the canvas and hover highlight take the shell's computed colours,
// which follow the user's light/dark mode and VS Code's theme variables.
const readColours = (): PageColours => {
  const bodyStyle = getComputedStyle(document.body);
  return { background: bodyStyle.backgroundColor, hover: bodyStyle.color };
};

// Controller decision 31: VS Code's webview API inside a panel, or the browser's WebSocket (owner
// decision 8a) to the one origin the CSP allows (decision 10a).
const channel = pageChannel(window, () => new WebSocket(`ws://${location.host}${SOCKET_PATH}`));

let graph: Graph | undefined;
startGraphApp(
  {
    document,
    container,
    banner,
    makeSurface: (events) => {
      graph = new Graph(container, graphConfig(events, readColours()));
      return graph;
    },
    recolour: () => {
      graph?.setConfigPartial(colourConfig(readColours()));
    },
  },
  channel,
);
