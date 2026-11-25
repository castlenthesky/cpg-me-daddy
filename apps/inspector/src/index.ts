// SEAT (U3.1.1 part 3, BMO-52): @cpg/inspector's front door (controller decision 30). It will export
// graphShellHtml and its ids, parseWebviewMessage, verificationText and the registry's node colours.
// Nothing here may load the server, ws, cosmos.gl or the renderer (index.test.ts).

export { parseWebviewMessage } from './messages';
export { GRAPH_CONTAINER_ID } from './shell';
