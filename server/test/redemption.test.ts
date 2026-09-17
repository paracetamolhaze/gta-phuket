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
import type { RedemptionEvent, WalkingRoute } from '../src/domain/types.js';

const route: { next: WalkingRoute } = {
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
  return { ...actual, getWalkingRoute: vi.fn(async () => route.next), searchPlaces: vi.fn(async () => []) };
});

/** Records every FULFILLED/CANCELED the system sends to Twitch. */
const statusCalls: { redemptionId: string; status: string }[] = [];

vi.mock('../src/twitch/helix.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/twitch/helix.js')>();
  return {
    ...actual,
    updateRedemptionStatus: vi.fn(
      async (channelId: string, rewardId: string, redemptionId: string, status: string) => {
        statusCalls.push({ redemptionId, status });
        return actual.updateRedemptionStatus(
          channelId,
          rewardId,
          redemptionId,
          status as 'FULFILLED' | 'CANCELED',
        );
      },
    ),
  };
});

const online = await servicesAvailable();
const d = online ? describe : describe.skip;

const BUYER = '100000001';
const STRANGER = '100000777';

async function quoteAndConfirm(userId = BUYER): Promise<{
  quoteId: string;
  code: string;
  cost: number;
  rewardId: string;
}> {
  const { createViewerQuote, confirmViewerQuote } = await import('../src/domain/waypointFlow.js');
  const { getQuote } = await import('../src/domain/quotes.js');
  const { listSlots } = await import('../src/twitch/rewards.js');

  const quote = await createViewerQuote({
    channelId: TEST_CHANNEL,
    twitchUserId: userId,
    twitchUserName: `Viewer ${userId}`,
    destination: JUNGCEYLON,
    destinationName: 'Jungceylon Shopping Center',
    destinationCategory: 'mall',
  });
  const confirmed = await confirmViewerQuote(TEST_CHANNEL, userId, quote.quoteId);

  const stored = await getQuote(quote.quoteId);
  const slot = (await listSlots(TEST_CHANNEL)).find((s) => s.id === stored?.slotId);
  if (!slot) throw new Error('slot was not reserved');

  return { quoteId: quote.quoteId, code: confirmed.code, cost: confirmed.cost, rewardId: slot.twitchRewardId };
}

function redemption(overrides: Partial<RedemptionEvent> = {}): RedemptionEvent {
  return {
    eventId: randomUUID(),
    redemptionId: randomUUID(),
    broadcasterUserId: TEST_CHANNEL,
    userId: BUYER,
    userLogin: 'buyer',
    userName: 'Buyer',
    rewardId: 'unset',
    rewardTitle: 'WAYPOINT',
    rewardCost: 1500,
    userInput: '',
    status: 'unfulfilled',
    redeemedAt: new Date().toISOString(),
    ...overrides,
  };
}

d('redemption handling', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedRewardPool(3);
    await pushGps(PATONG.lat, PATONG.lng);
    statusCalls.length = 0;
  });


  it('activates the waypoint when the right viewer pays', async () => {
    const { handleRedemption } = await import('../src/twitch/eventsub.js');
    const { getActiveWaypoint } = await import('../src/domain/waypoints.js');
    const { getQuote } = await import('../src/domain/quotes.js');
    const { countFreeSlots } = await import('../src/domain/slots.js');

    const q = await quoteAndConfirm();
    const outcome = await handleRedemption(
      redemption({ rewardId: q.rewardId, rewardCost: q.cost, userId: BUYER }),
    );

    expect(outcome.result).toBe('activated');

    const waypoint = await getActiveWaypoint(TEST_CHANNEL);
    expect(waypoint).not.toBeNull();
    expect(waypoint?.destinationName).toBe('Jungceylon Shopping Center');
    expect(waypoint?.channelPointsPaid).toBe(q.cost);
    expect(waypoint?.twitchUserId).toBe(BUYER);

    expect((await getQuote(q.quoteId))?.status).toBe('PAID');
    expect(statusCalls).toContainEqual({ redemptionId: expect.any(String), status: 'FULFILLED' });

    // The consumed slot goes straight back into the pool.
    expect((await countFreeSlots(TEST_CHANNEL, 3)).free).toBe(3);
  });

  it('refunds when the wrong viewer redeems the reward', async () => {
    const { handleRedemption } = await import('../src/twitch/eventsub.js');
    const { getActiveWaypoint } = await import('../src/domain/waypoints.js');
    const { query } = await import('../src/db/pool.js');

    const q = await quoteAndConfirm(BUYER);
    const outcome = await handleRedemption(
      redemption({ rewardId: q.rewardId, rewardCost: q.cost, userId: STRANGER }),
    );

    expect(outcome.result).toBe('refunded');
    expect(outcome).toMatchObject({ reason: expect.stringContaining('another viewer') });
    expect(await getActiveWaypoint(TEST_CHANNEL)).toBeNull();
    expect(statusCalls.at(-1)?.status).toBe('CANCELED');

    const { rows } = await query<{ resolution: string; twitch_user_id: string }>(
      'SELECT resolution, twitch_user_id FROM twitch_redemptions',
    );
    expect(rows[0]?.resolution).toBe('CANCELED');
    expect(rows[0]?.twitch_user_id).toBe(STRANGER);
  });

  it('refunds a redemption that arrives after the quote expired', async () => {
    const { handleRedemption } = await import('../src/twitch/eventsub.js');
    const { query } = await import('../src/db/pool.js');

    const q = await quoteAndConfirm();
    await query(
      `UPDATE waypoint_quotes SET expires_at = now() - interval '5 seconds' WHERE id = $1`,
      [q.quoteId],
    );

    const outcome = await handleRedemption(
      redemption({ rewardId: q.rewardId, rewardCost: q.cost, userId: BUYER }),
    );
    expect(outcome).toMatchObject({ result: 'refunded', reason: expect.stringContaining('expired') });
    expect(statusCalls.at(-1)?.status).toBe('CANCELED');
  });

  it('refunds when the redeemed cost does not match the quote', async () => {
    const { handleRedemption } = await import('../src/twitch/eventsub.js');
    const q = await quoteAndConfirm();
    const outcome = await handleRedemption(
      redemption({ rewardId: q.rewardId, rewardCost: q.cost - 50, userId: BUYER }),
    );
    expect(outcome).toMatchObject({ result: 'refunded', reason: expect.stringContaining('cost') });
  });

  it('ignores a redemption of a reward that is not in the pool', async () => {
    const { handleRedemption } = await import('../src/twitch/eventsub.js');
    const outcome = await handleRedemption(redemption({ rewardId: 'someone-elses-reward' }));
    expect(outcome.result).toBe('ignored');
    // Never refund what we did not sell.
    expect(statusCalls).toHaveLength(0);
  });

  it('handles a second delivery of the same redemption exactly once', async () => {
    const { handleRedemption } = await import('../src/twitch/eventsub.js');
    const { query } = await import('../src/db/pool.js');

    const q = await quoteAndConfirm();
    const event = redemption({ rewardId: q.rewardId, rewardCost: q.cost, userId: BUYER });

    const first = await handleRedemption(event);
    const second = await handleRedemption(event);

    expect(first.result).toBe('activated');
    expect(second.result).toBe('duplicate');

    const { rows } = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM waypoints WHERE channel_id = $1`,
      [TEST_CHANNEL],
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('refunds a second, different redemption while a waypoint is already active', async () => {
    const { handleRedemption } = await import('../src/twitch/eventsub.js');
    const { query } = await import('../src/db/pool.js');

    const first = await quoteAndConfirm(BUYER);
    await handleRedemption(redemption({ rewardId: first.rewardId, rewardCost: first.cost, userId: BUYER }));

    // A second viewer's reward is released the moment the first one wins, so
    // this stands in for a redemption that was already in flight.
    const outcome = await handleRedemption(
      redemption({ rewardId: first.rewardId, rewardCost: first.cost, userId: STRANGER }),
    );
    expect(outcome.result).toBe('refunded');

    const { rows } = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM waypoints WHERE channel_id = $1 AND status = 'ACTIVE'`,
      [TEST_CHANNEL],
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('blocks a new quote while a waypoint is active, and reopens after COMPLETE', async () => {
    const { handleRedemption } = await import('../src/twitch/eventsub.js');
    const { createViewerQuote } = await import('../src/domain/waypointFlow.js');
    const { completeWaypoint, getActiveWaypoint } = await import('../src/domain/waypoints.js');

    const q = await quoteAndConfirm();
    await handleRedemption(redemption({ rewardId: q.rewardId, rewardCost: q.cost, userId: BUYER }));

    await expect(
      createViewerQuote({
        channelId: TEST_CHANNEL,
        twitchUserId: STRANGER,
        twitchUserName: null,
        destination: JUNGCEYLON,
      }),
    ).rejects.toMatchObject({ code: 'waypoint_active' });

    const completed = await completeWaypoint(TEST_CHANNEL);
    expect(completed?.status).toBe('COMPLETED');
    expect(await getActiveWaypoint(TEST_CHANNEL)).toBeNull();

    const next = await createViewerQuote({
      channelId: TEST_CHANNEL,
      twitchUserId: STRANGER,
      twitchUserName: null,
      destination: JUNGCEYLON,
    });
    expect(next.status).toBe('QUOTED');
  });

  it('cancels every other pending quote when one viewer pays first', async () => {
    const { handleRedemption } = await import('../src/twitch/eventsub.js');
    const { getQuote } = await import('../src/domain/quotes.js');
    const { countFreeSlots } = await import('../src/domain/slots.js');

    const winner = await quoteAndConfirm(BUYER);
    const loser = await quoteAndConfirm(STRANGER);
    expect((await countFreeSlots(TEST_CHANNEL, 3)).free).toBe(1);

    await handleRedemption(
      redemption({ rewardId: winner.rewardId, rewardCost: winner.cost, userId: BUYER }),
    );

    expect((await getQuote(loser.quoteId))?.status).toBe('CANCELED');
    expect((await countFreeSlots(TEST_CHANNEL, 3)).free).toBe(3);
  });
});

d('EventSub message deduplication', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedRewardPool(2);
  });


  it('claims a message id exactly once', async () => {
    const { claimMessage } = await import('../src/twitch/eventsub.js');
    const id = randomUUID();

    expect(await claimMessage(id, 'test.type', TEST_CHANNEL, { a: 1 })).toBe(true);
    expect(await claimMessage(id, 'test.type', TEST_CHANNEL, { a: 1 })).toBe(false);
    expect(await claimMessage(randomUUID(), 'test.type', TEST_CHANNEL, { a: 1 })).toBe(true);
  });

  it('still rejects a redelivery after Redis is flushed', async () => {
    const { claimMessage } = await import('../src/twitch/eventsub.js');
    const { redis } = await import('../src/redis/client.js');
    const id = randomUUID();

    expect(await claimMessage(id, 'test.type', TEST_CHANNEL, {})).toBe(true);
    await redis.flushdb();
    // The durable table is what makes this survive a cache wipe.
    expect(await claimMessage(id, 'test.type', TEST_CHANNEL, {})).toBe(false);
  });
});
