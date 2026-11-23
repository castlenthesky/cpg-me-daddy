// SEAT (U2b.1 part 3a-i, BMO-35): the page's typed boundary for host messages. C-EXT may_not "type
// the webview boundary loosely": the parser returns a well-formed message or undefined, never a cast.
// Part 3a-ii adds the host's side (page messages, stdin lines) here.

import type { HostToWebview } from '@cpg/model';

/** The host messages the page acts on; `theme` is not among them yet (controller decision 14). */
export type PageMessage = Extract<
  HostToWebview,
  { type: 'graph' | 'graph-delta' | 'verification' }
>;

/**
 * A `graph`, `graph-delta` or `verification` message at protocol 1 whose every field has its
 * contract type (node and edge fields are not checked, stop-list 55), or undefined. Never throws.
 */
export function parsePageMessage(_value: unknown): PageMessage | undefined {
  throw new Error('SEAT: parsePageMessage is U2b.1 part 3a-i');
}
