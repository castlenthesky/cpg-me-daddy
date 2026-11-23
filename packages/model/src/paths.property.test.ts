import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isWorkspacePath, toAbsolutePath, toWorkspacePath, type WorkspacePath } from './index';

// Segments: small alphabet so collisions and near-misses (prefix names) happen; includes '.', '-', ':'.
// Excludes '', '.', '..', '/', NUL by construction (no filtering needed beyond the dot names).
const seg = fc
  .array(fc.constantFrom('a', 'b', 'c', '.', '-', ':'), { minLength: 1, maxLength: 3 })
  .map((cs) => cs.join(''))
  .filter((s) => s !== '.' && s !== '..');
// '\\' is legal in '/' mode only.
const segPosix = fc
  .array(fc.constantFrom('a', 'b', 'c', '.', '-', ':', '\\'), { minLength: 1, maxLength: 3 })
  .map((cs) => cs.join(''))
  .filter((s) => s !== '.' && s !== '..');

const rootSegs = fc.array(seg, { maxLength: 3 });
const pathSegs = fc.array(seg, { minLength: 1, maxLength: 5 });
const pathSegsPosix = fc.array(segPosix, { minLength: 1, maxLength: 5 });

const posixRoot = (s: string[]): string => '/' + s.join('/'); // '/' when empty
const winRoot = (s: string[]): string => 'C:\\' + s.join('\\'); // 'C:\' when empty
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only brand forge.
const asWp = (s: string): WorkspacePath => s as WorkspacePath;
// Independent oracle for joining: plain concatenation, handling the bare-root case by hand.
const posixAbs = (r: string[], p: string[]): string => '/' + [...r, ...p].join('/');
const winAbs = (r: string[], p: string[]): string => 'C:\\' + [...r, ...p].join('\\');

describe('paths properties', () => {
  it('P-1/P-2: toWorkspacePath(root, toAbsolutePath(root, p)) === p, and the result is well formed ("/" mode)', () => {
    fc.assert(
      fc.property(rootSegs, pathSegsPosix, fc.boolean(), (r, p, trailing) => {
        const root = posixRoot(r) + (trailing && r.length > 0 ? '/' : '');
        const wp = p.join('/');
        const abs = toAbsolutePath(root, asWp(wp));
        expect(abs).toBe(posixAbs(r, p));
        const back = toWorkspacePath(root, abs);
        expect(back).toBe(wp);
        expect(isWorkspacePath(back)).toBe(true);
      }),
    );
  });

  it('P-2: round trip in "\\\\" mode for paths without backslash', () => {
    fc.assert(
      fc.property(rootSegs, pathSegs, (r, p) => {
        const root = winRoot(r);
        const wp = p.join('/');
        const back = toWorkspacePath(root, toAbsolutePath(root, asWp(wp), '\\'), '\\');
        expect(back).toBe(wp);
        expect(isWorkspacePath(back)).toBe(true);
      }),
    );
  });

  it('P-3: toAbsolutePath(root, toWorkspacePath(root, abs)) === abs ("/" and "\\\\")', () => {
    fc.assert(
      fc.property(rootSegs, pathSegsPosix, (r, p) => {
        const abs = posixAbs(r, p);
        expect(toAbsolutePath(posixRoot(r), toWorkspacePath(posixRoot(r), abs))).toBe(abs);
      }),
    );
    fc.assert(
      fc.property(rootSegs, pathSegs, (r, p) => {
        const abs = winAbs(r, p);
        expect(toAbsolutePath(winRoot(r), toWorkspacePath(winRoot(r), abs, '\\'), '\\')).toBe(abs);
      }),
    );
  });

  it('P-4: root + suffix (no separator) is outside the root; root + sep + s is inside', () => {
    fc.assert(
      fc.property(fc.array(seg, { minLength: 1, maxLength: 3 }), seg, seg, (r, s, t) => {
        const root = posixRoot(r);
        expect(() => toWorkspacePath(root, root + t)).toThrow(/^path escapes root/);
        expect(toWorkspacePath(root, root + '/' + s)).toBe(s);
        const wroot = winRoot(r);
        expect(() => toWorkspacePath(wroot, wroot + t, '\\')).toThrow(/^path escapes root/);
        expect(toWorkspacePath(wroot, wroot + '\\' + s, '\\')).toBe(s);
      }),
    );
  });

  it('P-5: a ".." segment inserted at any position throws path escapes root', () => {
    fc.assert(
      fc.property(rootSegs, pathSegsPosix, fc.nat(), (r, p, k) => {
        const at = k % (p.length + 1);
        const withDots = [...p.slice(0, at), '..', ...p.slice(at)];
        expect(() => toWorkspacePath(posixRoot(r), posixAbs(r, withDots))).toThrow(
          /^path escapes root/,
        );
      }),
    );
  });

  it('P-6: a path that embeds the root later (not at the start) is rejected, never rewritten', () => {
    fc.assert(
      fc.property(fc.array(seg, { minLength: 1, maxLength: 3 }), seg, pathSegsPosix, (r, x, p) => {
        // The embedded root is preceded by a sentinel segment, so the path is not under the root.
        const abs = '/zz-' + x + posixRoot(r) + '/' + p.join('/');
        expect(() => toWorkspacePath(posixRoot(r), abs)).toThrow(/^path escapes root/);
      }),
    );
  });

  it('P-8: root maps to "." and back, with or without trailing separators', () => {
    fc.assert(
      fc.property(rootSegs, (r) => {
        const root = posixRoot(r);
        expect(toWorkspacePath(root, root)).toBe('.');
        expect(toWorkspacePath(root + '/', root)).toBe('.');
        expect(toWorkspacePath(root, root + '/')).toBe('.');
        expect(toAbsolutePath(root + '/', asWp('.'))).toBe(r.length === 0 ? '/' : root);
      }),
    );
  });

  it('P-8: root maps to "." and back in "\\" mode, including the bare drive root', () => {
    fc.assert(
      fc.property(rootSegs, (r) => {
        const root = winRoot(r); // 'C:\\' when r is empty: the trailing separator must survive
        expect(toWorkspacePath(root, root, '\\')).toBe('.');
        expect(toWorkspacePath(root + '\\', root, '\\')).toBe('.');
        expect(toAbsolutePath(root, asWp('.'), '\\')).toBe(root);
        expect(toAbsolutePath(root + '\\', asWp('.'), '\\')).toBe(root);
        expect(toAbsolutePath(root, asWp('a'), '\\')).toBe(winAbs(r, ['a']));
      }),
    );
  });

  it('P-9: outputs never contain NUL, and NUL anywhere in the input is rejected', () => {
    fc.assert(
      fc.property(rootSegs, pathSegsPosix, fc.nat(), (r, p, k) => {
        const abs = posixAbs(r, p);
        expect(toWorkspacePath(posixRoot(r), abs)).not.toContain('\u0000');
        const i = k % abs.length;
        const poisoned = abs.slice(0, i) + '\u0000' + abs.slice(i);
        expect(() => toWorkspacePath(posixRoot(r), poisoned)).toThrow(/^path contains NUL/);
      }),
    );
  });

  it('isWorkspacePath agrees with its segment definition', () => {
    fc.assert(
      fc.property(pathSegsPosix, (p) => {
        expect(isWorkspacePath(p.join('/'))).toBe(true);
        expect(isWorkspacePath('/' + p.join('/'))).toBe(false);
        expect(isWorkspacePath(p.join('/') + '/')).toBe(false);
        expect(isWorkspacePath(p.join('//'))).toBe(p.length === 1);
      }),
    );
  });
});
