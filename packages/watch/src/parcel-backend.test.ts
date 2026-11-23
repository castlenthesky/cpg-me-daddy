import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RawWatchEvent, WatchError, WatchSubscription } from './contract';
import type { ParcelModule } from './parcel-backend';
import { createParcelWatchBackend } from './parcel-backend';

type ParcelCallback = Parameters<ParcelModule['subscribe']>[1];

/** A scripted @parcel/watcher: the test fires its callback by hand. */
function fakeParcel(failWith?: Error) {
  const calls: { dir: string; options: unknown }[] = [];
  let fire: ParcelCallback | undefined;
  let unsubscribed = 0;
  const parcel: ParcelModule = {
    subscribe(dir, callback, options) {
      calls.push({ dir, options });
      fire = callback;
      if (failWith) return Promise.reject(failWith);
      return Promise.resolve({ unsubscribe: () => Promise.resolve(void unsubscribed++) });
    },
  };
  return {
    load: () => Promise.resolve(parcel),
    calls,
    fire: (...args: Parameters<ParcelCallback>) => fire?.(...args),
    unsubscribed: () => unsubscribed,
  };
}

describe('createParcelWatchBackend, against a scripted parcel', () => {
  it('declares what parcel does on this platform', () => {
    const linux = createParcelWatchBackend({ platform: 'linux' }).capabilities;
    expect(linux).toEqual({
      id: 'parcel',
      directoryEvents: 'all',
      moveEvents: 'none',
      reportsErrors: true,
      reportsOverflow: false,
      honoursIgnore: 'advisory',
      pathCase: 'sensitive',
    });
    expect(createParcelWatchBackend({ platform: 'darwin' }).capabilities.pathCase).toBe(
      'insensitive',
    );
    expect(createParcelWatchBackend({ platform: 'win32' }).capabilities.pathCase).toBe(
      'insensitive',
    );
  });

  it('loads parcel only on the first subscribe', async () => {
    let loads = 0;
    const fake = fakeParcel();
    const backend = createParcelWatchBackend({ load: () => (loads++, fake.load()) });
    expect(loads).toBe(0);
    await backend.subscribe('/w', () => undefined);
    expect(loads).toBe(1);
  });

  it('translates each event kind, keeps absolute paths, and stamps one T1 per callback', async () => {
    const fake = fakeParcel();
    const seen: (readonly RawWatchEvent[])[] = [];
    const backend = createParcelWatchBackend({ load: fake.load, now: () => 42 });
    await backend.subscribe('/w', (events) => seen.push(events), { ignore: ['**/node_modules'] });
    expect(fake.calls).toEqual([{ dir: '/w', options: { ignore: ['**/node_modules'] } }]);
    fake.fire(null, [
      { type: 'create', path: '/w/a.py' },
      { type: 'update', path: '/w/a.py' },
      { type: 'delete', path: '/w/pkg' },
    ]);
    fake.fire(null, []);
    expect(seen).toEqual([
      [
        { kind: 'created', path: '/w/a.py', entry: 'unknown', observedAt: 42 },
        { kind: 'changed', path: '/w/a.py', entry: 'unknown', observedAt: 42 },
        { kind: 'deleted', path: '/w/pkg', entry: 'unknown', observedAt: 42 },
      ],
    ]);
  });

  it('maps real paths back onto the root and drops anything not strictly under it (INV-4)', async () => {
    const fake = fakeParcel();
    const seen: string[] = [];
    const backend = createParcelWatchBackend({
      load: fake.load,
      realpath: (p) => Promise.resolve(`/private${p}`),
    });
    await backend.subscribe('/var/w', (events) => seen.push(...events.map((e) => e.path)));
    fake.fire(null, [
      { type: 'create', path: '/private/var/w' },
      { type: 'create', path: '/private/var/w/a.py' },
      { type: 'create', path: '/var/w/b.py' },
      { type: 'create', path: '/var/wx/c.py' },
      { type: 'create', path: '/elsewhere/d.py' },
    ]);
    fake.fire(null, [{ type: 'create', path: '/var/w' }]);
    expect(seen).toEqual(['/var/w/a.py', '/var/w/b.py']);
  });

  it('keeps the root as given when realpath fails', async () => {
    const fake = fakeParcel();
    const seen: string[] = [];
    const backend = createParcelWatchBackend({
      load: fake.load,
      realpath: () => Promise.reject(new Error('ENOENT')),
    });
    await backend.subscribe('/w', (events) => seen.push(...events.map((e) => e.path)));
    fake.fire(null, [{ type: 'create', path: '/w/a.py' }]);
    expect(seen).toEqual(['/w/a.py']);
  });

  it('passes no ignore option when none is given', async () => {
    const fake = fakeParcel();
    await createParcelWatchBackend({ load: fake.load }).subscribe('/w', () => undefined);
    expect(fake.calls[0]?.options).toEqual({});
  });

  it('surfaces a callback error as a non-fatal error that requires a rescan (INV-10, INV-25)', async () => {
    const fake = fakeParcel();
    const errors: WatchError[] = [];
    const seen: unknown[] = [];
    await createParcelWatchBackend({ load: fake.load }).subscribe('/w', (e) => seen.push(e), {
      onError: (e) => errors.push(e),
    });
    const err = new Error('Events were dropped by the FSEvents client');
    fake.fire(err, []);
    expect(errors).toEqual([
      {
        code: 'backend-crashed',
        message: err.message,
        fatal: false,
        rescanRequired: true,
        cause: err,
      },
    ]);
    expect(seen).toEqual([]);
  });

  it('is silent after close, and close is idempotent', async () => {
    const fake = fakeParcel();
    const seen: unknown[] = [];
    const sub = await createParcelWatchBackend({ load: fake.load }).subscribe('/w', (e) =>
      seen.push(e),
    );
    await sub.close();
    await sub.close();
    fake.fire(null, [{ type: 'create', path: '/w/late.py' }]);
    fake.fire(new Error('late'), []);
    expect([seen, fake.unsubscribed()]).toEqual([[], 1]);
  });

  it.each([
    ['Bad file descriptor', 'root-missing'],
    ['Not a directory', 'root-missing'],
    ['inotify_add_watch failed', 'backend-crashed'],
  ])(
    'a subscribe that fails with "%s" reports %s as fatal, then rejects',
    async (message, code) => {
      const failure = new Error(message);
      const errors: WatchError[] = [];
      const backend = createParcelWatchBackend({ load: fakeParcel(failure).load });
      await expect(
        backend.subscribe('/w', () => undefined, { onError: (e) => errors.push(e) }),
      ).rejects.toBe(failure);
      expect(errors).toEqual([
        { code, message, fatal: true, rescanRequired: false, path: '/w', cause: failure },
      ]);
    },
  );

  it('reports a failure to load the native module the same way', async () => {
    const errors: WatchError[] = [];
    const backend = createParcelWatchBackend({
      load: () => Promise.reject(new Error('no binary')),
    });
    await expect(
      backend.subscribe('/w', () => undefined, { onError: (e) => errors.push(e) }),
    ).rejects.toThrow('no binary');
    expect(errors.map((e) => [e.code, e.fatal])).toEqual([['backend-crashed', true]]);
  });

  it('never throws synchronously from subscribe', () => {
    const backend = createParcelWatchBackend({ load: () => Promise.reject(new Error('x')) });
    let outcome: Promise<unknown> | undefined;
    expect(() => (outcome = backend.subscribe('/w', () => undefined))).not.toThrow();
    return expect(outcome).rejects.toThrow('x');
  });
});

/** Polls until `check` holds or 2 s pass; parcel batches for ~50 ms, so a fixed sleep would be a guess. */
const until = async (check: () => boolean): Promise<void> => {
  for (let waited = 0; !check() && waited < 2000; waited += 20)
    await new Promise((r) => setTimeout(r, 20));
};

describe('createParcelWatchBackend, against the real @parcel/watcher', () => {
  let root = '';
  let sub: WatchSubscription | undefined;
  afterEach(async () => {
    await sub?.close();
    sub = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function watch() {
    root = mkdtempSync(join(tmpdir(), 'cpg-parcel-'));
    const events: RawWatchEvent[] = [];
    sub = await createParcelWatchBackend({ realpath }).subscribe(root, (batch) =>
      events.push(...batch),
    );
    return events;
  }

  it('delivers a file creation with an absolute path under the root (INV-4, INV-5)', async () => {
    const events = await watch();
    writeFileSync(join(root, 'a.py'), 'x = 1\n');
    await until(() => events.length > 0);
    expect(events).toEqual([
      {
        kind: 'created',
        path: join(root, 'a.py'),
        entry: 'unknown',
        observedAt: expect.any(Number),
      },
    ]);
  });

  it('a directory create is observable, as directoryEvents "all" claims (INV-9)', async () => {
    const events = await watch();
    mkdirSync(join(root, 'pkg'));
    await until(() => events.length > 0);
    expect(events.map((e) => [e.kind, e.path])).toEqual([['created', join(root, 'pkg')]]);
  });

  it('delivers a change and a delete', async () => {
    const events = await watch();
    writeFileSync(join(root, 'a.py'), '');
    await until(() => events.length > 0);
    writeFileSync(join(root, 'a.py'), 'y = 2\n');
    await until(() => events.length > 1);
    rmSync(join(root, 'a.py'));
    await until(() => events.length > 2);
    expect(events.map((e) => e.kind)).toEqual(['created', 'changed', 'deleted']);
  });
});
