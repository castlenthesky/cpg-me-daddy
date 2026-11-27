// Controller decision 88: the extract-owned types and the ExtractedFileSet brand live in @cpg/extract
// alone, so there is one brand to seal and one to resolve. Each directive below is unused, and so an
// error, while @cpg/resolve still declares the name; once it is gone the name reads as `any`.
import { describe, expectTypeOf, it } from 'vitest';
// oxlint-disable import/no-duplicates -- one import per moved name, each under its own directive
// @ts-expect-error moved to @cpg/extract
import type { FileOwnedLabel } from './index';
// @ts-expect-error moved to @cpg/extract
import type { PropertyValue } from './index';
// @ts-expect-error moved to @cpg/extract
import type { EndpointRef } from './index';
// @ts-expect-error moved to @cpg/extract
import type { EdgeElement } from './index';
// @ts-expect-error superseded by @cpg/extract's ExtractedFile
import type { ExtractedFileRefs } from './index';
// @ts-expect-error moved to @cpg/extract with its SEALED brand
import type { ExtractedFileSet } from './index';

describe('@cpg/resolve declares no extract-owned type (decision 88)', () => {
  it('each moved name is gone', () => {
    expectTypeOf<FileOwnedLabel>().toBeAny();
    expectTypeOf<PropertyValue>().toBeAny();
    expectTypeOf<EndpointRef>().toBeAny();
    expectTypeOf<EdgeElement>().toBeAny();
    expectTypeOf<ExtractedFileRefs>().toBeAny();
    expectTypeOf<ExtractedFileSet>().toBeAny();
  });
});
