// @cpg/extract, the C-EXTRACT seam. REAL from U6a.2-2: createExtractor (python, MODULE tier) and
// sealExtractedFiles. SEAT inside the walker: Pass A declarations (U6a.2-3), Pass B calls, imports and
// ref sites (U6a.2-4); typescript and tsx fail grammar-unsupported until U6b.
export type * from './contract';
export { sealExtractedFiles } from './digest';
export { createExtractor } from './extractor';
