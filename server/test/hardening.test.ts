import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JUNGCEYLON,
  PATONG,
  TEST_CHANNEL,
  pushGps,
  resetDatabase,
  seedRewardPool,
  servicesAvailable,
} from './helpers/services.js';
import { sanitizeRouteGeometry } from '../src/domain/privacy.js';
import { decodePolyline6, encodePolyline6, haversineMeters, pathLengthMeters } from '../src/domain/geo.js';
import { isObsToken, obsToken } from '../src/http/auth.js';
import { DEFAULT_SETTINGS, type ChannelSettings, type RedemptionEvent, type WalkingRoute } from '../src/domain/types.js';
import { setRealtimeTransport } from '../src/realtime/bus.js';

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

// A ~700 m line heading south-east out of Patong.
function sampleRoute(): string {
  const points: [number, number][] = [];
  for (let i = 0; i < 40; i += 1) {
    points.push([98.2958 + i * 0.0002, 7.8961 - i * 0.00015]);
  }
  return encodePolyline6(points);
}

function settings(overrides: Partial<ChannelSettings>): ChannelSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe('viewer route privacy', () => {
  it('is a no-op with the default settings', () => {
    const geometry = sampleRoute();
    expect(sanitizeRouteGeometry(geometry, DEFAULT_SETTINGS)).toBe(geometry);
  });

  it('trims the head of the route by the delay window', () => {
    const geometry = sampleRoute();
    const original = decodePolyline6(geometry);
    const trimmed = decodePolyline6(
      sanitizeRouteGeometry(geometry, settings({ viewerLocationDelaySeconds: 60 }))!,
    );

    // The exact origin must no longer be the first point a viewer sees.
    const originalStart = { lat: original[0]![1], lng: original[0]![0] };
    const trimmedStart = { lat: trimmed[0]![1], lng: trimmed[0]![0] };
    expect(haversineMeters(originalStart, trimmedStart)).toBeGreaterThan(50);

    // ...but the destination end is untouched, or the map would be useless.
    const originalEnd = original[original.length - 1]!;
    const trimmedEnd = trimmed[trimmed.length - 1]!;
    expect(trimmedEnd[0]).toBeCloseTo(originalEnd[0], 6);
    expect(trimmedEnd[1]).toBeCloseTo(originalEnd[1], 6);
  });

  it('never trims the route away entirely', () => {
    const short = encodePolyline6([
      [98.2958, 7.8961],
      [98.2962, 7.8958],
    ]);
    const out = sanitizeRouteGeometry(short, settings({ viewerLocationDelaySeconds: 600 }));
    expect(decodePolyline6(out!).length).toBeGreaterThanOrEqual(2);
  });

  it('drops coordinate precision', () => {
    const geometry = sampleRoute();
    const coarse = decodePolyline6(
      sanitizeRouteGeometry(geometry, settings({ viewerLocationPrecision: 3 }))!,
    );
    for (const [lng, lat] of coarse) {
      expect(Math.abs(lng * 1000 - Math.round(lng * 1000))).toBeLessThan(1e-6);
      expect(Math.abs(lat * 1000 - Math.round(lat * 1000))).toBeLessThan(1e-6);
    }
    // The shape survives: a rounded route still goes roughly the same distance.
    expect(pathLengthMeters(coarse)).toBeGreaterThan(pathLengthMeters(decodePolyline6(geometry)) * 0.7);
  });

  it('handles a missing geometry', () => {
    expect(sanitizeRouteGeometry(null, settings({ viewerLocationDelaySeconds: 30 }))).toBeNull();
  });
});

describe('OBS source token', () => {
  it('accepts only the derived token', () => {
    const token = obsToken();
    expect(token).toHaveLength(32);
    expect(isObsToken(token)).toBe(true);
    expect(isObsToken('')).toBe(false);
    expect(isObsToken(undefined)).toBe(false);
    expect(isObsToken(`${token}x`)).toBe(false);
    expect(isObsToken(token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a'))).toBe(false);
  });
});

describe('production secret guard', () => {
  it('refuses to boot with the placeholder secrets', async () => {
    const { reloadEnv } = await import('../src/env.js');
    const saved = { ...process.env };
    try {
      process.env.NODE_ENV = 'production';
      process.env.ADMIN_SESSION_SECRET = 'change-me-admin-secret';
      expect(() => reloadEnv()).toThrowError(/placeholder or short secrets/i);

      process.env.ADMIN_SESSION_SECRET = 'short';
      expect(() => reloadEnv()).toThrowError(/ADMIN_SESSION_SECRET/);

      process.env.ADMIN_SESSION_SECRET = 'a-properly-long-random-admin-secret';
      process.env.STREAMER_DEVICE_SECRET = 'a-properly-long-pairing-code';
      process.env.TWITCH_EVENTSUB_SECRET = 'a-properly-long-eventsub-secret';
      expect(() => reloadEnv()).not.toThrow();
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
      reloadEnv();
    }
  });

  it('forces dev endpoints off in production', async () => {
    const { reloadEnv, env } = await import('../src/env.js');
    const saved = { ...process.env };
    try {
      process.env.NODE_ENV = 'production';
      process.env.DEV_MODE = 'true';
      process.env.ADMIN_SESSION_SECRET = 'a-properly-long-random-admin-secret';
      process.env.STREAMER_DEVICE_SECRET = 'a-properly-long-pairing-code';
      process.env.TWITCH_EVENTSUB_SECRET = 'a-properly-long-eventsub-secret';
      reloadEnv();
      expect(env.DEV_MODE).toBe(true);
      expect(env.devModeEnabled).toBe(false);
    } finally {
      Object.assign(process.env, saved);
      reloadEnv();
    }
  });
});

d('a stranger cannot grief a pending waypoint', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedRewardPool(3);
    await pushGps(PATONG.lat, PATONG.lng);
  });

  it('refunds the stranger but leaves the buyer’s reward standing', async () => {
    const { createViewerQuote, confirmViewerQuote } = await import('../src/domain/waypointFlow.js');
    const { handleRedemption } = await import('../src/twitch/eventsub.js');
    const { getQuote } = await import('../src/domain/quotes.js');
    const { listSlots } = await import('../src/twitch/rewards.js');
    const { countFreeSlots } = await import('../src/domain/slots.js');

    const buyer = '100000001';
    const stranger = '100000777';

    const quote = await createViewerQuote({
      channelId: TEST_CHANNEL,
      twitchUserId: buyer,
      twitchUserName: 'Buyer',
      destination: JUNGCEYLON,
      destinationName: 'Jungceylon',
    });
    const confirmed = await confirmViewerQuote(TEST_CHANNEL, buyer, quote.quoteId);
    const stored = await getQuote(quote.quoteId);
    const slot = (await listSlots(TEST_CHANNEL)).find((s) => s.id === stored?.slotId);
    expect(slot).toBeDefined();

    const event: RedemptionEvent = {
      eventId: randomUUID(),
      redemptionId: randomUUID(),
      broadcasterUserId: TEST_CHANNEL,
      userId: stranger,
      userLogin: 'stranger',
      userName: 'Stranger',
      rewardId: slot!.twitchRewardId,
      rewardTitle: confirmed.rewardTitle ?? '',
      rewardCost: confirmed.cost,
      userInput: '',
      status: 'unfulfilled',
      redeemedAt: new Date().toISOString(),
    };

    const outcome = await handleRedemption(event);
    expect(outcome.result).toBe('refunded');

    // The victim's quote and slot must survive, or anyone could cancel a
    // pending waypoint for free by redeeming and taking the refund.
    expect((await getQuote(quote.quoteId))?.status).toBe('AWAITING_REDEMPTION');
    const after = (await listSlots(TEST_CHANNEL)).find((s) => s.id === slot!.id);
    expect(after?.status).toBe('RESERVED');
    expect((await countFreeSlots(TEST_CHANNEL, 3)).free).toBe(2);

    // And the real buyer can still pay.
    const paid = await handleRedemption({
      ...event,
      redemptionId: randomUUID(),
      userId: buyer,
    });
    expect(paid.result).toBe('activated');
  });
});

d('one live quote per viewer', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedRewardPool(5);
    await pushGps(PATONG.lat, PATONG.lng);
  });

  it('cannot be bypassed by firing quote requests in parallel', async () => {
    const { createViewerQuote } = await import('../src/domain/waypointFlow.js');
    const { query } = await import('../src/db/pool.js');

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        createViewerQuote({
          channelId: TEST_CHANNEL,
          twitchUserId: '100000001',
          twitchUserName: null,
          destination: JUNGCEYLON,
          destinationName: 'Jungceylon',
        }),
      ),
    );
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);

    const { rows } = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM waypoint_quotes
        WHERE channel_id = $1 AND status IN ('QUOTED', 'AWAITING_REDEMPTION')`,
      [TEST_CHANNEL],
    );
    // One viewer, one live quote, no matter how hard they tap.
    expect(rows[0]?.count).toBe(1);
  });
});

d('realtime event separation', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedRewardPool(3);
    await pushGps(PATONG.lat, PATONG.lng);
  });

  it('a dying quote never emits waypoint:canceled', async () => {
    const events: { event: string; payload: unknown }[] = [];
    setRealtimeTransport({
      emit(_channelId, event, payload) {
        events.push({ event, payload });
      },
    });

    try {
      const { createViewerQuote, cancelViewerQuote, expireStaleQuotes } = await import(
        '../src/domain/waypointFlow.js'
      );
      const { query } = await import('../src/db/pool.js');

      const a = await createViewerQuote({
        channelId: TEST_CHANNEL,
        twitchUserId: '100000001',
        twitchUserName: null,
        destination: JUNGCEYLON,
      });
      await cancelViewerQuote(TEST_CHANNEL, '100000001', a.quoteId);

      const b = await createViewerQuote({
        channelId: TEST_CHANNEL,
        twitchUserId: '100000002',
        twitchUserName: null,
        destination: JUNGCEYLON,
      });
      await query(
        `UPDATE waypoint_quotes SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [b.quoteId],
      );
      await expireStaleQuotes(TEST_CHANNEL);

      // Clearing a quote must not blank the OBS HUD, which listens for
      // waypoint:canceled and has no way of telling the two apart otherwise.
      expect(events.filter((e) => e.event === 'waypoint:canceled')).toHaveLength(0);
      expect(events.filter((e) => e.event === 'quote:canceled').length).toBeGreaterThanOrEqual(2);
    } finally {
      setRealtimeTransport(null);
    }
  });
});

d('EventSub retry after a handler failure', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('is reprocessed once the claim is released', async () => {
    const { claimMessage } = await import('../src/twitch/eventsub.js');
    const { query } = await import('../src/db/pool.js');
    const { redis } = await import('../src/redis/client.js');
    const { K } = await import('../src/redis/keys.js');

    const messageId = randomUUID();
    expect(await claimMessage(messageId, 'test.type', TEST_CHANNEL, {})).toBe(true);
    expect(await claimMessage(messageId, 'test.type', TEST_CHANNEL, {})).toBe(false);

    // What the route does when the handler throws: drop BOTH layers, so
    // Twitch's guaranteed retry is actually processed instead of being
    // mistaken for a duplicate and silently dropped.
    await redis.del(K.eventSeen(messageId));
    await query('DELETE FROM eventsub_events WHERE message_id = $1', [messageId]);

    expect(await claimMessage(messageId, 'test.type', TEST_CHANNEL, {})).toBe(true);
  });
});
