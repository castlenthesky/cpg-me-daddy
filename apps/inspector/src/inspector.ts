// REAL (U2b.1 part 3a-ii, BMO-35): the inspector process (owner decision 9a). NDJSON goes in on
// stdin, the picture is served on 127.0.0.1, and render-reports come out on stdout. main.ts runs it
// with the real streams.

import { createInterface } from 'node:readline';
import { InspectorHost } from './host';
import { parseInspectorInput } from './messages';
import { startInspectorServer } from './server';

/** Where text goes (process.stdout, process.stderr, or a test's buffer). */
export interface TextSink {
  write(text: string): unknown;
}

export interface InspectorOptions {
  /** NDJSON InspectorInput lines. Its end shuts the inspector down. */
  readonly stdin: NodeJS.ReadableStream;
  /** NDJSON: `{"type":"listening","url":"http://127.0.0.1:<port>/"}` first, then each render-report message. */
  readonly stdout: TextSink;
  /** Diagnostics, one `cpg-inspector: ` line each: bad stdin lines, host faults, server logs. */
  readonly stderr: TextSink;
  /** The page bundle the server serves. */
  readonly bundlePath: string;
}

/**
 * Starts the server and writes the listening line, then feeds each stdin line to the host. Lines
 * end at LF or CRLF, and a last line with no newline counts. A blank line is skipped. A line that is
 * not JSON (`stdin line <n>: not JSON`), or not an InspectorInput
 * (`stdin line <n>: not a graph, graph-delta or verification message`), goes to stderr with its
 * 1-based number, and reading goes on. Resolves once stdin has ended and the server has closed; a
 * stdin error closes the server and rejects with it.
 */
export async function runInspector(options: InspectorOptions): Promise<void> {
  const err = (line: string): void => {
    options.stderr.write(`cpg-inspector: ${line}\n`);
  };

  const host = new InspectorHost({
    onRenderReport: (message) => {
      options.stdout.write(`${JSON.stringify(message)}\n`);
    },
    onFault: err,
  });

  const server = await startInspectorServer({
    attach: (transport) => host.attach(transport),
    bundlePath: options.bundlePath,
    log: err,
  });

  options.stdout.write(`${JSON.stringify({ type: 'listening', url: server.url })}\n`);

  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({ input: options.stdin, crlfDelay: Infinity });
    let lineNumber = 0;
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      rl.close();
      void server.close().then(() => {
        if (error !== undefined) reject(error);
        else resolve();
      });
    };

    rl.on('line', (text) => {
      lineNumber += 1;
      if (text.trim() === '') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        err(`stdin line ${String(lineNumber)}: not JSON`);
        return;
      }
      const input = parseInspectorInput(parsed);
      if (input === undefined) {
        err(`stdin line ${String(lineNumber)}: not a graph, graph-delta or verification message`);
        return;
      }
      host.input(input);
    });

    rl.on('close', () => finish());
    rl.on('error', (error: Error) => finish(error));
  });
}
