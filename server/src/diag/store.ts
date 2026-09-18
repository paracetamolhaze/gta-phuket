import { query } from '../db/pool.js';
import { SURFACE_PAGES } from './accessLog.js';
import { foldState, presentEvent, summarizeSession } from './session.js';
import { computeVerdict } from './verdict.js';
import type {
  CleanBatch,
  DiagEventRow,
  DiagSurface,
  ExtDiagnosticsResponse,
  LastIframeRequest,
  RequestLogEntry,
  RequestLogRow,
  RequestSource,
  SessionState,
} from './schema.js';

/**
 * Postgres side of the extension diagnostics. Everything written here has
 * already been through ./sanitize.ts or ./accessLog.ts.
 */

/** Retention: a week is plenty to compare "yesterday it worked" with today. */
export const DIAG_RETENTION_DAYS = 7;
/** Hard cap per table, because POST /api/diag/ext is open to anyone. */
export const DIAG_MAX_ROWS = 5000;
/** A page load sends at most 400 events; anything past this is not a real session. */
const SESSION_ROWS = 1000;

interface DiagEventDbRow {
  id: number;
  received_at: Date;
  client_ts: Date | null;
  session: string;
  surface: string;
  event: string;
  channel_id: string | null;
  viewer_kind: string;
  state: SessionState | null;
  data: Record<string, unknown> | null;
}

interface RequestLogDbRow {
  id: number;
  ts: Date;
  source: string;
  method: string;
  path: string;
  status: number | null;
  referer: string | null;
  sec_fetch_dest: string | null;
  sec_fetch_site: string | null;
  user_agent: string | null;
}

const EVENT_COLUMNS =
  'id, received_at, client_ts, session, surface, event, channel_id, viewer_kind, state, data';

function toEventRow(r: DiagEventDbRow): DiagEventRow {
  return {
    id: r.id,
    receivedAt: r.received_at,
    clientTs: r.client_ts,
    session: r.session,
    surface: r.surface,
    event: r.event,
    channelId: r.channel_id,
    viewerKind: r.viewer_kind,
    state: r.state ?? {},
    data: r.data ?? {},
  };
}

function toRequestRow(r: RequestLogDbRow): RequestLogRow {
  return {
    id: r.id,
    ts: r.ts,
    source: (r.source === 'devserver' ? 'devserver' : 'ingress') as RequestSource,
    method: r.method,
    path: r.path,
    status: r.status,
    referer: r.referer,
    secFetchDest: r.sec_fetch_dest,
    secFetchSite: r.sec_fetch_site,
    userAgent: r.user_agent,
  };
}

/**
 * Store one batch. Each row carries the session's state after its event —
 * the previous row's state with this event folded in — so the admin table can
 * show viewport, visibility and helper on every line without a replay.
 */
export async function insertDiagBatch(batch: CleanBatch): Promise<number> {
  const { rows } = await query<{ state: SessionState | null }>(
    'SELECT state FROM ext_diag_events WHERE session = $1 ORDER BY id DESC LIMIT 1',
    [batch.session],
  );
  let state: SessionState = rows[0]?.state ?? {};

  const values: string[] = [];
  const params: unknown[] = [];
  for (const ev of batch.events) {
    state = foldState(state, { event: ev.event, snap: ev.snap, data: ev.data });
    const n = params.length;
    params.push(
      ev.clientTs,
      batch.session,
      batch.surface,
      ev.seq,
      ev.event,
      state.channelId ?? null,
      state.viewerKind ?? 'unknown',
      JSON.stringify(state),
      JSON.stringify(ev.data),
    );
    values.push(
      `($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7}, $${n + 8}::jsonb, $${n + 9}::jsonb)`,
    );
  }

  await query(
    `INSERT INTO ext_diag_events
       (client_ts, session, surface, seq, event, channel_id, viewer_kind, state, data)
     VALUES ${values.join(', ')}`,
    params,
  );
  return batch.events.length;
}

export async function insertRequestLog(entry: RequestLogEntry): Promise<void> {
  await query(
    `INSERT INTO ext_request_log
       (ts, source, method, path, status, referer, sec_fetch_dest, sec_fetch_site, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.ts,
      entry.source,
      entry.method,
      entry.path,
      entry.status,
      entry.referer,
      entry.secFetchDest,
      entry.secFetchSite,
      entry.userAgent,
    ],
  );
}

export async function listDiagEvents(limit: number): Promise<DiagEventRow[]> {
  const { rows } = await query<DiagEventDbRow>(
    `SELECT ${EVENT_COLUMNS} FROM ext_diag_events ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  return rows.map(toEventRow);
}

export async function listRequestLog(limit: number): Promise<RequestLogRow[]> {
  const { rows } = await query<RequestLogDbRow>(
    'SELECT * FROM ext_request_log ORDER BY id DESC LIMIT $1',
    [limit],
  );
  return rows.map(toRequestRow);
}

/** The events of the newest page load on `surface`, oldest first. */
export async function loadLastSessionRows(surface: DiagSurface): Promise<DiagEventRow[]> {
  const { rows } = await query<{ session: string }>(
    'SELECT session FROM ext_diag_events WHERE surface = $1 ORDER BY id DESC LIMIT 1',
    [surface],
  );
  const session = rows[0]?.session;
  if (!session) return [];

  const events = await query<DiagEventDbRow>(
    `SELECT ${EVENT_COLUMNS} FROM ext_diag_events WHERE session = $1 ORDER BY id DESC LIMIT $2`,
    [session, SESSION_ROWS],
  );
  return events.rows.map(toEventRow).reverse();
}

/** Newest request Twitch made for one of `pages` as an iframe. */
export async function findLastIframeRequest(pages: readonly string[]): Promise<LastIframeRequest | null> {
  const { rows } = await query<Pick<RequestLogDbRow, 'ts' | 'path' | 'status' | 'referer'>>(
    `SELECT ts, path, status, referer FROM ext_request_log
      WHERE sec_fetch_dest = 'iframe' AND split_part(path, '?', 1) = ANY($1::text[])
      ORDER BY id DESC LIMIT 1`,
    [[...pages]],
  );
  const row = rows[0];
  return row
    ? { ts: row.ts.toISOString(), path: row.path, status: row.status, referer: row.referer }
    : null;
}

/**
 * What the verdict is about, in order of preference: the video overlay, which
 * is what the owner checks, then the mobile page when the overlay has left no
 * trace at all. config.html has no map button, so it is never the subject
 * (its events and requests are still in the tables).
 */
const VERDICT_SURFACES = ['video_overlay', 'mobile'] as const;

/**
 * The newest session and the newest iframe request of the same surface.
 * Comparing a config.html or mobile.html request with an overlay session
 * would report a page that did answer as one that never did.
 */
export async function loadVerdictSubject(): Promise<{
  sessionRows: DiagEventRow[];
  lastIframeRequest: LastIframeRequest | null;
}> {
  for (const surface of VERDICT_SURFACES) {
    const [sessionRows, lastIframeRequest] = await Promise.all([
      loadLastSessionRows(surface),
      findLastIframeRequest(SURFACE_PAGES[surface]),
    ]);
    if (sessionRows.length > 0 || lastIframeRequest) return { sessionRows, lastIframeRequest };
  }
  return { sessionRows: [], lastIframeRequest: null };
}

/** Everything GET /api/admin/ext-diagnostics returns. */
export async function loadExtDiagnostics(limit: number): Promise<ExtDiagnosticsResponse> {
  const [events, requests, { sessionRows, lastIframeRequest }] = await Promise.all([
    listDiagEvents(limit),
    listRequestLog(limit),
    loadVerdictSubject(),
  ]);
  const now = Date.now();
  const lastSession = summarizeSession(sessionRows);

  return {
    serverTime: now,
    events: events.map(presentEvent),
    requests: requests.map((r) => ({ ...r, ts: r.ts.toISOString() })),
    summary: {
      lastIframeRequest,
      lastSession,
      verdict: computeVerdict({ lastIframeRequest, lastSession, now }),
    },
  };
}

/**
 * Keep both tables inside DIAG_RETENTION_DAYS and DIAG_MAX_ROWS. Returns the
 * number of rows removed from each.
 */
export async function pruneExtDiagnostics(
  days = DIAG_RETENTION_DAYS,
  maxRows = DIAG_MAX_ROWS,
): Promise<{ events: number; requests: number }> {
  const interval = String(Math.max(1, Math.trunc(days)));
  const keep = Math.max(0, Math.trunc(maxRows));

  async function prune(table: 'ext_diag_events' | 'ext_request_log', timeColumn: string): Promise<number> {
    const old = await query(
      `DELETE FROM ${table} WHERE ${timeColumn} < now() - ($1 || ' days')::interval`,
      [interval],
    );
    // Everything at or below the id of the (keep+1)-th newest row. With fewer
    // rows than that the subquery is NULL and nothing matches.
    const over = await query(
      `DELETE FROM ${table}
        WHERE id <= (SELECT id FROM ${table} ORDER BY id DESC OFFSET $1 LIMIT 1)`,
      [keep],
    );
    return (old.rowCount ?? 0) + (over.rowCount ?? 0);
  }

  const events = await prune('ext_diag_events', 'received_at');
  const requests = await prune('ext_request_log', 'ts');
  return { events, requests };
}
