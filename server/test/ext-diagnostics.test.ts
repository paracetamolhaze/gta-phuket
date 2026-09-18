import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, servicesAvailable } from './helpers/services.js';
import { cleanObject, parseDiagBatch, redactString } from '../src/diag/sanitize.js';
import { formatTrigger, parseTrigger, summarizeSession } from '../src/diag/session.js';
import { computeVerdict } from '../src/diag/verdict.js';
import { parseAccessLogLine } from '../src/diag/accessLog.js';
import { startRequestLogIngest } from '../src/diag/ingest.js';
import type {
  DiagEventRow,
  LastIframeRequest,
  LastSessionSummary,
  RequestLogEntry,
  VerdictCode,
} from '../src/diag/schema.js';

const online = await servicesAvailable();
const d = online ? describe : describe.skip;

// A syntactically real JWT; the point is that nothing shaped like one survives.
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJvcGFxdWVfdXNlcl9pZCI6IlUxMjM0NSIsInJvbGUiOiJ2aWV3ZXIifQ.c2lnbmF0dXJlLXZhbHVlLWhlcmU';

const NOW = Date.parse('2026-09-18T12:00:00Z');

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

function batch(events: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, session: 'sess_ABCDEFGH12345678', surface: 'video_overlay', events, ...extra };
}

const VISIBLE_TRIGGER = {
  which: 'react',
  rendered: true,
  rect: { x: 38, y: 396, w: 120, h: 48 },
  display: 'block',
  visibility: 'visible',
  opacity: 1,
  pointerEvents: 'auto',
  zIndex: '2147483000',
  inViewport: true,
  hitTest: 'self',
  visible: true,
};

// ---------------------------------------------------------------------------
// Redaction and validation
// ---------------------------------------------------------------------------

describe('diagnostics redaction', () => {
  it('removes a JWT nested deep in the data', () => {
    const cleaned = cleanObject({
      a: { b: { c: `helper said ${JWT} twice`, list: [`x ${JWT}`] } },
    });
    const text = JSON.stringify(cleaned);
    expect(text).not.toContain('eyJ');
    expect(text).toContain('[jwt]');
  });

  it('drops secret and identity keys wherever they are', () => {
    const cleaned = cleanObject({
      token: 'abc',
      helixToken: 'abc',
      authorization: 'Bearer abc',
      nested: { refresh_token: 'x', clientSecret: 'x', Cookie: 'x', password: 'x', keep: 1 },
      userId: '12345',
      opaqueUserId: 'U12345',
      clientId: 'extension-client-id',
    });
    expect(cleaned).toEqual({ nested: { keep: 1 }, clientId: 'extension-client-id' });
  });

  it('reduces URLs to origin + path and scrubs inline credentials', () => {
    expect(
      redactString('failed https://user:pw@gudinigta6.duckdns.org/video_overlay.html?anchor=x&token=abc#frag'),
    ).toBe('failed https://gudinigta6.duckdns.org/video_overlay.html');
    expect(redactString('GET /api/ext/state?token=abc failed')).toBe('GET /api/ext/state failed');
    expect(redactString('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def');
    expect(redactString('helixToken=zzz123 and more')).toBe('helixToken=[redacted] and more');
    expect(redactString('OAuth failed')).toBe('OAuth failed');
  });

  it('bounds strings, depth, keys and arrays', () => {
    const cleaned = cleanObject({
      long: 'x'.repeat(5000),
      deep: { l2: { l3: { l4: { l5: 'gone' } } } },
      list: Array.from({ length: 30 }, (_, i) => i),
      many: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i])),
    }) as { long: string; deep: { l2: { l3: { l4: unknown } } }; list: unknown[]; many: object };
    expect(cleaned.long.length).toBeLessThanOrEqual(300);
    expect(cleaned.deep.l2.l3.l4).toBe('[…]');
    expect(cleaned.list).toHaveLength(10);
    expect(Object.keys(cleaned.many)).toHaveLength(40);
  });

  it('turns a non-numeric channelId into null, in the snapshot and in data', () => {
    const result = parseDiagBatch(
      batch([
        {
          event: 'onAuthorized_fired',
          snap: { channelId: 'gudini_younger', viewerKind: 'anonymous' },
          data: { channelId: '12ab', clientId: 'cid', viewerKind: 'anonymous', token: JWT },
        },
        { event: 'onVisibilityChanged', snap: { channelId: '123456789' }, data: { visible: true } },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [first, second] = result.batch.events;
    expect(first?.snap.channelId).toBeNull();
    expect(first?.data.channelId).toBeNull();
    expect(first?.data).not.toHaveProperty('token');
    expect(second?.snap.channelId).toBe('123456789');
  });

  it('accepts a text/plain JSON string and strips unknown keys', () => {
    const result = parseDiagBatch(
      JSON.stringify(
        batch([
          {
            event: 'html_loaded',
            t: NOW,
            seq: 1,
            snap: {
              viewport: { w: 1280.4, h: 720, dpr: 2 },
              params: { anchor: 'video_overlay', state: 'testing', token: JWT, foo: 'bar' },
              pageOrigin: 'https://gudinigta6.duckdns.org',
              userId: '12345',
              somethingElse: true,
            },
          },
        ], { extra: 'dropped' }),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ev = result.batch.events[0]!;
    expect(ev.clientTs?.getTime()).toBe(NOW);
    expect(ev.snap.viewport).toEqual({ w: 1280, h: 720, dpr: 2 });
    expect(ev.snap.params).toEqual({ anchor: 'video_overlay', state: 'testing' });
    expect(ev.snap).not.toHaveProperty('userId');
    expect(ev.snap).not.toHaveProperty('somethingElse');
    expect(JSON.stringify(result.batch)).not.toContain('eyJ');
  });

  it('rejects 26 events, an unknown event, a bad session and non-JSON', () => {
    const one = { event: 'page_hide', data: {} };
    expect(parseDiagBatch(batch(Array.from({ length: 25 }, () => one))).ok).toBe(true);
    expect(parseDiagBatch(batch(Array.from({ length: 26 }, () => one))).ok).toBe(false);
    expect(parseDiagBatch(batch([])).ok).toBe(false);
    expect(parseDiagBatch(batch([{ event: 'rm_rf', data: {} }])).ok).toBe(false);
    expect(parseDiagBatch(batch([one], { session: 'short' })).ok).toBe(false);
    expect(parseDiagBatch(batch([one], { session: 'has spaces in it!' })).ok).toBe(false);
    expect(parseDiagBatch(batch([one], { v: 2 })).ok).toBe(false);
    expect(parseDiagBatch('{"v":1,').ok).toBe(false);
    expect(parseDiagBatch(null).ok).toBe(false);
  });

  it('never leaves half a surrogate pair, which jsonb would refuse', () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    // The cut at 300 lands between the two halves of 🗺.
    const cut = redactString(`${'x'.repeat(298)}🗺 КАРТА and more`);
    expect(cut).not.toMatch(lone);
    expect(cut.endsWith('…')).toBe(true);
    // Sent on purpose, in a value and in a key.
    const result = parseDiagBatch(
      JSON.stringify(batch([{ event: 'runtime_error', data: { error: { message: 'a\uD83Db' }, ['k\uDC00']: 1 } }])),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = JSON.stringify(result.batch);
    // JSON.stringify escapes only lone surrogates; a whole pair is written as is.
    expect(text).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    expect(result.batch.events[0]?.data).toEqual({ error: { message: 'a�b' }, 'k�': 1 });
  });

  it('stores origins as bare origins', () => {
    const result = parseDiagBatch(
      batch([
        {
          event: 'html_loaded',
          snap: {
            pageOrigin: 'https://gudinigta6.duckdns.org',
            referrerOrigin: 'https://supervisor.ext-twitch.tv/?x=1',
            ancestorOrigins: ['https://supervisor.ext-twitch.tv', 'https://www.twitch.tv/', 'capacitor://m.twitch.tv', 'junk'],
          },
        },
        { event: 'page_hide', snap: { pageOrigin: 'null', referrerOrigin: null } },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.batch.events[0]?.snap).toMatchObject({
      pageOrigin: 'https://gudinigta6.duckdns.org',
      referrerOrigin: 'https://supervisor.ext-twitch.tv',
      ancestorOrigins: ['https://supervisor.ext-twitch.tv', 'https://www.twitch.tv', 'capacitor://m.twitch.tv'],
    });
    expect(result.batch.events[1]?.snap).toMatchObject({ pageOrigin: 'null', referrerOrigin: null });
  });

  it('drops a mistyped snapshot field instead of the whole batch', () => {
    const result = parseDiagBatch(
      batch([{ event: 'page_hide', snap: { viewport: 'big', authorized: 'yes', framed: true } }]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.batch.events[0]?.snap).toEqual({ framed: true });
  });
});

// ---------------------------------------------------------------------------
// Session summary and trigger text
// ---------------------------------------------------------------------------

function row(
  id: number,
  event: string,
  data: Record<string, unknown> = {},
  state: DiagEventRow['state'] = {},
  msAgo = 5000,
): DiagEventRow {
  return {
    id,
    receivedAt: new Date(NOW - msAgo),
    clientTs: null,
    session: 'sess_ABCDEFGH12345678',
    surface: 'video_overlay',
    event,
    channelId: null,
    viewerKind: 'unknown',
    state,
    data,
  };
}

describe('session summary', () => {
  it('folds a healthy page load into the facts /admin shows', () => {
    const snap = {
      viewport: { w: 1280, h: 720, dpr: 1 },
      docVisibility: 'visible' as const,
      pageOrigin: 'https://gudinigta6.duckdns.org',
      referrerOrigin: 'https://supervisor.ext-twitch.tv',
      params: { anchor: 'video_overlay', state: 'testing' },
    };
    const summary = summarizeSession([
      row(1, 'twitch_helper_present', { present: true, version: '1.28.0' }, snap, 9000),
      row(2, 'html_loaded', {}, {}, 8800),
      row(3, 'onAuthorized_fired', { channelId: '123456789', viewerKind: 'anonymous' }, {}, 8000),
      row(4, 'onVisibilityChanged', { visible: true }, {}, 7900),
      row(5, 'app_bundle_loaded', { helperPresent: true, helperVersion: '1.28.0' }, {}, 7000),
      row(6, 'trigger_rendered', { trigger: VISIBLE_TRIGGER }, {}, 6900),
      row(7, 'csp_violation', { csp: { directive: 'img-src', blockedURI: 'https://x.test/a.png' } }, {}, 6000),
      row(8, 'runtime_error', { error: { message: 'boom' } }, {}, 5000),
    ]);
    expect(summary).toMatchObject({
      htmlLoaded: true,
      appBundleLoaded: true,
      appBundleMissing: false,
      helperPresent: true,
      helperVersion: '1.28.0',
      authorized: true,
      channelId: '123456789',
      viewerKind: 'anonymous',
      viewport: '1280×720',
      twitchVisible: true,
      docVisibility: 'visible',
      triggerVisible: true,
      triggerWhich: 'react',
      trigger: 'видна 120×48 @ 38,396 (react)',
      errorCount: 1,
      cspCount: 1,
      referrerOrigin: 'https://supervisor.ext-twitch.tv',
      twitchState: 'testing',
      anchor: 'video_overlay',
      firstAt: iso(9000),
      lastAt: iso(5000),
    });
    expect(summary?.events.slice(0, 3)).toEqual(['twitch_helper_present', 'html_loaded', 'onAuthorized_fired']);
    expect(computeVerdict({ lastIframeRequest: null, lastSession: summary, now: NOW }).code).toBe('ok');
  });

  it('says why a trigger is hidden', () => {
    const hidden = (over: Record<string, unknown>) =>
      formatTrigger(parseTrigger({ ...VISIBLE_TRIGGER, visible: undefined, ...over })!);
    expect(hidden({ display: 'none', which: 'raw' })).toBe('скрыта: display none (raw)');
    expect(hidden({ opacity: 0 })).toBe('скрыта: opacity 0 (react)');
    expect(hidden({ rect: { x: 0, y: 0, w: 0, h: 48 } })).toBe('скрыта: размер 0×48 (react)');
    expect(hidden({ inViewport: false })).toMatch(/^скрыта: за пределами iframe/);
    expect(hidden({ rendered: false })).toBe('скрыта: нет в DOM (react)');
    expect(hidden({ hitTest: 'covered' })).toBe('видна 120×48 @ 38,396 (react), перекрыта');
  });

  const SEEN = { viewport: { w: 1280, h: 720, dpr: 1 }, docVisibility: 'visible' as const, twitchVisible: true };
  const RAW_VISIBLE = { ...VISIBLE_TRIGGER, which: 'raw', rect: { x: 128, y: 180, w: 240, h: 72 } };
  const REACT_HIDDEN = { ...VISIBLE_TRIGGER, display: 'none', visible: false };

  function verdictOfRows(rows: DiagEventRow[]) {
    return computeVerdict({ lastIframeRequest: null, lastSession: summarizeSession(rows), now: NOW });
  }

  it('keeps ok after the tab goes to the background and the page is closed', () => {
    const healthy = [
      row(1, 'twitch_helper_present', { present: true, version: '1.28.0' }, SEEN, 60_000),
      row(2, 'html_loaded', {}, {}, 59_000),
      row(3, 'app_bundle_loaded', {}, {}, 58_000),
      row(4, 'trigger_rendered', { trigger: VISIBLE_TRIGGER }, {}, 58_000),
      row(5, 'onAuthorized_fired', { channelId: '123456789', viewerKind: 'anonymous' }, {}, 57_000),
    ];
    expect(verdictOfRows(healthy).code).toBe('ok');
    const left = [
      ...healthy,
      row(6, 'document_visibility', { state: 'hidden' }, { docVisibility: 'hidden' }, 30_000),
      row(7, 'page_hide', {}, { docVisibility: 'hidden' }, 10_000),
    ];
    const v = verdictOfRows(left);
    expect(v.code).toBe('ok');
    expect(v.text).toMatch(/Сейчас страница не на экране/);
    expect(summarizeSession(left)).toMatchObject({ docVisibility: 'hidden', onScreenTriggerVisible: true });
  });

  it('does not count a measurement from a background tab as seen', () => {
    const background = [
      row(1, 'twitch_helper_present', { present: true }, { ...SEEN, docVisibility: 'hidden' }, 60_000),
      row(2, 'app_bundle_loaded', {}, {}, 58_000),
      row(3, 'trigger_rendered', { trigger: VISIBLE_TRIGGER }, {}, 58_000),
    ];
    expect(summarizeSession(background)?.onScreenTriggerVisible).toBeNull();
    expect(verdictOfRows(background).code).toBe('iframe_hidden');
    // Brought to the front: now it is on screen.
    const front = [...background, row(4, 'document_visibility', { state: 'visible' }, { docVisibility: 'visible' }, 20_000)];
    expect(verdictOfRows(front).code).toBe('ok_unauthorized');
  });

  it('never lets the raw SMOKE_TEST button stand in for a hidden map button', () => {
    const rows = [
      row(1, 'twitch_helper_present', { present: true }, { ...SEEN, triggerVisible: true }, 60_000),
      row(2, 'html_loaded', { trigger: RAW_VISIBLE }, { triggerVisible: true }, 59_000),
      row(3, 'app_bundle_loaded', {}, {}, 58_000),
      row(4, 'trigger_rendered', { trigger: REACT_HIDDEN }, { triggerVisible: false }, 58_000),
      row(5, 'raw_button_upgraded', { trigger: RAW_VISIBLE }, {}, 58_000),
    ];
    const hidden = verdictOfRows(rows);
    expect(hidden.code).toBe('trigger_hidden');
    expect(hidden.text).toBe(
      'Кнопка карты есть, но не видна: display none (react). ' +
        'Кнопка EXTENSION LOADED при этом видна: iframe показан, кнопку прячет приложение.',
    );
    // One more event, whatever its snapshot says, changes nothing.
    const later = verdictOfRows([...rows, row(6, 'onHighlightChanged', { highlighted: true }, { triggerVisible: true }, 50_000)]);
    expect(later).toEqual(hidden);
    expect(summarizeSession(rows)).toMatchObject({
      triggerVisible: false,
      triggerWhich: 'react',
      rawVisible: true,
      rawTrigger: 'видна 240×72 @ 128,180 (raw)',
    });
  });

  it('reports a React crash as trigger_missing, SMOKE_TEST or not', () => {
    for (const html of [{ trigger: RAW_VISIBLE }, {}]) {
      const rows = [
        row(1, 'twitch_helper_present', { present: true }, SEEN, 60_000),
        row(2, 'html_loaded', html, {}, 59_000),
        row(3, 'app_bundle_loaded', {}, {}, 58_000),
        row(4, 'runtime_error', { error: { message: 'TypeError: boom', source: 'https://x.test/App.js', line: 1 } }, {}, 58_000),
        row(5, 'onAuthorized_fired', { channelId: '123456789' }, {}, 57_000),
      ];
      const v = verdictOfRows(rows);
      expect(v.code).toBe('trigger_missing');
      expect(v.text).toBe('Приложение запустилось, но кнопка карты не появилась: TypeError: boom @ https://x.test/App.js:1.');
    }
  });
});

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

function sessionSummary(over: Partial<LastSessionSummary> = {}): LastSessionSummary {
  return {
    session: 'sess_ABCDEFGH12345678',
    surface: 'video_overlay',
    firstAt: iso(60_000),
    lastAt: iso(30_000),
    events: ['twitch_helper_present', 'html_loaded', 'app_bundle_loaded', 'trigger_rendered'],
    htmlLoaded: true,
    appBundleLoaded: true,
    appBundleMissing: false,
    helperPresent: true,
    helperVersion: '1.28.0',
    authorized: true,
    channelId: '123456789',
    viewerKind: 'anonymous',
    viewport: '1280×720',
    twitchVisible: true,
    docVisibility: 'visible',
    triggerVisible: true,
    triggerWhich: 'react',
    trigger: 'видна 120×48 @ 38,396 (react)',
    onScreenTriggerVisible: true,
    onScreenTrigger: 'видна 120×48 @ 38,396 (react)',
    rawVisible: null,
    rawTrigger: null,
    mapOpened: false,
    errorCount: 0,
    cspCount: 0,
    lastError: null,
    pageOrigin: 'https://gudinigta6.duckdns.org',
    referrerOrigin: 'https://supervisor.ext-twitch.tv',
    twitchState: 'testing',
    anchor: 'video_overlay',
    ...over,
  };
}

function iframeRequest(msAgo: number): LastIframeRequest {
  return {
    ts: iso(msAgo),
    path: '/video_overlay.html?anchor=video_overlay',
    status: 200,
    referer: 'https://supervisor.ext-twitch.tv/',
  };
}

function verdictOf(
  lastSession: LastSessionSummary | null,
  lastIframeRequest: LastIframeRequest | null = null,
): VerdictCode {
  return computeVerdict({ lastIframeRequest, lastSession, now: NOW }).code;
}

describe('diagnostics verdict', () => {
  it('no_data: nothing requested, nothing reported', () => {
    const v = computeVerdict({ lastIframeRequest: null, lastSession: null, now: NOW });
    expect(v).toEqual({
      code: 'no_data',
      ok: false,
      text: 'Twitch ещё не загружал расширение. Запустите стрим и откройте канал.',
    });
  });

  it('request_only: Twitch asked, the page never reported', () => {
    expect(verdictOf(null, iframeRequest(25_000))).toBe('request_only');
    // Newer than the last session by more than 20 s, and itself 20 s old.
    expect(verdictOf(sessionSummary({ lastAt: iso(120_000) }), iframeRequest(25_000))).toBe('request_only');
    // Too fresh to call yet.
    expect(verdictOf(null, iframeRequest(5_000))).toBe('pending');
    // The session that answered it is right there.
    expect(verdictOf(sessionSummary({ lastAt: iso(20_000) }), iframeRequest(25_000))).toBe('ok');
  });

  it('pending: a fresh page with nothing measured yet, and the fallback', () => {
    const fresh = sessionSummary({ firstAt: iso(3_000), lastAt: iso(2_000), triggerVisible: null, trigger: null });
    expect(verdictOf(fresh)).toBe('pending');
    const v = computeVerdict({ lastIframeRequest: null, lastSession: fresh, now: NOW });
    expect(v.text).toBe('Расширение загружается…');
    // Fallback: only the helper reported, nothing yet about the HTML or the bundle.
    expect(
      verdictOf(
        sessionSummary({
          htmlLoaded: false,
          appBundleLoaded: false,
          triggerVisible: null,
          trigger: null,
          onScreenTriggerVisible: null,
          onScreenTrigger: null,
        }),
      ),
    ).toBe('pending');
  });

  it('helper_missing', () => {
    const v = computeVerdict({
      lastIframeRequest: null,
      lastSession: sessionSummary({ helperPresent: false }),
      now: NOW,
    });
    expect(v).toEqual({ code: 'helper_missing', ok: false, text: 'Twitch Helper не загрузился в iframe.' });
  });

  it('bundle_missing: reported missing, or silent for 10 s after the HTML', () => {
    expect(verdictOf(sessionSummary({ appBundleMissing: true }))).toBe('bundle_missing');
    expect(verdictOf(sessionSummary({ appBundleLoaded: false, firstAt: iso(15_000) }))).toBe('bundle_missing');
    // Inside the first 10 s the raw SMOKE_TEST button is not the map button yet.
    const rawOnly = {
      appBundleLoaded: false,
      triggerVisible: null,
      triggerWhich: null,
      trigger: null,
      onScreenTriggerVisible: null,
      onScreenTrigger: null,
      rawVisible: true,
      rawTrigger: 'видна 240×72 @ 128,180 (raw)',
    };
    expect(verdictOf(sessionSummary({ ...rawOnly, firstAt: iso(4_000) }))).toBe('pending');
    expect(verdictOf(sessionSummary({ ...rawOnly, firstAt: iso(15_000) }))).toBe('bundle_missing');
    expect(
      computeVerdict({ lastIframeRequest: null, lastSession: sessionSummary({ appBundleMissing: true }), now: NOW })
        .text,
    ).toBe('HTML загрузился, но приложение не запустилось.');
  });

  it('trigger_missing: the bundle ran, the map button never appeared', () => {
    const crashed = sessionSummary({
      triggerVisible: null,
      triggerWhich: null,
      trigger: null,
      onScreenTriggerVisible: null,
      onScreenTrigger: null,
      rawVisible: true,
      rawTrigger: 'видна 240×72 @ 128,180 (raw)',
      errorCount: 1,
      lastError: 'TypeError: x is undefined @ https://gudinigta6.duckdns.org/assets/App-abc.js:1:200',
    });
    expect(computeVerdict({ lastIframeRequest: null, lastSession: crashed, now: NOW })).toEqual({
      code: 'trigger_missing',
      ok: false,
      text:
        'Приложение запустилось, но кнопка карты не появилась: ' +
        'TypeError: x is undefined @ https://gudinigta6.duckdns.org/assets/App-abc.js:1:200.',
    });
    // Still loading: not yet.
    expect(verdictOf({ ...crashed, firstAt: iso(4_000) })).toBe('pending');
    // config.html has no map button to miss.
    expect(verdictOf({ ...crashed, surface: 'config' })).toBe('pending');
  });

  it('iframe_hidden: paused, hidden document, or no size — while never on screen', () => {
    const never = { onScreenTriggerVisible: null, onScreenTrigger: null };
    expect(verdictOf(sessionSummary({ ...never, twitchVisible: false }))).toBe('iframe_hidden');
    expect(verdictOf(sessionSummary({ ...never, docVisibility: 'hidden' }))).toBe('iframe_hidden');
    expect(verdictOf(sessionSummary({ ...never, viewport: '0×0' }))).toBe('iframe_hidden');
    expect(verdictOf(sessionSummary({ ...never, viewport: '1280×40' }))).toBe('iframe_hidden');
    // Each cause says which it is.
    const text = (over: Partial<LastSessionSummary>) =>
      computeVerdict({ lastIframeRequest: null, lastSession: sessionSummary({ ...never, ...over }), now: NOW }).text;
    expect(text({ docVisibility: 'hidden' })).toMatch(/фоновой вкладке/);
    expect(text({ twitchVisible: false })).toMatch(/видео на паузе/);
    expect(text({ viewport: '0×0' })).toMatch(/\(0×0\)/);
  });

  it('a button seen on screen stays ok when the viewer switches tabs or leaves', () => {
    for (const over of [{ docVisibility: 'hidden' }, { twitchVisible: false }] as const) {
      const v = computeVerdict({ lastIframeRequest: null, lastSession: sessionSummary(over), now: NOW });
      expect(v.code).toBe('ok');
      expect(v.text).toMatch(/^Кнопка карты видна зрителю\. Сейчас страница не на экране/);
    }
  });

  it('trigger_hidden names the reason', () => {
    const v = computeVerdict({
      lastIframeRequest: null,
      lastSession: sessionSummary({
        triggerVisible: false,
        trigger: 'скрыта: display none (react)',
        onScreenTriggerVisible: false,
        onScreenTrigger: 'скрыта: display none (react)',
      }),
      now: NOW,
    });
    expect(v).toEqual({
      code: 'trigger_hidden',
      ok: false,
      text: 'Кнопка карты есть, но не видна: display none (react).',
    });
  });

  it('ok_unauthorized and ok', () => {
    const unauthorized = computeVerdict({
      lastIframeRequest: iframeRequest(40_000),
      lastSession: sessionSummary({ authorized: false }),
      now: NOW,
    });
    expect(unauthorized.code).toBe('ok_unauthorized');
    expect(unauthorized.ok).toBe(true);
    expect(unauthorized.text).toBe(
      'Кнопка карты видна. onAuthorized ещё не пришёл — покупка точек пока недоступна.',
    );
    const ok = computeVerdict({ lastIframeRequest: iframeRequest(40_000), lastSession: sessionSummary(), now: NOW });
    expect(ok).toEqual({ code: 'ok', ok: true, text: 'Кнопка карты видна зрителю.' });
  });
});

// ---------------------------------------------------------------------------
// Access-log parser
// ---------------------------------------------------------------------------

function caddyLine(request: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    level: 'info',
    ts: NOW / 1000,
    logger: 'http.log.access.apiingest',
    msg: 'handled request',
    request: { remote_ip: '203.0.113.77', proto: 'HTTP/1.1', method: 'GET', host: 'gudinigta6.duckdns.org', ...request },
    status: 200,
    duration: 0.0012,
    ...extra,
  });
}

const OVERLAY_REQUEST = {
  uri: '/video_overlay.html?anchor=video_overlay&language=ru&platform=web&state=testing&token=REDACTED&foo=bar',
  headers: {
    Referer: ['https://supervisor.ext-twitch.tv/?secret=1'],
    'Sec-Fetch-Dest': ['iframe'],
    'Sec-Fetch-Site': ['cross-site'],
    'User-Agent': ['Mozilla/5.0 (Windows NT 10.0) Chrome/140'],
    'X-Forwarded-For': ['203.0.113.77'],
  },
};

describe('access-log parser', () => {
  it('keeps the overlay page requested as an iframe, with only the Twitch params', () => {
    const entry = parseAccessLogLine(caddyLine(OVERLAY_REQUEST), NOW);
    expect(entry).toEqual({
      ts: new Date(NOW),
      source: 'ingress',
      method: 'GET',
      path: '/video_overlay.html?anchor=video_overlay&platform=web&state=testing&language=ru',
      status: 200,
      referer: 'https://supervisor.ext-twitch.tv/',
      secFetchDest: 'iframe',
      secFetchSite: 'cross-site',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/140',
    });
    const text = JSON.stringify(entry);
    expect(text).not.toContain('token');
    expect(text).not.toContain('foo');
    expect(text).not.toContain('203.0.113.77');
  });

  it('keeps the boot files and the bundle a Twitch page asked for', () => {
    expect(parseAccessLogLine(caddyLine({ uri: '/gtamap-boot.js?v=lx2k9' }), NOW)?.path).toBe('/gtamap-boot.js');
    const asset = parseAccessLogLine(
      caddyLine({
        uri: '/assets/video_overlay-CVORLUMB.js',
        headers: {
          Referer: ['https://gudinigta6.duckdns.org/video_overlay.html?anchor=video_overlay&token=x'],
          'Sec-Fetch-Dest': ['script'],
        },
      }),
      NOW,
    );
    expect(asset).toMatchObject({
      path: '/assets/video_overlay-CVORLUMB.js',
      referer: 'https://gudinigta6.duckdns.org/video_overlay.html',
      secFetchDest: 'script',
    });
  });

  it('drops unrelated paths and malformed lines', () => {
    const adminAsset = caddyLine({
      uri: '/assets/admin-abc.js',
      headers: { Referer: ['https://gudinigta6.duckdns.org/admin.html'] },
    });
    for (const line of [
      adminAsset,
      caddyLine({ uri: '/assets/video_overlay-CVORLUMB.js' }),
      caddyLine({ uri: '/api/ext/state' }),
      caddyLine({ uri: '/admin.html' }),
      caddyLine({ uri: '/obs.html?token=abc' }),
      'not json',
      '{"request": 1}',
      '{"request": {"uri": 42}}',
      '[]',
      '',
      `${caddyLine(OVERLAY_REQUEST).slice(0, -1)},"pad":"${'x'.repeat(70 * 1024)}"}`,
    ]) {
      expect(parseAccessLogLine(line, NOW)).toBeNull();
    }
  });

  it('honours source devserver and plain-string headers', () => {
    const entry = parseAccessLogLine(
      JSON.stringify({
        source: 'devserver',
        ts: NOW,
        request: {
          method: 'GET',
          uri: '/video_overlay.html?anchor=video_overlay',
          headers: { referer: 'https://localhost.twitch.tv:8080/', 'sec-fetch-dest': 'iframe' },
        },
        status: 304,
      }),
      NOW,
    );
    expect(entry).toMatchObject({
      source: 'devserver',
      status: 304,
      referer: 'https://localhost.twitch.tv:8080/',
      secFetchDest: 'iframe',
      ts: new Date(NOW),
    });
  });

  it('stamps an impossible clock with the receive time', () => {
    const entry = parseAccessLogLine(caddyLine(OVERLAY_REQUEST, { ts: 4_102_444_800 }), NOW);
    expect(entry?.ts.getTime()).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// TCP ingest
// ---------------------------------------------------------------------------

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function openSocket(port: number): Promise<Socket> {
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  await once(socket, 'connect');
  return socket;
}

describe('request-log TCP ingest', () => {
  it('reads newline-delimited lines, split or batched, and skips junk', async () => {
    const got: RequestLogEntry[] = [];
    const ingest = await startRequestLogIngest({ port: 0, host: '127.0.0.1', sink: (e) => void got.push(e) });
    expect(ingest).not.toBeNull();
    try {
      const socket = await openSocket(ingest!.port);
      const boot = caddyLine({ uri: '/gtamap-boot.js?v=1' });
      socket.write(`${caddyLine(OVERLAY_REQUEST)}\nnot json\n${caddyLine({ uri: '/api/health' })}\n${boot.slice(0, 25)}`);
      socket.write(`${boot.slice(25)}\n`);
      await waitFor(() => got.length === 2);
      expect(got.map((e) => e.path)).toEqual([
        '/video_overlay.html?anchor=video_overlay&platform=web&state=testing&language=ru',
        '/gtamap-boot.js',
      ]);
      socket.destroy();
    } finally {
      await ingest?.close();
    }
  });

  it('cuts off a peer that never sends a newline', async () => {
    const ingest = await startRequestLogIngest({ port: 0, host: '127.0.0.1', sink: () => undefined });
    try {
      const socket = await openSocket(ingest!.port);
      // Not events.once: the reset arrives as an 'error' first, which it would reject on.
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.write(Buffer.alloc(1_200_000, 0x61));
      await closed;
    } finally {
      await ingest?.close();
    }
  });

  it('caps kept rows, so a flood of forged requests cannot flood the table', async () => {
    const got: RequestLogEntry[] = [];
    const ingest = await startRequestLogIngest({
      port: 0,
      host: '127.0.0.1',
      sink: (e) => void got.push(e),
      keepPerSecond: 0.001,
      keepBurst: 3,
    });
    try {
      const socket = await openSocket(ingest!.port);
      socket.write(`${Array.from({ length: 8 }, () => caddyLine(OVERLAY_REQUEST)).join('\n')}\n`);
      await waitFor(() => got.length === 3);
      // Give the other five every chance to (wrongly) arrive.
      await new Promise((r) => setTimeout(r, 200));
      expect(got).toHaveLength(3);
      socket.destroy();
    } finally {
      await ingest?.close();
    }
  });

  it('carries on when the port is taken', async () => {
    const first = await startRequestLogIngest({ port: 0, host: '127.0.0.1', sink: () => undefined });
    try {
      const second = await startRequestLogIngest({ port: first!.port, host: '127.0.0.1', sink: () => undefined });
      expect(second).toBeNull();
    } finally {
      await first?.close();
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP + Postgres
// ---------------------------------------------------------------------------

d('extension diagnostics endpoints', () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    const { buildApp } = await import('../src/app.js');
    const { signAdminToken } = await import('../src/http/auth.js');
    app = await buildApp();
    await app.ready();
    adminToken = signAdminToken();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  async function countEvents(): Promise<number> {
    const { query } = await import('../src/db/pool.js');
    const { rows } = await query<{ n: number }>('SELECT count(*)::int AS n FROM ext_diag_events');
    return rows[0]?.n ?? 0;
  }

  function post(body: string, contentType = 'text/plain;charset=UTF-8', remoteAddress = '10.20.30.40') {
    return app.inject({
      method: 'POST',
      url: '/api/diag/ext',
      headers: { 'content-type': contentType },
      payload: body,
      remoteAddress,
    });
  }

  const HEALTHY = batch([
    {
      event: 'twitch_helper_present',
      seq: 1,
      t: Date.now(),
      snap: { viewport: { w: 1280, h: 720, dpr: 1 }, docVisibility: 'visible', helperPresent: true },
      data: { present: true, version: '1.28.0' },
    },
    { event: 'html_loaded', seq: 2, data: { trigger: { ...VISIBLE_TRIGGER, which: 'raw' } } },
    {
      event: 'onAuthorized_fired',
      seq: 3,
      data: { channelId: '123456789', clientId: 'cid', viewerKind: 'anonymous', token: JWT, helixToken: 'h' },
    },
    { event: 'onVisibilityChanged', seq: 4, data: { visible: true } },
    { event: 'app_bundle_loaded', seq: 5, data: { helperPresent: true, helperVersion: '1.28.0' } },
    {
      event: 'runtime_error',
      seq: 6,
      data: { error: { message: `bad ${JWT} Bearer abc`, source: 'https://x.test/a.js?token=zzz', line: 3 } },
    },
    { event: 'trigger_rendered', seq: 7, data: { trigger: VISIBLE_TRIGGER } },
  ]);

  it('stores a text/plain batch without any token', async () => {
    const res = await post(JSON.stringify(HEALTHY));
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    const { query } = await import('../src/db/pool.js');
    const { rows } = await query<{ all: string }>(
      `SELECT string_agg(state::text || data::text || coalesce(channel_id, ''), ' ') AS all FROM ext_diag_events`,
    );
    const stored = rows[0]?.all ?? '';
    expect(await countEvents()).toBe(7);
    expect(stored).not.toContain('eyJ');
    expect(stored).not.toContain('zzz');
    expect(stored).not.toMatch(/helixToken|"token"/);
    expect(stored).toContain('123456789');
  });

  it('accepts application/json too and rejects junk with 400', async () => {
    const ok = await post(JSON.stringify(batch([{ event: 'page_hide', data: {} }])), 'application/json');
    expect(ok.statusCode).toBe(204);

    expect((await post('not json')).statusCode).toBe(400);
    expect((await post(JSON.stringify(batch([{ event: 'nope' }])))).statusCode).toBe(400);
    expect(
      (await post(JSON.stringify(batch(Array.from({ length: 26 }, () => ({ event: 'page_hide' })))))).statusCode,
    ).toBe(400);
    expect(await countEvents()).toBe(1);
  });

  it('stores a batch carrying half a surrogate pair instead of failing it', async () => {
    const body = JSON.stringify(
      batch([
        { event: 'html_loaded', data: {} },
        { event: 'runtime_error', data: { error: { message: `${'x'.repeat(298)}🗺 lone \uD83D here` } } },
      ]),
    );
    expect((await post(body)).statusCode).toBe(204);
    expect(await countEvents()).toBe(2);
  });

  it('refuses an oversized body', async () => {
    const res = await post(JSON.stringify(batch([{ event: 'page_hide', data: { pad: 'x'.repeat(40_000) } }])));
    expect(res.statusCode).toBe(413);
    expect(await countEvents()).toBe(0);
  });

  it('rate limits per client IP and stores nothing over the limit', async () => {
    const { redis } = await import('../src/redis/client.js');
    const { K } = await import('../src/redis/keys.js');
    await redis.set(K.rate('extdiag', '10.99.0.1'), '120', 'EX', 60);

    const limited = await post(JSON.stringify(HEALTHY), 'text/plain', '10.99.0.1');
    expect(limited.statusCode).toBe(429);
    expect(await countEvents()).toBe(0);

    // Somebody else's page is unaffected.
    expect((await post(JSON.stringify(HEALTHY), 'text/plain', '10.99.0.2')).statusCode).toBe(204);
  });

  it('admin view needs the admin token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/ext-diagnostics' });
    expect(res.statusCode).toBe(401);
  });

  it('admin view returns the contract shape, newest first, with a verdict', async () => {
    const { insertRequestLog } = await import('../src/diag/store.js');
    await insertRequestLog({
      ts: new Date(),
      source: 'ingress',
      method: 'GET',
      path: '/video_overlay.html?anchor=video_overlay',
      status: 200,
      referer: 'https://supervisor.ext-twitch.tv/',
      secFetchDest: 'iframe',
      secFetchSite: 'cross-site',
      userAgent: 'Mozilla/5.0',
    });
    expect((await post(JSON.stringify(HEALTHY))).statusCode).toBe(204);

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/ext-diagnostics?limit=5',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(typeof body.serverTime).toBe('number');
    expect(body.events).toHaveLength(5);
    const newest = body.events[0];
    expect(newest).toMatchObject({
      event: 'trigger_rendered',
      session: 'sess_ABCDEFGH12345678',
      surface: 'video_overlay',
      channelId: '123456789',
      viewerKind: 'anonymous',
      viewport: '1280×720',
      docVisibility: 'visible',
      twitchVisible: true,
      helper: '1.28.0',
      authorized: true,
      trigger: 'видна 120×48 @ 38,396 (react)',
      error: null,
    });
    expect(Object.keys(newest).sort()).toEqual(
      [
        'id', 'receivedAt', 'clientTs', 'session', 'surface', 'event', 'channelId', 'viewerKind', 'viewport',
        'docVisibility', 'twitchVisible', 'helper', 'authorized', 'trigger', 'error', 'data',
      ].sort(),
    );
    const error = body.events.find((e: { event: string }) => e.event === 'runtime_error');
    expect(error.error).toBe('bad [jwt] Bearer [redacted] @ https://x.test/a.js:3');

    expect(body.requests).toEqual([
      expect.objectContaining({
        source: 'ingress',
        path: '/video_overlay.html?anchor=video_overlay',
        status: 200,
        secFetchDest: 'iframe',
      }),
    ]);
    expect(body.summary.lastIframeRequest).toMatchObject({ path: '/video_overlay.html?anchor=video_overlay' });
    expect(body.summary.lastSession).toMatchObject({
      session: 'sess_ABCDEFGH12345678',
      htmlLoaded: true,
      appBundleLoaded: true,
      helperPresent: true,
      authorized: true,
      triggerVisible: true,
      errorCount: 1,
    });
    expect(body.summary.verdict).toEqual({ code: 'ok', ok: true, text: 'Кнопка карты видна зрителю.' });
    expect(res.body).not.toContain('eyJ');
  });

  it('judges a request against a session of the same page, never config against the overlay', async () => {
    const { query } = await import('../src/db/pool.js');
    const { insertRequestLog } = await import('../src/diag/store.js');
    expect((await post(JSON.stringify(HEALTHY))).statusCode).toBe(204);
    // The overlay reported two minutes ago…
    await query(`UPDATE ext_diag_events SET received_at = now() - interval '120 seconds'`);
    // …and a minute ago the owner opened the extension's config page.
    const request = (path: string) =>
      insertRequestLog({
        ts: new Date(Date.now() - 60_000),
        source: 'ingress',
        method: 'GET',
        path,
        status: 200,
        referer: 'https://dashboard.twitch.tv/',
        secFetchDest: 'iframe',
        secFetchSite: 'cross-site',
        userAgent: 'Mozilla/5.0',
      });
    const view = async () =>
      (
        await app.inject({
          method: 'GET',
          url: '/api/admin/ext-diagnostics',
          headers: { authorization: `Bearer ${adminToken}` },
        })
      ).json();

    await request('/config.html?anchor=config');
    let body = await view();
    expect(body.summary.verdict.code).toBe('ok');
    expect(body.summary.lastIframeRequest).toBeNull();
    expect(body.requests).toHaveLength(1);

    // An overlay load that never reported is still caught.
    await request('/video_overlay.html?anchor=video_overlay');
    body = await view();
    expect(body.summary.verdict.code).toBe('request_only');
    expect(body.summary.lastIframeRequest).toMatchObject({ path: '/video_overlay.html?anchor=video_overlay' });
  });

  it('writes what the TCP ingest keeps into ext_request_log', async () => {
    const { query } = await import('../src/db/pool.js');
    const ingest = await startRequestLogIngest({ port: 0, host: '127.0.0.1' });
    try {
      const socket = await openSocket(ingest!.port);
      socket.write(`${caddyLine(OVERLAY_REQUEST, { ts: Date.now() / 1000 })}\n`);
      await waitFor(async () => {
        const { rows } = await query<{ n: number }>('SELECT count(*)::int AS n FROM ext_request_log');
        return (rows[0]?.n ?? 0) === 1;
      });
      socket.destroy();
      const { rows } = await query('SELECT * FROM ext_request_log');
      expect(rows[0]).toMatchObject({ sec_fetch_dest: 'iframe', referer: 'https://supervisor.ext-twitch.tv/' });
    } finally {
      await ingest?.close();
    }
  });

  it('prunes beyond the row cap and the retention window', async () => {
    const { query } = await import('../src/db/pool.js');
    const { pruneExtDiagnostics } = await import('../src/diag/store.js');
    for (let i = 0; i < 5; i += 1) {
      expect((await post(JSON.stringify(batch([{ event: 'page_hide' }], { session: `sess_prune_${i}xx` })))).statusCode).toBe(204);
    }
    await query(`UPDATE ext_diag_events SET received_at = now() - interval '8 days' WHERE id = 5`);

    // Row 5 goes for its age; of the four left, the oldest goes for the cap.
    const removed = await pruneExtDiagnostics(7, 3);
    expect(removed.events).toBe(2);
    const { rows } = await query<{ id: number }>('SELECT id FROM ext_diag_events ORDER BY id');
    expect(rows.map((r) => r.id)).toEqual([2, 3, 4]);
  });
});
