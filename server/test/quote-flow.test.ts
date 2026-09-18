import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JUNGCEYLON,
  PATONG,
  TEST_CHANNEL,
  pushGps,
  resetDatabase,
  seedRewardPool,
  servicesAvailable,
} from './helpers/services.js';
import { setPaymentModeOverride } from '../src/domain/paymentMode.js';
import type { WalkingRoute } from '../src/domain/types.js';

/**
 * Mapbox is the one dependency these tests do not exercise for real: routes
 * cost money and the point here is our own gating, not Mapbox's accuracy.
 * Everything else — Postgres, Redis, the reward pool, the state machine — runs
 * against the real thing.
 */
const route: { next: WalkingRoute | Error } = {
  next: {
    distanceMeters: 1370,
    durationSeconds: 1080,
    geometry: 'ynq}@_k~kEa@qA',
    snappedDestination: JUNGCEYLON,
    snapDistanceMeters: 4,
  },
};

vi.mock('../src/maps/mapbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/maps/mapbox.js')>();
  return {
    ...actual,
    getWalkingRoute: vi.fn(async () => {
      if (route.next instanceof Error) throw route.next;
      return route.next;
    }),
    searchPlaces: vi.fn(async () => []),
  };
});

const online = await servicesAvailable();
const d = online ? describe : describe.skip;

// These suites exercise the legacy per-quote slot rewards, which only exist in
// channel_points_reward mode. The mode is pinned here rather than assumed, so a
// change of default cannot quietly turn them into tests of something else; the
// GTA$ flow has its own suite (gta-dollar.test.ts).
beforeAll(() => setPaymentModeOverride('channel_points_reward'));
afterAll(() => setPaymentModeOverride(null));

const VIEWER = '100000001';

function resetRoute(): void {
  route.next = {
    distanceMeters: 1370,
    durationSeconds: 1080,
    geometry: 'ynq}@_k~kEa@qA',
    snappedDestination: JUNGCEYLON,
    snapDistanceMeters: 4,
  };
}

d('quote flow', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedRewardPool(3);
    await pushGps(PATONG.lat, PATONG.lng);
    resetRoute();
  });


  it('prices a route with the server formula and freezes it on the quote', async () => {
    const { createViewerQuote } = await import('../src/domain/waypointFlow.js');
    const quote = await createViewerQuote({
      channelId: TEST_CHANNEL,
      twitchUserId: VIEWER,
      twitchUserName: 'Viewer',
      destination: JUNGCEYLON,
      destinationName: 'Jungceylon Shopping Center',
      destinationCategory: 'mall',
    });

    // 1370 m -> 14 * 100 + 100 base = 1500, already a multiple of 50
    expect(quote.cost).toBe(1500);
    expect(quote.distanceMeters).toBe(1370);
    expect(quote.status).toBe('QUOTED');
    expect(quote.destinationName).toBe('Jungceylon Shopping Center');
    expect(quote.rewardTitle).toBeNull();

    // Moving the streamer must not change an issued quote.
    await pushGps(PATONG.lat + 0.002, PATONG.lng);
    const { getQuote } = await import('../src/domain/quotes.js');
    expect((await getQuote(quote.quoteId))?.channelPointsCost).toBe(1500);
  });

  it('rejects a destination outside Phuket', async () => {
    const { createViewerQuote } = await import('../src/domain/waypointFlow.js');
    await expect(
      createViewerQuote({
        channelId: TEST_CHANNEL,
        twitchUserId: VIEWER,
        twitchUserName: null,
        destination: { lat: 13.7563, lng: 100.5018 },
      }),
    ).rejects.toMatchObject({ code: 'out_of_bounds' });
  });

  it('rejects a destination inside a restricted zone', async () => {
    const { saveSettings } = await import('../src/domain/settings.js');
    await saveSettings(TEST_CHANNEL, {
      restrictedZones: [
        {
          id: 'home',
          name: 'Дом',
          polygon: [
            [98.29, 7.89],
            [98.3, 7.89],
            [98.3, 7.9],
            [98.29, 7.9],
          ],
        },
      ],
    });

    const { createViewerQuote } = await import('../src/domain/waypointFlow.js');
    await expect(
      createViewerQuote({
        channelId: TEST_CHANNEL,
        twitchUserId: VIEWER,
        twitchUserName: null,
        destination: { lat: 7.895, lng: 98.295 },
      }),
    ).rejects.toMatchObject({ code: 'restricted_zone' });
  });

  it('rejects a point with no pedestrian route (a tap in the sea)', async () => {
    const { NoWalkingRouteError } = await import('../src/maps/mapbox.js');
    route.next = new NoWalkingRouteError();

    const { createViewerQuote } = await import('../src/domain/waypointFlow.js');
    await expect(
      createViewerQuote({
        channelId: TEST_CHANNEL,
        twitchUserId: VIEWER,
        twitchUserName: null,
        // Just offshore from Patong beach: close enough to pass the distance
        // pre-check, so the router is what rejects it.
        destination: { lat: 7.8961, lng: 98.283 },
      }),
    ).rejects.toMatchObject({ code: 'no_walking_route' });
  });

  it('rejects a point the router had to snap too far', async () => {
    route.next = {
      distanceMeters: 800,
      durationSeconds: 600,
      geometry: 'ynq}@_k~kEa@qA',
      snappedDestination: JUNGCEYLON,
      // Far offshore: the nearest walkable way is 900 m away.
      snapDistanceMeters: 900,
    };

    const { createViewerQuote } = await import('../src/domain/waypointFlow.js');
    await expect(
      createViewerQuote({
        channelId: TEST_CHANNEL,
        twitchUserId: VIEWER,
        twitchUserName: null,
        destination: { lat: 7.894, lng: 98.2905 },
      }),
    ).rejects.toMatchObject({ code: 'too_far_from_walkable' });
  });

  it('rejects a walking distance over the configured maximum', async () => {
    const { saveSettings } = await import('../src/domain/settings.js');
    await saveSettings(TEST_CHANNEL, { maxWalkingDistanceMeters: 1000 });

    const { createViewerQuote } = await import('../src/domain/waypointFlow.js');
    await expect(
      createViewerQuote({
        channelId: TEST_CHANNEL,
        twitchUserId: VIEWER,
        twitchUserName: null,
        destination: JUNGCEYLON,
      }),
    ).rejects.toMatchObject({ code: 'too_far' });
  });

  it('refuses to quote when GPS is stale', async () => {
    const { redis } = await import('../src/redis/client.js');
    const { K } = await import('../src/redis/keys.js');

    // A fix that arrived a minute ago, well past the 15 s timeout.
    await redis.set(
      K.gpsLatest(TEST_CHANNEL),
      JSON.stringify({
        lat: PATONG.lat,
        lng: PATONG.lng,
        accuracy: 5,
        heading: null,
        speed: null,
        timestamp: Date.now() - 60_000,
        receivedAt: Date.now() - 60_000,
      }),
    );

    const { getGpsState } = await import('../src/domain/gps.js');
    const { getSettings } = await import('../src/domain/settings.js');
    const state = await getGpsState(TEST_CHANNEL, await getSettings(TEST_CHANNEL));
    expect(state.status).toBe('stale');

    const { createViewerQuote } = await import('../src/domain/waypointFlow.js');
    await expect(
      createViewerQuote({
        channelId: TEST_CHANNEL,
        twitchUserId: VIEWER,
        twitchUserName: null,
        destination: JUNGCEYLON,
      }),
    ).rejects.toMatchObject({ code: 'gps_unavailable' });
  });

  it('refuses to quote when there is no GPS at all', async () => {
    const { clearGps } = await import('../src/domain/gps.js');
    await clearGps(TEST_CHANNEL);

    const { createViewerQuote } = await import('../src/domain/waypointFlow.js');
    await expect(
      createViewerQuote({
        channelId: TEST_CHANNEL,
        twitchUserId: VIEWER,
        twitchUserName: null,
        destination: JUNGCEYLON,
      }),
    ).rejects.toMatchObject({ code: 'gps_unavailable' });
  });

  it('refuses to quote when the GPS fix is too imprecise', async () => {
    await pushGps(PATONG.lat, PATONG.lng, 500);
    const { createViewerQuote } = await import('../src/domain/waypointFlow.js');
    await expect(
      createViewerQuote({
        channelId: TEST_CHANNEL,
        twitchUserId: VIEWER,
        twitchUserName: null,
        destination: JUNGCEYLON,
      }),
    ).rejects.toMatchObject({ code: 'gps_unavailable' });
  });

  it('refuses to quote while waypoints are closed', async () => {
    const { setWaypointsOpen } = await import('../src/domain/settings.js');
    await setWaypointsOpen(TEST_CHANNEL, false);

    const { createViewerQuote } = await import('../src/domain/waypointFlow.js');
    await expect(
      createViewerQuote({
        channelId: TEST_CHANNEL,
        twitchUserId: VIEWER,
        twitchUserName: null,
        destination: JUNGCEYLON,
      }),
    ).rejects.toMatchObject({ code: 'waypoints_closed' });
  });
});

d('quote expiration', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedRewardPool(3);
    await pushGps(PATONG.lat, PATONG.lng);
    resetRoute();
  });


  it('expires a quote past its deadline and refuses to confirm it', async () => {
    const { saveSettings } = await import('../src/domain/settings.js');
    await saveSettings(TEST_CHANNEL, { quoteTtlSeconds: 15 });

    const { createViewerQuote, confirmViewerQuote, expireStaleQuotes } = await import(
      '../src/domain/waypointFlow.js'
    );
    const quote = await createViewerQuote({
      channelId: TEST_CHANNEL,
      twitchUserId: VIEWER,
      twitchUserName: null,
      destination: JUNGCEYLON,
    });
    expect(quote.expiresAt).toBeGreaterThan(Date.now());

    const { query } = await import('../src/db/pool.js');
    await query(
      `UPDATE waypoint_quotes SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [quote.quoteId],
    );

    await expect(
      confirmViewerQuote(TEST_CHANNEL, VIEWER, quote.quoteId),
    ).rejects.toMatchObject({ code: 'quote_expired' });

    const swept = await expireStaleQuotes(TEST_CHANNEL);
    expect(swept).toBeGreaterThanOrEqual(0);

    const { getQuote } = await import('../src/domain/quotes.js');
    expect((await getQuote(quote.quoteId))?.status).toBe('EXPIRED');
  });

  it('returns the reward slot when a confirmed quote expires unpaid', async () => {
    const { createViewerQuote, confirmViewerQuote, expireStaleQuotes } = await import(
      '../src/domain/waypointFlow.js'
    );
    const { countFreeSlots } = await import('../src/domain/slots.js');

    const quote = await createViewerQuote({
      channelId: TEST_CHANNEL,
      twitchUserId: VIEWER,
      twitchUserName: null,
      destination: JUNGCEYLON,
    });
    const confirmed = await confirmViewerQuote(TEST_CHANNEL, VIEWER, quote.quoteId);
    expect(confirmed.status).toBe('AWAITING_REDEMPTION');
    expect(confirmed.rewardTitle).toBe(`WAYPOINT • ${confirmed.code}`);
    expect((await countFreeSlots(TEST_CHANNEL, 3)).free).toBe(2);

    const { query } = await import('../src/db/pool.js');
    await query(
      `UPDATE waypoint_quotes SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [quote.quoteId],
    );

    expect(await expireStaleQuotes(TEST_CHANNEL)).toBe(1);
    expect((await countFreeSlots(TEST_CHANNEL, 3)).free).toBe(3);

    const { getQuote } = await import('../src/domain/quotes.js');
    expect((await getQuote(quote.quoteId))?.status).toBe('EXPIRED');
  });

  it('is idempotent when the same quote is confirmed twice', async () => {
    const { createViewerQuote, confirmViewerQuote } = await import('../src/domain/waypointFlow.js');
    const { countFreeSlots } = await import('../src/domain/slots.js');

    const quote = await createViewerQuote({
      channelId: TEST_CHANNEL,
      twitchUserId: VIEWER,
      twitchUserName: null,
      destination: JUNGCEYLON,
    });
    const first = await confirmViewerQuote(TEST_CHANNEL, VIEWER, quote.quoteId);
    const second = await confirmViewerQuote(TEST_CHANNEL, VIEWER, quote.quoteId);

    expect(second.code).toBe(first.code);
    // A double tap must not eat a second slot.
    expect((await countFreeSlots(TEST_CHANNEL, 3)).free).toBe(2);
  });

  it('refuses to let one viewer confirm another viewer’s quote', async () => {
    const { createViewerQuote, confirmViewerQuote } = await import('../src/domain/waypointFlow.js');
    const quote = await createViewerQuote({
      channelId: TEST_CHANNEL,
      twitchUserId: VIEWER,
      twitchUserName: null,
      destination: JUNGCEYLON,
    });
    await expect(
      confirmViewerQuote(TEST_CHANNEL, '100000999', quote.quoteId),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
