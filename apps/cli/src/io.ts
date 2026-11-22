// Io: every byte the CLI reads from or writes to its process goes through here (C-CLI).
// stdout carries only the requested output; diagnostics, usage-on-error and progress go to stderr.

export interface Io {
  out(line: string): void;
  err(line: string): void;
  // In-place progress on stderr; a no-op unless isTty.err.
  status(line: string): void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: { readText(): Promise<string>; readonly isTty: boolean };
  readonly isTty: { readonly out: boolean; readonly err: boolean };
  readonly now: () => number;
}

// The package manifest, read once by main.ts: the version banner never comes from a literal (I-13).
export interface Manifest {
  readonly bin: string;
  readonly version: string;
}

export interface CapturedIo extends Io {
  readonly stdout: string[];
  readonly stderr: string[];
}

// In-process Io for tests: drives any command with no process, TTY or clock behind it.
export function captureIo(
  opts: { isTty?: boolean; stdin?: string; env?: Record<string, string> } = {},
): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const tty = opts.isTty ?? false;
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    status: (line) => {
      if (tty) stderr.push(line);
    },
    env: opts.env ?? {},
    stdin: { readText: () => Promise.resolve(opts.stdin ?? ''), isTty: tty },
    isTty: { out: tty, err: tty },
    now: () => 0,
  };
}
