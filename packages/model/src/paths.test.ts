import { describe, expect, it } from 'vitest';
import {
  isWorkspacePath,
  toAbsolutePath,
  toWorkspacePath,
  WORKSPACE_ROOT,
  type WorkspacePath,
} from './index';

// Expected values are hand-written from the U1.2.2 spec (DQ-02, L-10), never from running the code.
// Test-only brand cast: forging a WorkspacePath is exactly what some cases below need.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only brand forge.
const forge = (s: string): WorkspacePath => s as WorkspacePath;

describe('WORKSPACE_ROOT', () => {
  it('is the literal "." and is itself a valid WorkspacePath', () => {
    expect(WORKSPACE_ROOT).toBe('.');
    expect(isWorkspacePath(WORKSPACE_ROOT)).toBe(true);
  });
});

describe('isWorkspacePath', () => {
  it.each([
    '.',
    'a',
    'a/b.ts',
    '.github/x.yml',
    'C:x',
    'C:/a',
    'a\\b.ts',
    '...',
    '.hidden',
    'a/...',
  ])('accepts %j', (v) => {
    expect(isWorkspacePath(v)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['leading slash', '/a'],
    ['leading ./', './a'],
    ['trailing slash', 'a/'],
    ['empty segment', 'a//b'],
    ['dot segment', 'a/./b'],
    ['dotdot segment', 'a/../b'],
    ['bare dotdot', '..'],
    ['NUL', 'a\u0000b'],
    ['trailing dotdot', 'a/..'],
    ['trailing dot', 'a/.'],
    ['leading dotdot segment', '../a'],
    ['bare dot-slash', './'],
    ['deep trailing dotdot', 'a/b/..'],
    ['bare dot-dot-slash', '../'],
  ])('rejects %s', (_name, v) => {
    expect(isWorkspacePath(v)).toBe(false);
  });
});

describe('toWorkspacePath ("/" mode, the default)', () => {
  it('strips the root prefix', () => {
    expect(toWorkspacePath('/ws', '/ws/src/a.ts')).toBe('src/a.ts');
  });

  it('maps the root itself to "."', () => {
    expect(toWorkspacePath('/ws', '/ws')).toBe('.');
  });

  it('works for the filesystem root "/"', () => {
    expect(toWorkspacePath('/', '/a/b')).toBe('a/b');
    expect(toWorkspacePath('/', '/')).toBe('.');
  });

  it('ignores trailing separators on root and on absolute', () => {
    expect(toWorkspacePath('/ws/', '/ws/src/')).toBe('src');
    expect(toWorkspacePath('/ws/', '/ws/')).toBe('.');
  });

  it('treats backslash and colon as ordinary filename characters', () => {
    expect(toWorkspacePath('/ws', '/ws/a\\b.ts')).toBe('a\\b.ts');
    expect(toWorkspacePath('/ws', '/ws/C:x')).toBe('C:x');
  });

  it('accepts "..." and ".hidden" as ordinary segments', () => {
    expect(toWorkspacePath('/ws', '/ws/.../.hidden')).toBe('.../.hidden');
  });

  it('is case sensitive (D7)', () => {
    expect(() => toWorkspacePath('/ws', '/WS/a')).toThrow(/^path escapes root/);
  });

  it('rejects a sibling that merely shares a name prefix (segment boundary, P-4)', () => {
    expect(() => toWorkspacePath('/ws/app', '/ws/application')).toThrow(/^path escapes root/);
  });

  it('rejects the parent of the root', () => {
    expect(() => toWorkspacePath('/ws/app', '/ws')).toThrow(/^path escapes root/);
  });

  it('rejects a path that contains the root somewhere other than the start (P-6)', () => {
    expect(() => toWorkspacePath('/ws', '/other/ws/a')).toThrow(/^path escapes root/);
  });

  it('rejects a relative absolute argument as escaping the root', () => {
    expect(() => toWorkspacePath('/ws', 'src/a.ts')).toThrow(/^path escapes root/);
  });

  it.each(['/ws/../etc', '/ws/a/../../x', '/ws/a/..', '/ws/a/../b'])(
    'rejects ".." segment in %j as escaping',
    (abs) => {
      expect(() => toWorkspacePath('/ws', abs)).toThrow(/^path escapes root/);
    },
  );

  it.each(['/ws//a', '/ws/./a', '/ws/a//b', '/ws/a/./b'])(
    'rejects empty or "." segment in %j as not normalized',
    (abs) => {
      expect(() => toWorkspacePath('/ws', abs)).toThrow(/^path is not normalized/);
    },
  );

  it('rejects a relative root', () => {
    expect(() => toWorkspacePath('ws', '/ws/a')).toThrow(/^root is not absolute/);
  });

  it('rejects NUL in the absolute path', () => {
    expect(() => toWorkspacePath('/ws', '/ws/a\u0000b')).toThrow(/^path contains NUL/);
  });

  it('checks root first, then NUL, then ".." before normalization', () => {
    // relative root wins over NUL
    expect(() => toWorkspacePath('ws', '/ws/a\u0000')).toThrow(/^root is not absolute/);
    // NUL wins over ".."
    expect(() => toWorkspacePath('/ws', '/ws/../\u0000')).toThrow(/^path contains NUL/);
    // ".." wins over an empty segment
    expect(() => toWorkspacePath('/ws', '/ws//..')).toThrow(/^path escapes root/);
  });

  it('treats backslash as an ordinary character, so it is not a boundary in "/" mode', () => {
    expect(() => toWorkspacePath('/ws', '/ws\\a')).toThrow(/^path escapes root/);
  });

  it('puts both paths in the escape message', () => {
    expect(() => toWorkspacePath('/ws', '/etc/passwd')).toThrow(
      'path escapes root: "/etc/passwd" is not under "/ws"',
    );
  });
});

describe('toWorkspacePath ("\\\\" mode)', () => {
  it('converts a Windows path', () => {
    expect(toWorkspacePath('C:\\ws', 'C:\\ws\\src\\a.ts', '\\')).toBe('src/a.ts');
  });

  it('accepts mixed separators', () => {
    expect(toWorkspacePath('C:\\ws', 'C:\\ws/src\\a.ts', '\\')).toBe('src/a.ts');
  });

  it('handles drive-root "C:\\"', () => {
    expect(toWorkspacePath('C:\\', 'C:\\a\\b', '\\')).toBe('a/b');
    expect(toWorkspacePath('C:\\', 'C:\\', '\\')).toBe('.');
  });

  it.each(['C:\\ws', 'C:/ws', '\\\\srv\\share'])('accepts absolute root %j', (root) => {
    expect(toWorkspacePath(root, root, '\\')).toBe('.');
  });

  it('converts under a UNC root', () => {
    expect(toWorkspacePath('\\\\srv\\share', '\\\\srv\\share\\d\\f.ts', '\\')).toBe('d/f.ts');
  });

  it.each(['\\ws', '/ws', 'C:', 'ws', 'C:ws', '1:\\ws'])('rejects non-absolute root %j', (root) => {
    expect(() => toWorkspacePath(root, 'C:\\ws\\a', '\\')).toThrow(/^root is not absolute/);
  });

  it('accepts a UNC root written with forward slashes', () => {
    expect(toWorkspacePath('//srv/share', '//srv/share/d/f.ts', '\\')).toBe('d/f.ts');
  });

  it('ignores trailing separators', () => {
    expect(toWorkspacePath('C:\\ws\\', 'C:\\ws\\src\\', '\\')).toBe('src');
    expect(toWorkspacePath('C:\\ws', 'C:\\ws\\', '\\')).toBe('.');
  });

  it('is case sensitive, including the drive letter (D7, flagged for U3)', () => {
    expect(() => toWorkspacePath('C:\\ws', 'c:\\ws\\a', '\\')).toThrow(/^path escapes root/);
  });

  it.each(['C:\\ws\\\\a', 'C:\\ws\\.\\a', 'C:\\ws/./a', 'C:\\ws//a', 'C:\\ws\\a/\\b'])(
    'rejects empty or "." segment in %j as not normalized',
    (abs) => {
      expect(() => toWorkspacePath('C:\\ws', abs, '\\')).toThrow(/^path is not normalized/);
    },
  );

  it('rejects NUL in "\\" mode', () => {
    expect(() => toWorkspacePath('C:\\ws', 'C:\\ws\\a\u0000', '\\')).toThrow(/^path contains NUL/);
  });

  it('rejects ".." before checking for empty segments in "\\" mode', () => {
    expect(() => toWorkspacePath('C:\\ws', 'C:\\ws\\\\..', '\\')).toThrow(/^path escapes root/);
  });

  it('enforces the segment boundary', () => {
    expect(() => toWorkspacePath('C:\\ws\\app', 'C:\\ws\\application', '\\')).toThrow(
      /^path escapes root/,
    );
  });

  it('rejects ".." with either separator', () => {
    expect(() => toWorkspacePath('C:\\ws', 'C:\\ws\\a\\..\\..\\x', '\\')).toThrow(
      /^path escapes root/,
    );
    expect(() => toWorkspacePath('C:\\ws', 'C:\\ws/../x', '\\')).toThrow(/^path escapes root/);
  });
});

describe('toAbsolutePath', () => {
  it('joins root and path with "/" by default', () => {
    expect(toAbsolutePath('/ws', forge('src/a.ts'))).toBe('/ws/src/a.ts');
  });

  it('returns the root itself for "."', () => {
    expect(toAbsolutePath('/ws', WORKSPACE_ROOT)).toBe('/ws');
    expect(toAbsolutePath('/ws/', WORKSPACE_ROOT)).toBe('/ws');
  });

  it('strips trailing separators from the root before joining', () => {
    expect(toAbsolutePath('/ws/', forge('a'))).toBe('/ws/a');
  });

  it('works for the filesystem root', () => {
    expect(toAbsolutePath('/', forge('a/b'))).toBe('/a/b');
  });

  it('turns "/" into "\\" in "\\\\" mode', () => {
    expect(toAbsolutePath('C:\\ws', forge('src/a.ts'), '\\')).toBe('C:\\ws\\src\\a.ts');
  });

  it('keeps a drive-letter-looking segment in "/" mode', () => {
    expect(toAbsolutePath('/ws', forge('C:x'))).toBe('/ws/C:x');
  });

  it('rejects a path containing "\\" in "\\\\" mode', () => {
    expect(() => toAbsolutePath('C:\\ws', forge('a\\b.ts'), '\\')).toThrow(/^not a workspace path/);
  });

  it('keeps "\\" in a filename in "/" mode', () => {
    expect(toAbsolutePath('/ws', forge('a\\b.ts'))).toBe('/ws/a\\b.ts');
  });

  it.each(['../x', '/x', 'a/', 'a//b', './a', '', 'a/../b', 'a/..', 'a/.', 'a/./b', '..'])(
    'rejects forged %j',
    (bad) => {
      expect(() => toAbsolutePath('/ws', forge(bad))).toThrow(/^not a workspace path/);
    },
  );

  it('joins under a drive root without doubling or dropping the separator', () => {
    expect(toAbsolutePath('C:\\', forge('a'), '\\')).toBe('C:\\a');
    expect(toAbsolutePath('C:\\', WORKSPACE_ROOT, '\\')).toBe('C:\\');
    expect(toAbsolutePath('C:\\ws\\', WORKSPACE_ROOT, '\\')).toBe('C:\\ws');
  });

  it('works under a UNC root', () => {
    expect(toAbsolutePath('\\\\srv\\share', forge('d/f.ts'), '\\')).toBe('\\\\srv\\share\\d\\f.ts');
    expect(toAbsolutePath('\\\\srv\\share', WORKSPACE_ROOT, '\\')).toBe('\\\\srv\\share');
    expect(toAbsolutePath('//srv/share', forge('d'), '\\')).toBe('//srv/share\\d');
  });

  it.each(['\\ws', '/ws', 'C:', 'ws', 'C:ws', '1:\\ws'])(
    'rejects non-absolute root %j in "\\\\" mode',
    (root) => {
      expect(() => toAbsolutePath(root, forge('a'), '\\')).toThrow(/^root is not absolute/);
    },
  );

  it('rejects a relative root in "/" mode', () => {
    expect(() => toAbsolutePath('ws', forge('a'))).toThrow(/^root is not absolute/);
  });
});
