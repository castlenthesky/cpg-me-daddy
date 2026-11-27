// walkWorkspace on real tmp trees. A checked-in node_modules/ or dist/ fixture would be gitignored,
// so every tree is materialized at runtime. Expected values come from the BMO-79 acceptance list
// and the WalkStats contract in walker.ts.

import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WalkOptions, WalkResult } from './walker';
import { walkWorkspace } from './walker';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function tree(spec: Readonly<Record<string, string | Uint8Array>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cpg-walker-'));
  roots.push(root);
  for (const [path, contents] of Object.entries(spec)) {
    const abs = join(root, ...path.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, contents);
  }
  return root;
}

const LANG: Readonly<Record<string, string>> = { '.ts': 'typescript', '.py': 'python' };
const languageOf = (path: string): string | undefined => LANG[path.slice(path.lastIndexOf('.'))];

const walk = (root: string, o: Partial<WalkOptions> = {}): Promise<WalkResult> =>
  walkWorkspace({ root, languageOf, ...o });
const paths = (r: WalkResult): string[] => r.files.map((f) => f.path);
const sha256 = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');

describe('walkWorkspace', () => {
  it('prunes an excluded directory before descending into it', async () => {
    const root = await tree({
      'node_modules/pkg/index.js': '',
      'a/node_modules/x.js': '',
      'src/a.ts': '',
    });
    const r = await walk(root);
    expect(paths(r)).toEqual(['src/a.ts']);
    expect(r.directories.map((d) => d.path)).toEqual(['.', 'a', 'src']);
    // filesSeen counts nothing under node_modules: the walker never listed it.
    expect(r.stats).toMatchObject({ directoriesSkipped: 2, directoriesVisited: 3, filesSeen: 1 });
  });

  it('descends depth-first with entries sorted by UTF-16 code unit in each directory', async () => {
    const root = await tree({ 'b.py': '', 'a/z.ts': '', 'a.py': '', 'C.txt': '', 'a/b/y.ts': '' });
    const r = await walk(root);
    expect(paths(r)).toEqual(['C.txt', 'a/b/y.ts', 'a/z.ts', 'a.py', 'b.py']);
    expect(r.directories.map((d) => d.path)).toEqual(['.', 'a', 'a/b']);
  });

  it('skips file and directory symlinks without following them', async () => {
    const root = await tree({ 'real/a.ts': '' });
    await symlink(join(root, 'real'), join(root, 'linked-dir'));
    await symlink(join(root, 'real', 'a.ts'), join(root, 'linked.ts'));
    const r = await walk(root);
    expect(paths(r)).toEqual(['real/a.ts']);
    expect(r.stats.symlinksSkipped).toBe(2);
  });

  it('admits a file at the size cap and skips one byte over it', async () => {
    const root = await tree({ 'at.txt': '1234', 'over.txt': '12345' });
    const r = await walk(root, { maxFileSizeBytes: 4 });
    expect(paths(r)).toEqual(['at.txt']);
    expect(r.stats.filesTooLarge).toBe(1);
  });

  it('skips files over the 2 MB default cap', async () => {
    const root = await tree({ 'big.txt': 'x'.repeat(2 * 1024 * 1024 + 1), 'ok.txt': 'x' });
    expect(paths(await walk(root))).toEqual(['ok.txt']);
  });

  it('emits every non-ignored file, with language null when no grammar claims it', async () => {
    const root = await tree({ 'a.ts': '', 'b.py': '', 'README.md': '' });
    const r = await walk(root);
    expect(r.files.map((f) => [f.path, f.language])).toEqual([
      ['README.md', null],
      ['a.ts', 'typescript'],
      ['b.py', 'python'],
    ]);
    expect(r.stats.filesUnsupported).toBe(1);
  });

  it('mints revision_id as the sha256 of the raw bytes, so CRLF and LF differ', async () => {
    const root = await tree({ 'crlf.txt': 'a\r\nb\r\n', 'empty.txt': '', 'lf.txt': 'a\nb\n' });
    const r = await walk(root);
    expect(r.files.map((f) => [f.path, f.revision_id, f.sizeBytes])).toEqual([
      ['crlf.txt', sha256('a\r\nb\r\n'), 6],
      ['empty.txt', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 0],
      ['lf.txt', sha256('a\nb\n'), 4],
    ]);
  });

  it('hashes bytes that are not valid UTF-8 as bytes, not as a decoded string', async () => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0x00, 0xc3]);
    const r = await walk(await tree({ 'bin.dat': bytes }));
    // Decoding first would replace 0xff/0xfe/0xc3 with U+FFFD and hash different bytes.
    expect(r.files.map((f) => [f.revision_id, f.sizeBytes])).toEqual([[sha256(bytes), 4]]);
    expect(sha256(bytes)).not.toBe(sha256(Buffer.from(bytes).toString('utf8')));
  });

  // Root reads through any permission, so the unreadable file is only unreadable for a normal user.
  it.skipIf(process.getuid?.() === 0)(
    'counts an admitted but unreadable file as failed (I-20)',
    async () => {
      const root = await tree({ 'a.ts': '', 'locked.ts': 'x' });
      await chmod(join(root, 'locked.ts'), 0o000);
      const { files, stats } = await walk(root);
      await chmod(join(root, 'locked.ts'), 0o600);
      expect(files.map((f) => f.path)).toEqual(['a.ts']);
      expect(stats).toMatchObject({ filesSeen: 2, filesFailed: 1, filesExcluded: 0 });
    },
  );

  it('accounts for every file seen (I-20)', async () => {
    const root = await tree({
      'a.ts': '',
      'types.d.ts': '',
      'notes.md': '',
      'big.py': 'xxxxxxxx',
      'dist/out.js': '',
    });
    const { files, stats } = await walk(root, { maxFileSizeBytes: 4 });
    expect(paths({ files, directories: [], stats })).toEqual(['a.ts', 'notes.md']);
    expect(stats).toMatchObject({
      filesSeen: 4,
      filesExcluded: 1,
      filesTooLarge: 1,
      filesFailed: 0,
      filesUnsupported: 1,
      directoriesSkipped: 1,
    });
    expect(stats.filesSeen).toBe(
      files.length + stats.filesExcluded + stats.filesTooLarge + stats.filesFailed,
    );
  });

  it('honours include and exclude overrides in place of the defaults', async () => {
    const root = await tree({ 'a.ts': '', 'b.py': '', 'gen/c.ts': '', 'dist/d.ts': '' });
    const r = await walk(root, { include: ['**/*.ts'], exclude: ['/gen/'] });
    expect(paths(r)).toEqual(['a.ts', 'dist/d.ts']);
    expect(r.stats).toMatchObject({ filesExcluded: 1, directoriesSkipped: 1 });
  });

  it('gives every entry a WorkspacePath and its parent directory', async () => {
    const root = await tree({ 'top.ts': '', 'a/b/c.ts': '' });
    const r = await walk(root);
    expect(r.files.map((f) => [f.path, f.parent])).toEqual([
      ['a/b/c.ts', 'a/b'],
      ['top.ts', '.'],
    ]);
    expect(r.directories.map((d) => [d.path, d.parent])).toEqual([
      ['.', undefined],
      ['a', '.'],
      ['a/b', 'a'],
    ]);
  });
});

// U6a.3-2 (controller decision 100): the walker's one read is the engine's one read, so its bytes are
// handed on through `onFile` instead of being re-read. Written from WalkOptions.onFile's doc.
describe('walkWorkspace onFile: the byte hand-off', () => {
  const BIN = Uint8Array.from([0xef, 0xbb, 0xbf, 0xff, 0x0a]);

  it('hands every emitted file, with the bytes its revision_id hashes, once each and in walk order', async () => {
    const root = await tree({
      'b.py': 'b = 1\n',
      'a/z.ts': 'z',
      'C.dat': BIN,
      'big.py': '#'.repeat(11),
      'node_modules/x.js': 'x',
    });
    const seen: { readonly file: unknown; readonly bytes: Uint8Array }[] = [];
    const r = await walk(root, {
      maxFileSizeBytes: 10,
      onFile: async (file, bytes) => {
        seen.push({ file, bytes });
      },
    });
    expect(paths(r)).toEqual(['C.dat', 'a/z.ts', 'b.py']);
    expect(seen.map((s) => s.file)).toEqual(r.files);
    expect(seen.map((s) => [sha256(s.bytes), [...s.bytes]])).toEqual([
      [sha256(BIN), [...BIN]],
      [sha256('z'), [...Buffer.from('z')]],
      [sha256('b = 1\n'), [...Buffer.from('b = 1\n')]],
    ]);
  });

  it('awaits each call before the walk moves on to the next entry', async () => {
    const root = await tree({ 'a.py': 'a', 'b.py': 'b', 'c/d.py': 'd' });
    const log: string[] = [];
    await walk(root, {
      onFile: async (file) => {
        log.push(`start ${file.path}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        log.push(`end ${file.path}`);
      },
    });
    expect(log).toEqual([
      'start a.py',
      'end a.py',
      'start b.py',
      'end b.py',
      'start c/d.py',
      'end c/d.py',
    ]);
  });

  it('a rejection rejects the walk', async () => {
    const root = await tree({ 'a.py': 'a', 'b.py': 'b' });
    const calls: string[] = [];
    const walked = walk(root, {
      onFile: async (file) => {
        calls.push(file.path);
        if (file.path === 'a.py') throw new Error('hook failed on a.py');
      },
    });
    await expect(walked).rejects.toThrow('hook failed on a.py');
    expect(calls).toEqual(['a.py']);
  });

  // Root reads through any permission, so the unreadable file is only unreadable for a normal user.
  it.skipIf(process.getuid?.() === 0)('is not called for a file it could not read', async () => {
    const root = await tree({ 'a.py': 'a', 'locked.py': 'x' });
    await chmod(join(root, 'locked.py'), 0o000);
    const calls: string[] = [];
    const r = await walk(root, {
      onFile: async (file) => {
        calls.push(file.path);
      },
    });
    await chmod(join(root, 'locked.py'), 0o600);
    expect([calls, r.stats.filesFailed]).toEqual([['a.py'], 1]);
  });
});
