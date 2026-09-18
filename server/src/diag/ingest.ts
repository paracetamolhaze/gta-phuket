import { createServer, type Server, type Socket } from 'node:net';
import { logger } from '../logger.js';
import { MAX_LINE_BYTES, parseAccessLogLine } from './accessLog.js';
import { insertRequestLog } from './store.js';
import type { RequestLogEntry } from './schema.js';

/**
 * The request log's receiving end: a plain TCP listener for newline-delimited
 * access-log JSON, written by the ingress Caddy (`output net api:5140`) and by
 * the Vite dev server.
 *
 * It sits on the private Docker network only — compose never publishes the
 * port — and it must never take the API down with it: a port that is already
 * taken is logged and skipped, bad lines are ignored, a peer that streams
 * without newlines is cut off before it can eat memory, and kept rows are
 * rate-capped so a flood of forged requests cannot turn into a flood of INSERTs.
 */

/** A connection holding more than this without a newline is not a log writer. */
export const MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Kept rows per second, sustained, and the burst on top. A page load is about
 * twenty rows (the page, the boot files, the bundle), so this takes a raid's
 * worth of viewers arriving together. The pages are public and their headers
 * are the client's to choose, so without a cap one loop of forged requests
 * would be an INSERT each and push every real row out of the table.
 */
const KEEP_PER_SECOND = 20;
const KEEP_BURST = 200;
/** At most one "dropping" warning per this long. */
const DROP_WARN_MS = 60_000;

export interface RequestLogIngest {
  /** The port actually bound (useful when 0 was asked for). */
  readonly port: number;
  close(): Promise<void>;
}

export interface RequestLogIngestOptions {
  port: number;
  host?: string;
  /** Where kept entries go. Defaults to ext_request_log. */
  sink?: (entry: RequestLogEntry) => Promise<void> | void;
  /** Rate cap for kept rows; the defaults above unless a test needs another. */
  keepPerSecond?: number;
  keepBurst?: number;
}

type Sink = NonNullable<RequestLogIngestOptions['sink']>;

/** Token bucket over kept rows; the excess is dropped and counted. */
function createGate(perSecond: number, burst: number): () => boolean {
  let tokens = burst;
  let refilledAt = Date.now();
  let dropped = 0;
  let warnedAt = 0;
  return () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - refilledAt) / 1000) * perSecond);
    refilledAt = now;
    if (tokens >= 1) {
      tokens -= 1;
      return true;
    }
    dropped += 1;
    if (now - warnedAt >= DROP_WARN_MS) {
      logger.warn({ dropped }, 'extension request log over its rate, dropping rows');
      warnedAt = now;
      dropped = 0;
    }
    return false;
  };
}

function handleLine(buf: Buffer, sink: Sink, admit: () => boolean): void {
  if (buf.length === 0 || buf.length > MAX_LINE_BYTES) return;
  const entry = parseAccessLogLine(buf.toString('utf8').trim());
  if (!entry || !admit()) return;

  logger.info(
    {
      path: entry.path,
      status: entry.status,
      referer: entry.referer,
      secFetchDest: entry.secFetchDest,
      userAgent: entry.userAgent,
      source: entry.source,
    },
    'twitch extension request',
  );
  Promise.resolve()
    .then(() => sink(entry))
    .catch((err) => logger.warn({ err: (err as Error).message }, 'request log insert failed'));
}

function handleConnection(socket: Socket, sink: Sink, admit: () => boolean): void {
  // Split on raw bytes: 0x0A never occurs inside a UTF-8 multi-byte sequence,
  // and byte counts are what the limits are about.
  let pending: Buffer[] = [];
  let pendingBytes = 0;

  socket.on('data', (chunk: Buffer) => {
    let start = 0;
    let nl = chunk.indexOf(0x0a);
    while (nl !== -1) {
      const piece = chunk.subarray(start, nl);
      const line = pendingBytes ? Buffer.concat([...pending, piece]) : piece;
      pending = [];
      pendingBytes = 0;
      handleLine(line, sink, admit);
      start = nl + 1;
      nl = chunk.indexOf(0x0a, start);
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      pending.push(rest);
      pendingBytes += rest.length;
      if (pendingBytes > MAX_BUFFER_BYTES) {
        logger.warn({ bytes: pendingBytes }, 'request log peer sent no newline, closing it');
        pending = [];
        pendingBytes = 0;
        socket.destroy();
      }
    }
  });

  // A writer that closes without a final newline still meant its last line.
  socket.on('end', () => {
    if (pendingBytes) handleLine(Buffer.concat(pending), sink, admit);
    pending = [];
    pendingBytes = 0;
  });

  socket.on('error', (err) => logger.debug({ err: err.message }, 'request log connection error'));
}

/**
 * Start listening. Resolves to null — and logs why — when the port cannot be
 * bound, so the API carries on without the request log instead of crashing.
 */
export function startRequestLogIngest(options: RequestLogIngestOptions): Promise<RequestLogIngest | null> {
  const host = options.host ?? '0.0.0.0';
  const sink = options.sink ?? insertRequestLog;
  // One bucket for the listener, not per connection: a forger opens as many
  // connections to the ingress as it likes, but Caddy writes them all down one.
  const admit = createGate(options.keepPerSecond ?? KEEP_PER_SECOND, options.keepBurst ?? KEEP_BURST);
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    handleConnection(socket, sink, admit);
  });
  // Caddy and the dev server hold one connection each; this is headroom, not a quota.
  server.maxConnections = 64;

  return new Promise((resolve) => {
    const onListenError = (err: Error): void => {
      logger.error(
        { err: err.message, port: options.port },
        'extension request log: cannot listen, continuing without it',
      );
      resolve(null);
    };
    server.once('error', onListenError);

    server.listen(options.port, host, () => {
      server.off('error', onListenError);
      server.on('error', (err) => logger.warn({ err: err.message }, 'extension request log error'));

      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      logger.info({ port }, 'extension request log listening');

      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            // Log writers keep their connection open for good; close() alone
            // would wait for them forever.
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
