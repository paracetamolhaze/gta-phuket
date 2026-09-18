import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JUNGCEYLON,
  PATONG,
  TEST_CHANNEL,
  pushGps,
  resetDatabase,
  servicesAvailable,
} from './helpers/services.js';
import { env, reloadEnv } from '../src/env.js';
import { setPaymentModeOverride } from '../src/domain/paymentMode.js';
import { signDevExtensionJwt } from '../src/twitch/extJwt.js';
import type { WalkingRoute } from '../src/domain/types.js';

/**
 * REVIEW_DEMO_MODE (server/src/domain/gps.ts) and the broadcaster readiness
 * status the Twitch Config page reads (GET /api/ext/broadcaster/status).
 *
 * Real Postgres and Redis underneath; Mapbox is faked (routes cost money and
 * the point here is where the origin comes from), and Twitch is the local
 * Helix stub, so nothing here can reach a real channel.
 */

const ROUTE: WalkingRoute = {
  distanceMeters: 1370,
  durationSeconds: 1080,
  geometry: 'ynq}@_k~kEa@qA',
  snappedDestination: JUNGCEYLON,
  snapDistanceMeters: 4,
};

vi.mock('../src/maps/mapbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/maps/mapbox.js')>();
  return { ...actual, getWalkingRoute: vi.fn(async () => ROUTE), searchPlaces: vi.fn(async () => []) };
});

const online = await servicesAvailable();
const d = online ? describe : describe.skip;

const VIEWER = '100000001';
const DEMO = { lat: 7.8961, lng: 98.2958 };

// ---------------------------------------------------------------------------
// Configuration switches. Every test sets the flags it depends on, and the
// file puts back whatever the process started with.
// ---------------------------------------------------------------------------

const ENV_KEYS = ['REVIEW_DEMO_MODE', 'REVIEW_DEMO_LAT', 'REVIEW_DEMO_LNG', 'MAPBOX_PUBLIC_TOKEN'] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const startingEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as Record<
  EnvKey,
  string | undefined
>;

function setEnv(patch: Partial<Record<EnvKey, string | undefined>>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  reloadEnv();
}

function setDemo(active: boolean): void {
  setEnv({
    REVIEW_DEMO_MODE: active ? 'true' : 'false',
    REVIEW_DEMO_LAT: undefined,
    REVIEW_DEMO_LNG: undefined,
  });
}

beforeAll(() => {
  // Pinned rather than assumed: .env may carry either mode.
  setPaymentModeOverride('gta_dollar');
});

afterAll(() => {
  setPaymentModeOverride(null);
  setEnv(startingEnv);
});

// ---------------------------------------------------------------------------
// Configuration: no database needed
// ---------------------------------------------------------------------------

describe('REVIEW_DEMO_MODE configuration', () => {
  afterAll(() => setDemo(false));

  it('is off by default and points at Patong', () => {
    setEnv({ REVIEW_DEMO_MODE: undefined, REVIEW_DEMO_LAT: undefined, REVIEW_DEMO_LNG: undefined });
    expect(env.reviewDemo).toEqual({ active: false, ...DEMO });
  });

  it('reads the flag and the point, and an empty coordinate means the default', () => {
    setEnv({ REVIEW_DEMO_MODE: 'true', REVIEW_DEMO_LAT: '7.8804', REVIEW_DEMO_LNG: '' });
    expect(env.reviewDemo).toEqual({ active: true, lat: 7.8804, lng: DEMO.lng });
  });

  it('refuses a demo point outside Phuket while the demo is on, and ignores it while off', () => {
    process.env.REVIEW_DEMO_LAT = '13.7563';
    process.env.REVIEW_DEMO_LNG = '100.5018';
    process.env.REVIEW_DEMO_MODE = 'true';
    expect(() => reloadEnv()).toThrowError(/REVIEW_DEMO_LAT\/REVIEW_DEMO_LNG inside Phuket/);
    process.env.REVIEW_DEMO_MODE = 'false';
    expect(() => reloadEnv()).not.toThrow();
    setDemo(false);
  });
});

// ---------------------------------------------------------------------------
// GPS reads, quotes and the viewer / admin surfaces
// ---------------------------------------------------------------------------

d('review demo GPS', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { buildApp } = await import('../src/app.js');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    setDemo(false);
  });

  beforeEach(async () => {
    await resetDatabase();
    setDemo(false);
    const { getWalkingRoute } = await import('../src/maps/mapbox.js');
    vi.mocked(getWalkingRoute).mockClear();
  });

  async function call(method: 'GET' | 'POST', url: string, token: string, payload?: object) {
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined ? { payload } : {}),
    });
    return { status: res.statusCode, body: res.json() };
  }

  const viewer = () => signDevExtensionJwt({ channelId: TEST_CHANNEL, userId: VIEWER });

  async function adminToken(): Promise<string> {
    const { signAdminToken } = await import('../src/http/auth.js');
    return signAdminToken();
  }

  /** Every place the live position is kept: the Redis fix and buffer, and Postgres history. */
  async function gpsStorage() {
    const { redis } = await import('../src/redis/client.js');
    const { K } = await import('../src/redis/keys.js');
    const { query } = await import('../src/db/pool.js');
    const { rows } = await query<{ n: number }>('SELECT count(*)::int AS n FROM gps_samples');
    return {
      latest: await redis.get(K.gpsLatest(TEST_CHANNEL)),
      buffered: await redis.zcard(K.gpsBuffer(TEST_CHANNEL)),
      rows: rows[0]?.n ?? 0,
    };
  }

  it('demo on: a quote is priced from the demo point with no stored GPS, and GPS storage is untouched', async () => {
    setDemo(true);
    expect(await gpsStorage()).toEqual({ latest: null, buffered: 0, rows: 0 });

    const quote = await call('POST', '/api/ext/quote', viewer(), {
      lat: JUNGCEYLON.lat,
      lng: JUNGCEYLON.lng,
      name: 'Jungceylon',
    });
    expect(quote.status).toBe(200);
    expect(quote.body.cost).toBe(1500); // 1370 m -> 14 * 100 + 100 base
    expect(quote.body.currency).toBe('GTA_DOLLAR');

    // The route was asked for from the demo point, and the quote froze it.
    const { getWalkingRoute } = await import('../src/maps/mapbox.js');
    expect(vi.mocked(getWalkingRoute).mock.calls[0]?.[0]).toEqual(DEMO);
    const { getQuote } = await import('../src/domain/quotes.js');
    expect((await getQuote(quote.body.quoteId))?.origin).toEqual(DEMO);

    // Reads never write the demo fix anywhere.
    const state = await call('GET', '/api/ext/state', viewer());
    expect(state.status).toBe(200);
    expect(state.body.gps).toMatchObject({ status: 'ok', ageMs: 0, source: 'review_demo', ...DEMO });
    expect(await gpsStorage()).toEqual({ latest: null, buffered: 0, rows: 0 });
  });

  it('demo on: every GPS read is the fresh demo fix, from the admin to the OBS state', async () => {
    setDemo(true);
    const { getGpsState, getPublicGps, requireFreshGps } = await import('../src/domain/gps.js');
    const { getSettings } = await import('../src/domain/settings.js');
    const settings = await getSettings(TEST_CHANNEL);

    const trusted = await getGpsState(TEST_CHANNEL, settings);
    expect(trusted).toMatchObject({ status: 'ok', ageMs: 0, source: 'review_demo' });
    expect(trusted.sample).toMatchObject({ ...DEMO, accuracy: 10, source: 'review_demo' });
    expect(await requireFreshGps(TEST_CHANNEL, settings)).toMatchObject(DEMO);
    expect(await getPublicGps(TEST_CHANNEL, settings)).toMatchObject({
      status: 'ok',
      source: 'review_demo',
      ...DEMO,
    });

    const admin = await call('GET', '/api/admin/state', await adminToken());
    expect(admin.status).toBe(200);
    expect(admin.body.reviewDemo).toEqual({ active: true, ...DEMO });
    expect(admin.body.gps).toMatchObject({ status: 'ok', source: 'review_demo' });

    // OBS: exact with its token, privacy-filtered without; the demo either way.
    const { obsToken } = await import('../src/http/auth.js');
    for (const url of [`/api/obs/state?token=${obsToken()}`, '/api/obs/state']) {
      const obs = await app.inject({ method: 'GET', url });
      expect(obs.statusCode).toBe(200);
      expect(obs.json().gps).toMatchObject({ status: 'ok', source: 'review_demo' });
    }
  });

  it('demo on: live fixes are still stored but not used; turning it off brings them back at once', async () => {
    setDemo(true);
    const { ingestGps, getGpsState, getPublicGps } = await import('../src/domain/gps.js');
    const { getSettings } = await import('../src/domain/settings.js');
    const settings = await getSettings(TEST_CHANNEL);

    // What callers fan out (broadcastGps, refreshLiveNavigation) is the demo fix...
    const inEffect = await ingestGps(TEST_CHANNEL, null, {
      lat: JUNGCEYLON.lat,
      lng: JUNGCEYLON.lng,
      accuracy: 5,
      heading: 90,
      speed: 1.1,
      timestamp: Date.now(),
    });
    expect(inEffect).toMatchObject({ ...DEMO, source: 'review_demo' });

    // ...while the real one is stored exactly as it came in, unlabelled.
    const stored = await gpsStorage();
    expect(stored.buffered).toBe(1);
    expect(JSON.parse(stored.latest ?? 'null')).toMatchObject({ ...JUNGCEYLON, accuracy: 5 });
    expect(JSON.parse(stored.latest ?? '{}').source).toBeUndefined();

    expect((await getGpsState(TEST_CHANNEL, settings)).sample).toMatchObject(DEMO);
    expect(await getPublicGps(TEST_CHANNEL, settings)).toMatchObject(DEMO);

    setDemo(false);
    const live = await getGpsState(TEST_CHANNEL, settings);
    expect(live).toMatchObject({ status: 'ok', source: 'live' });
    expect(live.sample).toMatchObject(JUNGCEYLON);
    expect(await getPublicGps(TEST_CHANNEL, settings)).toMatchObject({
      status: 'ok',
      source: 'live',
      ...JUNGCEYLON,
    });
  });

  it('demo off: unchanged — with no GPS a quote fails with gps_unavailable', async () => {
    const quote = await call('POST', '/api/ext/quote', viewer(), {
      lat: JUNGCEYLON.lat,
      lng: JUNGCEYLON.lng,
    });
    expect(quote.status).toBe(409);
    expect(quote.body.error).toBe('gps_unavailable');

    const { getWalkingRoute } = await import('../src/maps/mapbox.js');
    expect(vi.mocked(getWalkingRoute)).not.toHaveBeenCalled();

    const state = await call('GET', '/api/ext/state', viewer());
    expect(state.body.gps).toMatchObject({ status: 'missing', lat: null, lng: null, source: 'live' });

    const admin = await call('GET', '/api/admin/state', await adminToken());
    expect(admin.body.reviewDemo).toEqual({ active: false, ...DEMO });
    expect(admin.body.gps).toMatchObject({ status: 'missing', source: 'live' });
  });

  it('demo off: a live fix prices from the streamer, as before', async () => {
    await pushGps(PATONG.lat + 0.001, PATONG.lng);
    const quote = await call('POST', '/api/ext/quote', viewer(), {
      lat: JUNGCEYLON.lat,
      lng: JUNGCEYLON.lng,
    });
    expect(quote.status).toBe(200);
    const { getWalkingRoute } = await import('../src/maps/mapbox.js');
    expect(vi.mocked(getWalkingRoute).mock.calls[0]?.[0]).toEqual({
      lat: PATONG.lat + 0.001,
      lng: PATONG.lng,
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/ext/broadcaster/status
// ---------------------------------------------------------------------------

d('broadcaster status', () => {
  let app: FastifyInstance;

  const ACCESS_TOKEN = 'status-test-access-token-4f1c2a9e7b';
  const REFRESH_TOKEN = 'status-test-refresh-token-8d3e6b0c5a';
  const PUBLIC_MAPBOX = 'pk.eyJ1Ijoic3RhdHVzdGVzdCIsImEiOiJ0ZXN0In0.c3RhdHVzLXRlc3Q';

  beforeAll(async () => {
    // Everything below talks to "Twitch". It must be the in-process stub.
    const { useDevHelix } = await import('../src/twitch/devHelix.js');
    if (!useDevHelix()) {
      throw new Error('refusing to run: the local Helix stub is not active (TWITCH_CLIENT_ID set?)');
    }
    const { buildApp } = await import('../src/app.js');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    setEnv({ MAPBOX_PUBLIC_TOKEN: startingEnv.MAPBOX_PUBLIC_TOKEN });
    setDemo(false);
  });

  /** Everything the contract's `ready` needs, with a live fix at Patong. */
  beforeEach(async () => {
    await resetDatabase();
    setDemo(false);
    setEnv({ MAPBOX_PUBLIC_TOKEN: PUBLIC_MAPBOX });

    const { storeBroadcasterTokens } = await import('../src/twitch/tokens.js');
    const { ensureEventSubSubscriptions } = await import('../src/twitch/eventsub.js');
    const { ensureExchangeReward } = await import('../src/twitch/exchangeReward.js');
    await storeBroadcasterTokens({
      channelId: TEST_CHANNEL,
      login: 'review_channel',
      displayName: 'Review Channel',
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      scopes: ['channel:manage:redemptions', 'channel:read:redemptions'],
      expiresInSeconds: 14_400,
    });
    await ensureEventSubSubscriptions(TEST_CHANNEL);
    await ensureExchangeReward(TEST_CHANNEL);
    await pushGps(PATONG.lat, PATONG.lng);
  });

  const broadcaster = () =>
    signDevExtensionJwt({ channelId: TEST_CHANNEL, userId: TEST_CHANNEL, role: 'broadcaster' });

  async function status(token = broadcaster()) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/ext/broadcaster/status',
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode, body: res.json(), raw: res.body, token };
  }

  it('is for the broadcaster only', async () => {
    const res = await status(signDevExtensionJwt({ channelId: TEST_CHANNEL, userId: VIEWER }));
    expect(res.status).toBe(403);
  });

  it('returns the contract fields, and is ready when everything is wired up', async () => {
    const { status: code, body } = await status();
    expect(code).toBe(200);

    // New in the contract.
    expect(body.mapbox).toEqual({ ready: true });
    expect(body.eventsub).toEqual({ ready: true, count: 1 });
    expect(body.gps).toMatchObject({ status: 'ok', source: 'live' });
    expect(typeof body.gps.ageMs).toBe('number');
    expect(body.reviewDemo).toEqual({ active: false });
    expect(body.economy).toEqual({
      paymentMode: 'gta_dollar',
      exchangeRate: 10,
      exchangeReward: { ready: true, title: 'Обмен ETH на GTA DOLLAR', cost: 500 },
    });
    expect(body.adminUrl).toBe(`${env.PUBLIC_WEB_URL.replace(/\/$/, '')}/admin`);
    expect(body.twitch).toMatchObject({ connected: true, login: 'review_channel' });
    expect(body.ready).toBe(true);

    // Kept from before.
    expect(body.channelId).toBe(TEST_CHANNEL);
    expect(typeof body.serverTime).toBe('number');
    expect(body.backend).toEqual({ ok: true, devMode: env.devModeEnabled });
    expect(body.twitch).toMatchObject({
      usingLocalStub: true,
      scopes: ['channel:manage:redemptions', 'channel:read:redemptions'],
      eventsubCount: 2, // redemption.add and redemption.update
    });
    expect(body.gps.accuracy).toBe(6);
    expect(body.mapboxConfigured).toBe(true);
    expect(body.waypointsOpen).toBe(true);
    expect(body.slots).toEqual({ free: expect.any(Number), total: expect.any(Number) });
  });

  it('carries nothing token-shaped', async () => {
    const res = await status();
    const text = res.raw;

    for (const secret of [
      ACCESS_TOKEN,
      REFRESH_TOKEN,
      PUBLIC_MAPBOX,
      res.token,
      env.MAPBOX_SERVER_TOKEN,
      env.TWITCH_EXT_SECRET,
      env.TWITCH_EVENTSUB_SECRET,
      env.TWITCH_CLIENT_SECRET,
      env.ADMIN_SESSION_SECRET,
      env.STREAMER_DEVICE_SECRET,
    ].filter((s) => s.length > 0)) {
      expect(text).not.toContain(secret);
    }
    // JWTs, Mapbox tokens, OAuth strings.
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/);
    expect(text).not.toMatch(/\b[ps]k\.[A-Za-z0-9_-]{8,}/);
    expect(text).not.toMatch(/oauth:/i);

    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          keys.push(k);
          walk(v);
        }
      }
    };
    walk(res.body);
    expect(keys.filter((k) => /token|secret|password|refresh|credential/i.test(k))).toEqual([]);
  });

  it('no usable GPS: not ready; the review demo makes it ready again', async () => {
    const { clearGps } = await import('../src/domain/gps.js');
    await clearGps(TEST_CHANNEL);

    const missing = (await status()).body;
    expect(missing.gps).toMatchObject({ status: 'missing', ageMs: null, source: 'live' });
    expect(missing.ready).toBe(false);

    setDemo(true);
    const demo = (await status()).body;
    expect(demo.reviewDemo).toEqual({ active: true });
    expect(demo.gps).toMatchObject({ status: 'ok', ageMs: 0, accuracy: 10, source: 'review_demo' });
    expect(demo.ready).toBe(true);
  });

  it('a fix too inaccurate to price from reads as stale, and is not ready', async () => {
    await pushGps(PATONG.lat, PATONG.lng, 500);
    const body = (await status()).body;
    expect(body.gps).toMatchObject({ status: 'stale', accuracy: 500, source: 'live' });
    expect(body.ready).toBe(false);
  });

  it('no public Mapbox token: not ready', async () => {
    setEnv({ MAPBOX_PUBLIC_TOKEN: '' });
    const body = (await status()).body;
    expect(body.mapbox).toEqual({ ready: false });
    expect(body.ready).toBe(false);
  });

  it('exchange reward disabled on Twitch, or never created: not ready', async () => {
    const { getExchangeReward } = await import('../src/twitch/exchangeReward.js');
    const { updateCustomReward } = await import('../src/twitch/helix.js');
    const stored = await getExchangeReward(TEST_CHANNEL);
    await updateCustomReward(TEST_CHANNEL, stored!.twitchRewardId, { isEnabled: false });

    const disabled = (await status()).body;
    expect(disabled.economy.exchangeReward).toEqual({
      ready: false,
      title: 'Обмен ETH на GTA DOLLAR',
      cost: 500,
    });
    expect(disabled.ready).toBe(false);

    const { query } = await import('../src/db/pool.js');
    await query('DELETE FROM gta_exchange_rewards WHERE channel_id = $1', [TEST_CHANNEL]);
    const absent = (await status()).body;
    expect(absent.economy.exchangeReward).toEqual({ ready: false, title: null, cost: null });
    expect(absent.ready).toBe(false);
  });

  it('no redemption.add subscription: not ready', async () => {
    const { deleteEventSubSubscription, listEventSubSubscriptions } = await import(
      '../src/twitch/helix.js'
    );
    const { REDEMPTION_ADD } = await import('../src/twitch/eventsub.js');
    for (const sub of await listEventSubSubscriptions()) {
      if (sub.type === REDEMPTION_ADD) await deleteEventSubSubscription(sub.id);
    }
    const body = (await status()).body;
    expect(body.eventsub).toEqual({ ready: false, count: 0 });
    expect(body.twitch.eventsubCount).toBe(1);
    expect(body.ready).toBe(false);
  });

  it('Twitch cannot be asked about EventSub: -1, and not ready', async () => {
    const { failNextDevHelix } = await import('../src/twitch/devHelix.js');
    failNextDevHelix('GET', '/eventsub/subscriptions', 503);
    const body = (await status()).body;
    expect(body.eventsub).toEqual({ ready: false, count: -1 });
    expect(body.twitch.eventsubCount).toBe(-1);
    expect(body.ready).toBe(false);
  });

  it('broadcaster not connected: no login, not ready', async () => {
    const { query } = await import('../src/db/pool.js');
    await query('DELETE FROM broadcaster_oauth WHERE channel_id = $1', [TEST_CHANNEL]);
    const body = (await status()).body;
    expect(body.twitch).toMatchObject({ connected: false, login: null, scopes: [] });
    expect(body.ready).toBe(false);
  });
});
