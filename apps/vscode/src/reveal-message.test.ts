// What the editor says about a reveal (controller decision 37). Expected values: the doc comment.

import { toWorkspacePath } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { revealMessage } from './reveal-message';

const filePath = toWorkspacePath('/w', '/w/src/a.ts');

describe('revealMessage', () => {
  it.each(['nameRange', 'range', 'whole-file'] as const)('says nothing after %s', (target) => {
    expect(revealMessage({ ok: true, filePath, target })).toBeUndefined();
  });

  it('says why the source did not open', () => {
    const nodeId = 'file:a:b';
    const error = { name: 'EntryNotFound', message: 'no such file' };
    expect(revealMessage({ ok: false, reason: 'unknown-node', nodeId })).toBe(
      'CPG: the graph has no node file:a:b',
    );
    expect(revealMessage({ ok: false, reason: 'no-location', nodeId })).toBe(
      'CPG: file:a:b has no source location to open',
    );
    expect(revealMessage({ ok: false, reason: 'open-failed', nodeId, filePath, error })).toBe(
      'CPG: cannot open src/a.ts: no such file',
    );
  });
});
