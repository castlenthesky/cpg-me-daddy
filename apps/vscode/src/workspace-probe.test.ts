// The real FilesystemProbe (controller decision 29): listFiles is the set the walker admits, and a digest is
// the walker's revision_id. The oracle is the engine's own walkWorkspace on real trees; the file system is
// node's, typed as VS Code types it (a symbolic link is 64 plus its target's type).

import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_EXCLUDES, DEFAULT_INCLUDES, walkWorkspace } from '@cpg/engine';
import { isWorkspacePath, type WorkspacePath } from '@cpg/model';
import { afterEach, describe, expect, it } from 'vitest';
import { workspaceProbe, type AdmissionScope, type WorkspaceFileSystem } from './workspace-probe';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tree(spec: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cpg-probe-'));
  roots.push(root);
  for (const [path, contents] of Object.entries(spec)) {
    const at = join(root, ...path.split('/'));
    // oxlint-disable-next-line no-await-in-loop -- a few small files
    await mkdir(dirname(at), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop -- a few small files
    await writeFile(at, contents);
  }
  return root;
}

/** vscode.workspace.fs on `root`, with what it was asked. */
class DiskFileSystem implements WorkspaceFileSystem {
  readonly read: string[] = [];
  readonly asked: string[] = [];
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }
  async readDirectory(path: WorkspacePath): Promise<readonly (readonly [string, number])[]> {
    this.asked.push(path);
    const at = join(this.root, path);
    const entries = await readdir(at, { withFileTypes: true });
    return Promise.all(
      entries.map(async (entry) => {
        const target = entry.isSymbolicLink() ? await stat(join(at, entry.name)) : entry;
        const type = target.isFile() ? 1 : target.isDirectory() ? 2 : 0;
        return [entry.name, type + (entry.isSymbolicLink() ? 64 : 0)] as const;
      }),
    );
  }
  async size(path: WorkspacePath): Promise<number> {
    return (await lstat(join(this.root, path))).size;
  }
  async readFile(path: WorkspacePath): Promise<Uint8Array> {
    this.read.push(path);
    return readFile(join(this.root, path));
  }
}

const DEFAULT_SCOPE: AdmissionScope = {
  include: DEFAULT_INCLUDES,
  exclude: DEFAULT_EXCLUDES,
  maxFileSizeBytes: 2 * 1024 * 1024,
};
const path = (value: string): WorkspacePath => {
  if (!isWorkspacePath(value)) throw new Error(`not a workspace path: ${value}`);
  return value;
};
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** What the walker admits, in its order, with its revision ids. */
async function walked(root: string, scope: Partial<AdmissionScope>): Promise<[string, string][]> {
  const { files } = await walkWorkspace({ root, languageOf: () => undefined, ...scope });
  return files.map((file) => [file.path, file.revision_id]);
}

async function probed(
  root: string,
  scope: Partial<AdmissionScope>,
): Promise<[string, string | undefined][]> {
  const probe = workspaceProbe(new DiskFileSystem(root), { ...DEFAULT_SCOPE, ...scope });
  const paths = await probe.listFiles();
  return Promise.all(
    paths.map(async (at) => [at, await probe.digest(at)] as [string, string | undefined]),
  );
}

const TREE = {
  'README.md': '# hello',
  'src/a.ts': 'export const a = 1;\r\n',
  'src/b/c.py': 'x = 1\n',
  'src/b/d.min.js': '',
  'lib.ts': '',
  'lib/Z.ts': 'z',
  'lib/a.ts': 'a',
  'node_modules/p/index.js': '1',
  'src/node_modules/q.js': '1',
  'dist/out.js': '1',
  'tests/é.ts': 'é',
  'we ird/na#me?.ts': '%',
  'sub/node_modules_old/x.ts': '1',
};

describe('listFiles and digest equal the walker on the same tree', () => {
  const scopes: [string, Partial<AdmissionScope>][] = [
    ['the default scope', {}],
    ['an include that is not everything', { include: ['/src/**'] }],
    ['two includes', { include: ['/lib/*.ts', '**/*.py'] }],
    ["the file's own excludes, in place of the default ones", { exclude: ['/src/b/**', 'lib'] }],
    ['nothing excluded', { exclude: [] }],
    // Round two (review a8): a trailing `/` is for directories only, and `x/**` is not the file x.
    ['directory-only excludes', { exclude: ['README.md/', 'src/b/'] }],
    ['an include below a file', { include: ['lib.ts/**', '/src/**'] }],
    ['a size cap', { maxFileSizeBytes: 6 }],
    ['a size cap at the largest file', { maxFileSizeBytes: 21 }],
    ['an include that matches nothing', { include: ['/nowhere/*'] }],
  ];
  it.each(scopes)('%s', async (_what, scope) => {
    const root = await tree(TREE);
    const expected = await walked(root, { ...DEFAULT_SCOPE, ...scope });
    expect(await probed(root, scope)).toEqual(expected);
    expect(expected.length > 0).toBe(!(scope.include ?? []).includes('/nowhere/*'));
  });

  it('skips links to files and to directories, as the walker does', async () => {
    const root = await tree(TREE);
    await symlink(join(root, 'src'), join(root, 'linked'));
    await symlink(join(root, 'lib.ts'), join(root, 'linked.ts'));
    const listed = (await probed(root, {})).map(([at]) => at);
    expect(listed).not.toContain('linked.ts');
    expect(listed.some((at) => at.startsWith('linked/'))).toBe(false);
    expect(listed).toEqual((await walked(root, {})).map(([at]) => at));
  });

  it('reads no directory that is excluded, and no file', async () => {
    const root = await tree(TREE);
    const fs = new DiskFileSystem(root);
    await workspaceProbe(fs, DEFAULT_SCOPE).listFiles();
    expect(fs.asked.filter((at) => /node_modules|dist/.test(at))).toEqual(['sub/node_modules_old']);
    expect(fs.read).toEqual([]);
  });
});

const FILE = 1;
const DIRECTORY = 2;
const or = <T>(value: T | undefined): Promise<T> =>
  value === undefined ? Promise.reject(new Error('EACCES')) : Promise.resolve(value);
/** Directories by name, sizes by path; anything else rejects. */
function fake(
  directories: Readonly<Record<string, readonly (readonly [string, number])[]>>,
  sizes: Readonly<Record<string, number>>,
): WorkspaceFileSystem {
  return {
    readDirectory: (at) => or(directories[at]),
    size: (at) => or(sizes[at]),
    readFile: () => Promise.reject(new Error('EACCES')),
  };
}

describe('what cannot be read', () => {
  it('skips a directory below the root, a file with no size, other types, and a name that is no path', async () => {
    const probe = workspaceProbe(
      fake(
        {
          '.': [
            ['locked', DIRECTORY],
            ['gone.ts', FILE],
            ['a.ts', FILE],
            ['socket', 0],
            ['link.ts', 65],
            ['linked', 66],
            ['broken', 64],
            ['..', DIRECTORY],
            ['nul\u0000.ts', FILE],
            ['dir', DIRECTORY],
          ],
          dir: [
            ['b.ts', FILE],
            ['deep', DIRECTORY],
          ],
          linked: [['never.ts', FILE]],
          '..': [['outside.ts', FILE]],
        },
        {
          'a.ts': 1,
          'dir/b.ts': 1,
          'link.ts': 1,
          'linked/never.ts': 1,
          socket: 1,
          '../outside.ts': 1,
        },
      ),
      DEFAULT_SCOPE,
    );
    expect(await probe.listFiles()).toEqual(['a.ts', 'dir/b.ts']);
  });

  it('a root that cannot be read rejects: an empty listing would pass on an empty graph', async () => {
    await expect(workspaceProbe(fake({}, {}), DEFAULT_SCOPE).listFiles()).rejects.toThrow('EACCES');
  });

  it('a file at the cap is admitted, and one byte over is not', async () => {
    const listing = fake(
      {
        '.': [
          ['at', FILE],
          ['over', FILE],
        ],
      },
      { at: 4, over: 5 },
    );
    const probe = workspaceProbe(listing, { ...DEFAULT_SCOPE, maxFileSizeBytes: 4 });
    expect(await probe.listFiles()).toEqual(['at']);
  });

  it('a file that vanished, a directory and an unreadable file have no digest, and never reject', async () => {
    const root = await tree({ 'a.ts': 'a', 'dir/b.ts': 'b', 'locked.ts': 'c' });
    const probe = workspaceProbe(new DiskFileSystem(root), DEFAULT_SCOPE);
    expect(await probe.listFiles()).toEqual(['a.ts', 'dir/b.ts', 'locked.ts']);
    await rm(join(root, 'a.ts'));
    await chmod(join(root, 'locked.ts'), 0o000);
    expect(await probe.digest(path('a.ts'))).toBeUndefined();
    expect(await probe.digest(path('dir'))).toBeUndefined();
    expect(await probe.digest(path('dir/b.ts'))).toBe(sha256('b'));
    expect(await probe.digest(path('locked.ts'))).toBe(
      process.getuid?.() === 0 ? sha256('c') : undefined,
    );
  });

  it('the bytes are digested as they are, not as text', async () => {
    const root = await tree({});
    await writeFile(join(root, 'raw.bin'), new Uint8Array([0xff, 0xfe, 0x0d, 0x0a]));
    const probe = workspaceProbe(new DiskFileSystem(root), DEFAULT_SCOPE);
    expect(await probe.digest(path('raw.bin'))).toBe(
      createHash('sha256')
        .update(new Uint8Array([0xff, 0xfe, 0x0d, 0x0a]))
        .digest('hex'),
    );
  });
});
