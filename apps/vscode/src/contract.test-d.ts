// C-EXT's host types, pinned against the contract's text (05-contracts.yaml, C-EXT types). The
// literals below are typed from it, not read back from the code.
import { describe, expectTypeOf, it } from 'vitest';
import type { Epoch, GraphPayload, Seq, SourceRange, WorkspacePath } from '@cpg/model';
import type {
  DeltaMeta,
  GraphHost,
  GraphSink,
  ProtocolFault,
  RevealOutcome,
  SerializedError,
  SnapshotMeta,
  SourceOpener,
} from './contract';
import type { PanelGraphHost } from './graph-host';

describe('C-EXT host types', () => {
  it("the sink's causes are C-EXT's, not C-SINK's (no 'resync')", () => {
    expectTypeOf<SnapshotMeta['cause']>().toEqualTypeOf<'initial' | 'catch-up'>();
    expectTypeOf<DeltaMeta['cause']>().toEqualTypeOf<'live' | 'cascade' | 'bulk'>();
  });

  it('the fault kinds and reveal reasons are exactly the contract’s', () => {
    expectTypeOf<ProtocolFault['kind']>().toEqualTypeOf<
      'unknown-message' | 'bad-epoch' | 'seq-gap' | 'post-failed'
    >();
    expectTypeOf<Extract<ProtocolFault, { kind: 'seq-gap' }>['expected']>().toEqualTypeOf<Seq>();
    expectTypeOf<
      Extract<ProtocolFault, { kind: 'bad-epoch' }>['received']
    >().toEqualTypeOf<Epoch>();
    expectTypeOf<Extract<RevealOutcome, { ok: false }>['reason']>().toEqualTypeOf<
      'unknown-node' | 'no-location' | 'open-failed'
    >();
    expectTypeOf<Extract<RevealOutcome, { ok: true }>['target']>().toEqualTypeOf<
      'nameRange' | 'range' | 'whole-file'
    >();
  });

  it('a failure crosses as plain data: a name and a message', () => {
    expectTypeOf<SerializedError>().toEqualTypeOf<{
      readonly name: string;
      readonly message: string;
    }>();
  });

  it('a SourceOpener is asked for a file, and may be given where to put the cursor and what to frame', () => {
    expectTypeOf<Parameters<SourceOpener['open']>>().toEqualTypeOf<
      [
        request: {
          readonly filePath: WorkspacePath;
          readonly selection?: SourceRange;
          readonly frame?: SourceRange;
        },
      ]
    >();
    expectTypeOf<ReturnType<SourceOpener['open']>>().toEqualTypeOf<Promise<void>>();
  });

  it('a GraphHost is a GraphSink with a payload always there, and the class is one', () => {
    expectTypeOf<GraphHost>().toExtend<GraphSink>();
    expectTypeOf<ReturnType<GraphHost['snapshot']>>().toEqualTypeOf<GraphPayload>();
    expectTypeOf<PanelGraphHost>().toExtend<GraphHost>();
  });
});
