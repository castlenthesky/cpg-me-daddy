// REAL (U3.1.1 part 3, BMO-52): @cpg/inspector's front door (controller decision 30). Exports
// graphShellHtml and its ids, parseWebviewMessage, verificationText and the registry's node colours.
// Nothing here may load the server, ws, cosmos.gl or the renderer (index.test.ts).

export { verificationText } from './banner';
export { parseWebviewMessage } from './messages';
export { REGISTRY_NODE_COLORS, type NodeColors } from './node-types';
export {
  GRAPH_CONTAINER_ID,
  graphShellHtml,
  VERIFICATION_ID,
  type GraphShellOptions,
} from './shell';
