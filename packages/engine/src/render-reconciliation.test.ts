// render-reconciliation from the renderer's render-report: 08-verification §3.1
// (`renderedNodeCount === payload.nodes.length`), C-EXT I-10 (a duplicate id fails), I-19
// (unavailable with no report, stale when it lags, never pass), controller decision 21 as corrected
// by decision 25 (`expected` is the payload's node count the caller sent, never the report's own),
// and owner decision 12a (duplicateEdges is visible, not silent). Expected values are written from
// those sources and the doc comment, not from running the code.

import type { RenderReport } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import type { RenderObservation } from './verify';
import { renderReconciliation } from './verify';

const URL = 'http://127.0.0.1:4100/';

const report = (o: Partial<RenderReport> = {}): RenderReport => ({
  payloadNodeCount: 3,
  renderedNodeCount: 3,
  renderedEdgeCount: 2,
  duplicateEdges: 0,
  droppedNodeIds: [],
  frameMs: 4,
  ...o,
});

/** `payloadNodeCount` is what the caller sent: 3 unless the case says otherwise (decision 25). */
const check = (payloadSeq: number, latest: RenderObservation | null, payloadNodeCount = 3) =>
  renderReconciliation({ payloadSeq, payloadNodeCount, latest, url: URL });

describe('renderReconciliation (controller decisions 21 and 25)', () => {
  it('no render-report yet: unavailable, 0 and 0, the detail names the URL to open (I-19)', () => {
    expect(check(5, null)).toEqual({
      id: 'render-reconciliation',
      state: 'unavailable',
      observed: 0,
      expected: 0,
      localisedTo: [],
      detail: `no render-report yet: open ${URL}`,
      asOfSeq: 5,
    });
  });

  it('the URL in the unavailable detail is the one given', () => {
    const other = renderReconciliation({
      payloadSeq: 0,
      payloadNodeCount: 3,
      latest: null,
      url: 'http://x/',
    });
    expect(other.detail).toBe('no render-report yet: open http://x/');
  });

  it('every payload node drawn at the payload seq: pass, rendered over payload, no detail', () => {
    expect(check(5, { seq: 5, report: report() })).toEqual({
      id: 'render-reconciliation',
      state: 'pass',
      observed: 3,
      expected: 3,
      localisedTo: [],
      asOfSeq: 5,
    });
  });

  it('the archive defect, 699 payload nodes drawn as 658: fail, the dropped ids sorted', () => {
    const r = report({
      payloadNodeCount: 699,
      renderedNodeCount: 658,
      droppedNodeIds: ['src/b.ts', 'src/a.ts'],
    });
    expect(check(9, { seq: 9, report: r }, 699)).toEqual({
      id: 'render-reconciliation',
      state: 'fail',
      observed: 658,
      expected: 699,
      localisedTo: ['src/a.ts', 'src/b.ts'],
      detail: '658 of 699 payload nodes drawn',
      asOfSeq: 9,
    });
  });

  it('a duplicate id (payload 3, drawn 2 distinct, the repeat listed): fail (C-EXT I-10)', () => {
    const r = report({ payloadNodeCount: 3, renderedNodeCount: 2, droppedNodeIds: ['dup'] });
    expect(check(1, { seq: 1, report: r })).toMatchObject({
      state: 'fail',
      observed: 2,
      expected: 3,
      localisedTo: ['dup'],
    });
  });

  it('equal counts with a dropped id still fail: pass needs both', () => {
    const r = report({ droppedNodeIds: ['x'] });
    expect(check(1, { seq: 1, report: r })).toMatchObject({
      state: 'fail',
      observed: 3,
      expected: 3,
      localisedTo: ['x'],
      detail: '3 of 3 payload nodes drawn',
    });
  });

  it('more drawn than the payload holds: fail', () => {
    const r = report({ payloadNodeCount: 3, renderedNodeCount: 4 });
    expect(check(1, { seq: 1, report: r })).toMatchObject({ state: 'fail', observed: 4 });
  });

  it('no node drawn of none: pass (an empty payload is reconciled)', () => {
    const r = report({ payloadNodeCount: 0, renderedNodeCount: 0 });
    expect(check(-1, { seq: -1, report: r }, 0)).toMatchObject({
      state: 'pass',
      observed: 0,
      expected: 0,
      asOfSeq: -1,
    });
  });

  it('dropped ids are distinct in localisedTo', () => {
    const r = report({ renderedNodeCount: 1, droppedNodeIds: ['c', 'a', 'c'] });
    expect(check(1, { seq: 1, report: r }).localisedTo).toEqual(['a', 'c']);
  });

  it('a render-report at an older seq: stale, never pass, even with full counts (I-19)', () => {
    expect(check(5, { seq: 4, report: report() })).toEqual({
      id: 'render-reconciliation',
      state: 'stale',
      observed: 3,
      expected: 3,
      localisedTo: [],
      detail: "render-report at seq 4 lags the payload's seq 5",
      asOfSeq: 5,
    });
  });

  it('a stale report with dropped ids is stale, not fail: its counts describe another payload', () => {
    const r = report({ renderedNodeCount: 1, droppedNodeIds: ['a'] });
    expect(check(5, { seq: 2, report: r })).toMatchObject({ state: 'stale', localisedTo: [] });
  });

  it('a report at a later seq than the payload is judged, not stale', () => {
    expect(check(5, { seq: 6, report: report() }).state).toBe('pass');
  });

  // Round two (review a9): a later seq is judged on its counts, and asOfSeq stays the payload's.
  it('a later-seq report with a dropped node fails; asOfSeq is still the payload seq', () => {
    const r = report({ renderedNodeCount: 2, droppedNodeIds: ['x'] });
    expect(check(5, { seq: 6, report: r })).toMatchObject({
      state: 'fail',
      observed: 2,
      expected: 3,
      localisedTo: ['x'],
      asOfSeq: 5,
    });
  });

  it.each([
    [1, '1 duplicate edge drawn once'],
    [2, '2 duplicate edges drawn once'],
  ])('%i duplicate edge(s) on a pass: named in detail, the state stays pass (12a)', (n, text) => {
    expect(check(3, { seq: 3, report: report({ duplicateEdges: n }) })).toMatchObject({
      state: 'pass',
      detail: text,
    });
  });

  it('duplicate edges on a fail join the counts in one detail', () => {
    const r = report({ payloadNodeCount: 699, renderedNodeCount: 658, duplicateEdges: 2 });
    expect(check(1, { seq: 1, report: r }, 699)).toMatchObject({
      state: 'fail',
      detail: '658 of 699 payload nodes drawn; 2 duplicate edges drawn once',
    });
  });

  // Decision 25 (stop-list 72): the verdict compares against the payload the caller sent. What the
  // page says it received decides nothing.
  it('a page that got a truncated payload and reports it honestly fails, not passes (decision 25)', () => {
    // sent 5 nodes; the page drew all 3 it received and says so
    const r = report({ payloadNodeCount: 3, renderedNodeCount: 3 });
    expect(check(1, { seq: 1, report: r }, 5)).toEqual({
      id: 'render-reconciliation',
      state: 'fail',
      observed: 3,
      expected: 5,
      localisedTo: [],
      detail: '3 of 5 payload nodes drawn',
      asOfSeq: 1,
    });
  });

  it('a page that reports more payload nodes than were sent passes when it drew what was sent', () => {
    const r = report({ payloadNodeCount: 99, renderedNodeCount: 3 });
    expect(check(1, { seq: 1, report: r }, 3)).toMatchObject({
      state: 'pass',
      observed: 3,
      expected: 3,
    });
    expect(check(1, { seq: 1, report: r }, 3).detail).toBeUndefined();
  });

  it('the stale and fail details and counts use the sent count too', () => {
    const r = report({ payloadNodeCount: 2, renderedNodeCount: 2 });
    expect(check(5, { seq: 4, report: r }, 7)).toMatchObject({ state: 'stale', expected: 7 });
    expect(check(5, { seq: 5, report: r }, 7)).toMatchObject({
      state: 'fail',
      detail: '2 of 7 payload nodes drawn',
    });
  });

  it('an empty page report against a non-empty payload fails: 0 drawn of what was sent', () => {
    const r = report({ payloadNodeCount: 0, renderedNodeCount: 0 });
    expect(check(1, { seq: 1, report: r }, 4)).toMatchObject({
      state: 'fail',
      observed: 0,
      expected: 4,
    });
  });

  it('with no report the sent count decides nothing: unavailable, 0 and 0 (no other semantics change)', () => {
    expect(check(5, null, 42)).toEqual({
      id: 'render-reconciliation',
      state: 'unavailable',
      observed: 0,
      expected: 0,
      localisedTo: [],
      detail: `no render-report yet: open ${URL}`,
      asOfSeq: 5,
    });
  });

  it('renderedEdgeCount and frameMs do not change the verdict', () => {
    const a = check(1, { seq: 1, report: report({ renderedEdgeCount: 0, frameMs: 900 }) });
    expect(a).toEqual(check(1, { seq: 1, report: report() }));
  });
});
