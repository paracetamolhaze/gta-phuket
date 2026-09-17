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
import type { WalkingRoute } from '../src/domain/types.js';

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

d('reward slot pool', () => {
  beforeEach(async () => {
    await resetDatabase();
    await pushGps(PATONG.lat, PATONG.lng);
  });


  it('creates exactly the requested number of slots and is idempotent', async () => {
    const { ensureRewardPool, listSlots, idleTitle } = await import('../src/twitch/rewards.js');

    const first = await ensureRewardPool(TEST_CHANNEL, 4);
    expect(first.created).toBe(4);
    expect(first.total).toBe(4);

    const second = await ensureRewardPool(TEST_CHANNEL, 4);
    expect(second.created).toBe(0);

    const slots = await listSlots(TEST_CHANNEL);
    expect(slots).toHaveLength(4);
    expect(slots.map((s) => s.index)).toEqual([1, 2, 3, 4]);
    expect(slots[0]?.currentTitle).toBe(idleTitle(1));
    expect(slots.every((s) => s.status === 'FREE')).toBe(true);
    // Reward ids must be distinct or two quotes would collide on Twitch.
    expect(new Set(slots.map((s) => s.twitchRewardId)).size).toBe(4);
  });

  it('hands out each slot to exactly one caller under concurrency', async () => {
    await seedRewardPool(3);
    const { leaseSlot } = await import('../src/domain/slots.js');

    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        leaseSlot(TEST_CHANNEL, `quote-${i}`, `user-${i}`, 3).catch(() => null),
      ),
    );

    const leased = attempts.filter((s) => s !== null);
    expect(leased).toHaveLength(3);
    // No slot may be handed out twice.
    expect(new Set(leased.map((s) => s!.id)).size).toBe(3);
    expect(attempts.filter((s) => s === null)).toHaveLength(5);
  });

  it('tells the viewer to wait when the pool is exhausted', async () => {
    await seedRewardPool(1);
    const { confirmViewerQuote, createViewerQuote } = await import('../src/domain/waypointFlow.js');

    const a = await createViewerQuote({
      channelId: TEST_CHANNEL,
      twitchUserId: '100000001',
      twitchUserName: null,
      destination: JUNGCEYLON,
    });
    const b = await createViewerQuote({
      channelId: TEST_CHANNEL,
      twitchUserId: '100000002',
      twitchUserName: null,
      destination: JUNGCEYLON,
    });

    await confirmViewerQuote(TEST_CHANNEL, '100000001', a.quoteId);
    await expect(
      confirmViewerQuote(TEST_CHANNEL, '100000002', b.quoteId),
    ).rejects.toMatchObject({ code: 'no_free_slots' });

    // Nothing was charged and nothing was left half-reserved.
    const { countFreeSlots } = await import('../src/domain/slots.js');
    expect((await countFreeSlots(TEST_CHANNEL, 1)).free).toBe(0);

    const { getQuote } = await import('../src/domain/quotes.js');
    expect((await getQuote(b.quoteId))?.status).toBe('QUOTED');
  });

  it('returns a slot to the pool when its quote is cancelled', async () => {
    await seedRewardPool(2);
    const { cancelViewerQuote, confirmViewerQuote, createViewerQuote } = await import(
      '../src/domain/waypointFlow.js'
    );
    const { countFreeSlots } = await import('../src/domain/slots.js');

    const quote = await createViewerQuote({
      channelId: TEST_CHANNEL,
      twitchUserId: '100000001',
      twitchUserName: null,
      destination: JUNGCEYLON,
    });
    await confirmViewerQuote(TEST_CHANNEL, '100000001', quote.quoteId);
    expect((await countFreeSlots(TEST_CHANNEL, 2)).free).toBe(1);

    await cancelViewerQuote(TEST_CHANNEL, '100000001', quote.quoteId);
    expect((await countFreeSlots(TEST_CHANNEL, 2)).free).toBe(2);
  });

  it('puts the reward title and cost on Twitch when a slot is reserved', async () => {
    await seedRewardPool(2);
    const { confirmViewerQuote, createViewerQuote } = await import('../src/domain/waypointFlow.js');
    const { listManagedRewards } = await import('../src/twitch/helix.js');

    const quote = await createViewerQuote({
      channelId: TEST_CHANNEL,
      twitchUserId: '100000001',
      twitchUserName: null,
      destination: JUNGCEYLON,
    });
    const confirmed = await confirmViewerQuote(TEST_CHANNEL, '100000001', quote.quoteId);

    const rewards = await listManagedRewards(TEST_CHANNEL);
    const live = rewards.find((r) => r.title === `WAYPOINT • ${confirmed.code}`);
    expect(live).toBeDefined();
    expect(live?.cost).toBe(confirmed.cost);
    expect(live?.is_enabled).toBe(true);
    // Redemptions must stay in the request queue or they could never be refunded.
    expect(live?.should_redemptions_skip_request_queue).toBe(false);
  });
});

d('one active waypoint at a time', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedRewardPool(3);
    await pushGps(PATONG.lat, PATONG.lng);
  });


  it('is enforced by the database, not just by the application', async () => {
    const { withTransaction } = await import('../src/db/pool.js');
    const { insertActiveWaypoint } = await import('../src/domain/waypoints.js');
    const { createQuote } = await import('../src/domain/quotes.js');
    const { calculatePrice } = await import('../src/domain/pricing.js');
    const { DEFAULT_SETTINGS } = await import('../src/domain/types.js');

    const makeQuote = (user: string) =>
      createQuote({
        channelId: TEST_CHANNEL,
        twitchUserId: user,
        twitchUserName: null,
        origin: PATONG,
        destination: JUNGCEYLON,
        destinationName: 'Test',
        destinationCategory: null,
        distanceMeters: 1370,
        durationSeconds: 1080,
        routeGeometry: ROUTE.geometry,
        price: calculatePrice(1370, DEFAULT_SETTINGS),
        ttlSeconds: 60,
      });

    const a = await makeQuote('100000001');
    const b = await makeQuote('100000002');

    await withTransaction(async (client) => insertActiveWaypoint(client, a));

    // The partial unique index is the real arbiter.
    await expect(
      withTransaction(async (client) => insertActiveWaypoint(client, b)),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
