import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
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
import { env } from '../src/env.js';
import { setPaymentModeOverride } from '../src/domain/paymentMode.js';
import { setRealtimeTransport } from '../src/realtime/bus.js';
import { REDEMPTION_ADD, REDEMPTION_UPDATE, computeSignature } from '../src/twitch/eventsub.js';
import { extensionSecret, signDevExtensionJwt } from '../src/twitch/extJwt.js';
import type { WalkingRoute } from '../src/domain/types.js';

/**
 * The GTA DOLLAR economy (docs/GTA_DOLLAR_ECONOMY.md, section 11), end to end:
 * signed EventSub webhooks in, extension JWTs on the viewer API, real Postgres
 * and Redis underneath. Only Mapbox is faked, and Twitch is the local Helix
 * stub, so nothing here can reach a real channel.
 */

const h = vi.hoisted(() => ({
  /** Every status sent to Twitch for a redemption, and whether its credit had committed by then. */
  statusCalls: [] as { redemptionId: string; status: string; creditCommitted: boolean }[],
  /** Skip the Redis locks, to show the database alone stops a double spend. */
  bypassLocks: false,
  /** The Twitch account that "completes" the broadcaster OAuth. */
  oauthUser: '',
}));

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

vi.mock('../src/twitch/helix.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/twitch/helix.js')>();
  return {
    ...actual,
    updateRedemptionStatus: vi.fn(
      async (
        channelId: string,
        rewardId: string,
        redemptionId: string,
        status: 'FULFILLED' | 'CANCELED',
      ) => {
        // A pool connection of its own, outside the caller's transaction: it
        // sees the credit only once that credit has COMMITTED.
        const { query } = await import('../src/db/pool.js');
        const { rows } = await query(
          'SELECT 1 FROM gta_wallet_transactions WHERE twitch_redemption_id = $1',
          [redemptionId],
        );
        h.statusCalls.push({ redemptionId, status, creditCommitted: rows.length > 0 });
        return actual.updateRedemptionStatus(channelId, rewardId, redemptionId, status);
      },
    ),
  };
});

vi.mock('../src/redis/lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/redis/lock.js')>();
  return {
    ...actual,
    withLock: vi.fn(
      async <T>(
        key: string,
        fn: () => Promise<T>,
        opts?: Parameters<typeof actual.withLock>[2],
      ): Promise<T> => (h.bypassLocks ? fn() : actual.withLock(key, fn, opts)),
    ),
  };
});

// The broadcaster OAuth callback without id.twitch.tv: any code "exchanges"
// for a token of whichever account the test says has just connected.
vi.mock('../src/twitch/tokens.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/twitch/tokens.js')>();
  return {
    ...actual,
    exchangeCodeForTokens: vi.fn(async () => ({
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_in: 14_400,
      token_type: 'bearer',
    })),
    validateToken: vi.fn(async () => ({
      userId: h.oauthUser,
      login: `user${h.oauthUser}`,
      scopes: [...actual.BROADCASTER_SCOPES],
    })),
  };
});

const online = await servicesAvailable();
const d = online ? describe : describe.skip;

const VIEWER = '123';
const OTHER = '456';
const EXCHANGE_TITLE = 'Обмен ETH на GTA DOLLAR';

interface Emitted {
  to: 'channel' | 'viewer';
  channelId: string;
  userId: string | null;
  audience: string | null;
  event: string;
  payload: unknown;
}
const emitted: Emitted[] = [];

beforeAll(() => {
  // Pinned rather than assumed: .env may carry either mode.
  setPaymentModeOverride('gta_dollar');
  setRealtimeTransport({
    emit(channelId, event, payload, audience) {
      emitted.push({ to: 'channel', channelId, userId: null, audience, event, payload });
    },
    emitToViewer(channelId, userId, event, payload) {
      emitted.push({ to: 'viewer', channelId, userId, audience: null, event, payload });
    },
  });
});

afterAll(() => {
  setPaymentModeOverride(null);
  setRealtimeTransport(null);
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function viewerToken(userId: string, channelId = TEST_CHANNEL): string {
  return signDevExtensionJwt({ channelId, userId });
}

/** Logged out: Twitch hands out an opaque `A…` id and nothing else. */
function anonymousToken(): string {
  return signDevExtensionJwt({ channelId: TEST_CHANNEL, userId: '31337', linked: false });
}

/** Logged in but identity not shared: an opaque `U…` id and no user_id claim. */
function unsharedToken(): string {
  return jwt.sign(
    {
      exp: Math.floor(Date.now() / 1000) + 600,
      channel_id: TEST_CHANNEL,
      opaque_user_id: 'UopaqueViewer42',
      role: 'viewer',
      is_unlinked: true,
    },
    extensionSecret(),
    { algorithm: 'HS256', noTimestamp: true },
  );
}

// ---------------------------------------------------------------------------
// Pure pieces: no database needed
// ---------------------------------------------------------------------------

describe('payment mode', () => {
  it('defaults to gta_dollar, accepts the legacy mode and refuses anything else', async () => {
    const { reloadEnv, env: liveEnv } = await import('../src/env.js');
    const saved = { ...process.env };
    try {
      delete process.env.WAYPOINT_PAYMENT_MODE;
      reloadEnv();
      expect(liveEnv.waypointPaymentMode).toBe('gta_dollar');

      process.env.WAYPOINT_PAYMENT_MODE = 'channel_points_reward';
      reloadEnv();
      expect(liveEnv.waypointPaymentMode).toBe('channel_points_reward');

      process.env.WAYPOINT_PAYMENT_MODE = 'free_for_all';
      expect(() => reloadEnv()).toThrowError(/WAYPOINT_PAYMENT_MODE/);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
      reloadEnv();
    }
  });

  it('reads the mode through one function that a test can pin', async () => {
    const { paymentMode } = await import('../src/domain/paymentMode.js');
    const { reloadEnv } = await import('../src/env.js');
    // Pinned by this file's beforeAll, and a reloadEnv() elsewhere must not undo it.
    reloadEnv();
    expect(paymentMode()).toBe('gta_dollar');
    setPaymentModeOverride('channel_points_reward');
    try {
      expect(paymentMode()).toBe('channel_points_reward');
    } finally {
      setPaymentModeOverride('gta_dollar');
    }
  });
});

describe('GTA$ identity and terms', () => {
  it('takes the wallet owner from the verified token only, and says why when there is none', async () => {
    const { requireLinkedViewer } = await import('../src/http/auth.js');
    const { verifyExtensionJwt } = await import('../src/twitch/extJwt.js');

    expect(requireLinkedViewer(verifyExtensionJwt(viewerToken(VIEWER)))).toBe(VIEWER);
    expect(() => requireLinkedViewer(verifyExtensionJwt(anonymousToken()))).toThrowError(
      expect.objectContaining({ code: 'needs_login', httpStatus: 403 }),
    );
    expect(() => requireLinkedViewer(verifyExtensionJwt(unsharedToken()))).toThrowError(
      expect.objectContaining({ code: 'needs_id_share', httpStatus: 403 }),
    );
  });

  it('admits the two economy settings within their limits', async () => {
    const { settingsPatchSchema } = await import('../src/domain/settings.js');
    const { DEFAULT_SETTINGS } = await import('../src/domain/types.js');

    expect(DEFAULT_SETTINGS).toMatchObject({ gtaDollarsPerChannelPoint: 10, exchangeRewardCost: 500 });
    expect(
      settingsPatchSchema.parse({ gtaDollarsPerChannelPoint: 1000, exchangeRewardCost: 1_000_000 }),
    ).toEqual({ gtaDollarsPerChannelPoint: 1000, exchangeRewardCost: 1_000_000 });
    for (const bad of [
      { gtaDollarsPerChannelPoint: 0 },
      { gtaDollarsPerChannelPoint: 1001 },
      { exchangeRewardCost: 0 },
      { exchangeRewardCost: 1_000_001 },
      { exchangeRewardCost: 12.5 },
    ]) {
      expect(settingsPatchSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('words the exchange reward exactly as the contract does', async () => {
    const { EXCHANGE_REWARD_TITLE, EXCHANGE_REWARD_COLOR, exchangePrompt } = await import(
      '../src/twitch/exchangeReward.js'
    );
    expect(EXCHANGE_REWARD_TITLE).toBe(EXCHANGE_TITLE);
    expect(EXCHANGE_REWARD_COLOR).toBe('#1FA35C');
    expect(exchangePrompt(10)).toBe(
      'Обменять ETH на GTA$ по курсу 1 ETH = 10 GTA$. GTA$ зачисляются на ваш кошелёк в карте GTA Phuket.',
    );
  });

  it('puts a socket in its own wallet room only on a verified, linked token', async () => {
    const { resolveSocketData, WALLET_ROOM } = await import('../src/realtime/io.js');
    const forged = jwt.sign(
      {
        exp: Math.floor(Date.now() / 1000) + 600,
        channel_id: TEST_CHANNEL,
        opaque_user_id: 'U123',
        user_id: VIEWER,
        role: 'viewer',
      },
      Buffer.from('some-other-secret'),
      { algorithm: 'HS256', noTimestamp: true },
    );

    expect(resolveSocketData({ token: viewerToken(VIEWER) })).toMatchObject({
      role: 'viewer',
      channelId: TEST_CHANNEL,
      viewerUserId: VIEWER,
    });
    expect(WALLET_ROOM(TEST_CHANNEL, VIEWER)).toBe(`wallet:${TEST_CHANNEL}:${VIEWER}`);

    // Everything else still connects, as a plain viewer with no wallet room.
    for (const auth of [
      {},
      { token: anonymousToken() },
      { token: unsharedToken() },
      { token: forged },
      { token: viewerToken(VIEWER, '900000002') },
      { token: 'garbage' },
    ]) {
      expect(resolveSocketData(auth)).toMatchObject({ role: 'viewer', viewerUserId: null });
    }
  });
});

describe('local Helix stub', () => {
  // The exchange's error paths depend on these refusals, so the stub must make them.
  it('refuses a duplicate title and an unknown reward like Twitch does', async () => {
    const { devHelix, resetDevHelix } = await import('../src/twitch/devHelix.js');
    resetDevHelix();
    const create = () =>
      devHelix({
        path: '/channel_points/custom_rewards',
        method: 'POST',
        query: { broadcaster_id: TEST_CHANNEL },
        body: { title: EXCHANGE_TITLE, cost: 500, is_enabled: true },
      });

    const first = create();
    expect(first.status).toBeUndefined();
    const id = (first.data as { data: { id: string }[] }).data[0]!.id;
    expect(create().status).toBe(400);

    const byId = (rewardId: string) =>
      devHelix({
        path: '/channel_points/custom_rewards',
        method: 'GET',
        query: { broadcaster_id: TEST_CHANNEL, id: rewardId },
        body: undefined,
      });
    expect(byId(id).status).toBeUndefined();
    expect(byId('no-such-reward').status).toBe(404);
    expect(
      devHelix({
        path: '/channel_points/custom_rewards',
        method: 'PATCH',
        query: { broadcaster_id: TEST_CHANNEL, id: 'no-such-reward' },
        body: { cost: 1 },
      }).status,
    ).toBe(404);
    resetDevHelix();
  });

  it('resolves a redemption once, and reports where it stands', async () => {
    const { devHelix, resetDevHelix, setDevRedemption } = await import('../src/twitch/devHelix.js');
    resetDevHelix();
    const patch = (id: string, status: string) =>
      devHelix({
        path: '/channel_points/custom_rewards/redemptions',
        method: 'PATCH',
        query: { broadcaster_id: TEST_CHANNEL, reward_id: 'r1', id },
        body: { status },
      });
    const get = (id: string) =>
      devHelix({
        path: '/channel_points/custom_rewards/redemptions',
        method: 'GET',
        query: { broadcaster_id: TEST_CHANNEL, reward_id: 'r1', id },
        body: undefined,
      });

    expect(patch('red-1', 'FULFILLED').status).toBeUndefined();
    expect(patch('red-1', 'FULFILLED').status).toBe(404);
    expect(get('red-1').data).toEqual({ data: [{ id: 'red-1', status: 'FULFILLED', reward: { id: 'r1' } }] });

    setDevRedemption('red-2', 'r1', 'CANCELED');
    expect(patch('red-2', 'FULFILLED').status).toBe(404);
    expect(get('red-2').data).toEqual({ data: [{ id: 'red-2', status: 'CANCELED', reward: { id: 'r1' } }] });
    expect(get('never-seen').data).toEqual({ data: [] });
    resetDevHelix();
  });
});

d('GTA DOLLAR economy', () => {
  let app: FastifyInstance;
  let exchangeRewardId = '';

  beforeAll(async () => {
    const { buildApp } = await import('../src/app.js');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase();
    await pushGps(PATONG.lat, PATONG.lng);
    h.statusCalls.length = 0;
    h.bypassLocks = false;
    emitted.length = 0;
    const { ensureExchangeReward } = await import('../src/twitch/exchangeReward.js');
    exchangeRewardId = (await ensureExchangeReward(TEST_CHANNEL)).reward.id;
  });

  // -------------------------------------------------------------------------
  // HTTP helpers
  // -------------------------------------------------------------------------

  async function ext(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    token: string | null,
    payload?: Record<string, unknown>,
  ) {
    const res = await app.inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(payload !== undefined ? { payload } : {}),
    });
    return { status: res.statusCode, body: res.json() };
  }

  async function admin(method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) {
    const { signAdminToken } = await import('../src/http/auth.js');
    return ext(method, url, signAdminToken(), payload);
  }

  async function deviceToken(): Promise<string> {
    const { query } = await import('../src/db/pool.js');
    const { signDeviceToken } = await import('../src/http/auth.js');
    const deviceId = randomUUID();
    await query(
      `INSERT INTO streamer_devices (id, channel_id, label, token_hash) VALUES ($1, $2, 'test phone', 'x')`,
      [deviceId, TEST_CHANNEL],
    );
    return signDeviceToken({ deviceId, channelId: TEST_CHANNEL });
  }

  // -------------------------------------------------------------------------
  // EventSub helpers
  // -------------------------------------------------------------------------

  function redemptionEvent(
    o: {
      userId?: string;
      cost?: number;
      rewardId?: string;
      redemptionId?: string;
      broadcaster?: string;
      status?: string;
    } = {},
  ) {
    const userId = o.userId ?? VIEWER;
    return {
      id: o.redemptionId ?? randomUUID(),
      broadcaster_user_id: o.broadcaster ?? TEST_CHANNEL,
      broadcaster_user_login: 'channel',
      broadcaster_user_name: 'Channel',
      user_id: userId,
      user_login: `viewer${userId}`,
      user_name: `Viewer ${userId}`,
      user_input: '',
      status: o.status ?? 'unfulfilled',
      redeemed_at: new Date().toISOString(),
      reward: { id: o.rewardId ?? exchangeRewardId, title: EXCHANGE_TITLE, cost: o.cost ?? 500, prompt: '' },
    };
  }

  /** POST a notification to the webhook exactly as Twitch would, signed with the test secret. */
  async function deliver(
    event: ReturnType<typeof redemptionEvent>,
    opts: { type?: string; messageId?: string; secret?: string; tamper?: boolean } = {},
  ): Promise<{ status: number; messageId: string }> {
    const type = opts.type ?? REDEMPTION_ADD;
    const messageId = opts.messageId ?? randomUUID();
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({
      subscription: {
        id: randomUUID(),
        type,
        version: '1',
        status: 'enabled',
        cost: 0,
        condition: { broadcaster_user_id: event.broadcaster_user_id },
        transport: { method: 'webhook', callback: 'https://localhost:8080/api/eventsub/twitch' },
        created_at: timestamp,
      },
      event,
    });
    const signature = computeSignature(
      messageId,
      timestamp,
      body,
      opts.secret ?? env.TWITCH_EVENTSUB_SECRET,
    );
    // A body changed after signing, e.g. a proxy inflating the cost.
    const sent = opts.tamper
      ? body.replace(`"cost":${event.reward.cost}`, `"cost":${event.reward.cost * 100}`)
      : body;
    const res = await app.inject({
      method: 'POST',
      url: '/api/eventsub/twitch',
      headers: {
        'content-type': 'application/json',
        'twitch-eventsub-message-id': messageId,
        'twitch-eventsub-message-type': 'notification',
        'twitch-eventsub-message-timestamp': timestamp,
        'twitch-eventsub-message-signature': signature,
        'twitch-eventsub-subscription-type': type,
      },
      payload: sent,
    });
    return { status: res.statusCode, messageId };
  }

  /** The webhook answers first and works after: wait until the work has run, or failed. */
  async function settled(
    messageId: string,
  ): Promise<{ processed: boolean; attempts: number; lastError: string | null }> {
    const { query } = await import('../src/db/pool.js');
    const deadline = Date.now() + 5000;
    for (;;) {
      const { rows } = await query<{
        processed_at: Date | null;
        attempts: number;
        last_error: string | null;
      }>('SELECT processed_at, attempts, last_error FROM eventsub_events WHERE message_id = $1', [
        messageId,
      ]);
      const row = rows[0];
      if (row && (row.processed_at !== null || row.attempts > 0)) {
        return { processed: row.processed_at !== null, attempts: row.attempts, lastError: row.last_error };
      }
      if (Date.now() > deadline) throw new Error(`eventsub message ${messageId} never ran`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async function deliverAndSettle(event: ReturnType<typeof redemptionEvent>): Promise<string> {
    const { status, messageId } = await deliver(event);
    expect(status).toBe(204);
    expect((await settled(messageId)).processed).toBe(true);
    return messageId;
  }

  /** Top a wallet up the only way the product can: redeeming the exchange reward. */
  async function credit(userId: string, eth: number): Promise<void> {
    await deliverAndSettle(redemptionEvent({ userId, cost: eth }));
  }

  // -------------------------------------------------------------------------
  // Database helpers
  // -------------------------------------------------------------------------

  async function storedBalance(userId: string, channelId = TEST_CHANNEL): Promise<number | null> {
    const { query } = await import('../src/db/pool.js');
    const { rows } = await query<{ balance: number }>(
      'SELECT balance FROM gta_wallets WHERE channel_id = $1 AND twitch_user_id = $2',
      [channelId, userId],
    );
    return rows[0]?.balance ?? null;
  }

  async function ledgerOf(userId: string) {
    const { query } = await import('../src/db/pool.js');
    const { rows } = await query<{
      type: string;
      amount: number;
      balance_after: number;
      twitch_redemption_id: string | null;
      twitch_reward_id: string | null;
      channel_points_cost: number | null;
      quote_id: string | null;
      waypoint_id: string | null;
      fulfillment_status: string | null;
      fulfillment_attempts: number;
    }>(
      `SELECT type, amount, balance_after, twitch_redemption_id, twitch_reward_id,
              channel_points_cost, quote_id, waypoint_id, fulfillment_status, fulfillment_attempts
         FROM gta_wallet_transactions
        WHERE channel_id = $1 AND twitch_user_id = $2
        ORDER BY created_at, id`,
      [TEST_CHANNEL, userId],
    );
    return rows;
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { query } = await import('../src/db/pool.js');
    const { rows } = await query<{ n: number }>(sql, params);
    return rows[0]?.n ?? 0;
  }

  function countOfType(type: string): Promise<number> {
    return count('SELECT count(*)::int AS n FROM gta_wallet_transactions WHERE type = $1', [type]);
  }

  async function ledgerConsistent(): Promise<boolean> {
    const { checkLedgerConsistency } = await import('../src/domain/wallet.js');
    return (await checkLedgerConsistency(TEST_CHANNEL)).consistent;
  }

  async function quote(userId: string): Promise<{ quoteId: string; cost: number }> {
    const res = await ext('POST', '/api/ext/quote', viewerToken(userId), {
      lat: JUNGCEYLON.lat,
      lng: JUNGCEYLON.lng,
      name: 'Jungceylon',
    });
    expect(res.status).toBe(200);
    return { quoteId: res.body.quoteId as string, cost: res.body.cost as number };
  }

  function purchase(userId: string, quoteId: string, extra: Record<string, unknown> = {}) {
    return ext('POST', '/api/ext/waypoints/purchase', viewerToken(userId), { quoteId, ...extra });
  }

  function walletEvents() {
    return emitted.filter((e) => e.event === 'wallet:updated');
  }

  // =========================================================================
  // 4. EventSub → credit
  // =========================================================================

  describe('exchange credit', () => {
    it('credits 500 ETH as GTA$ 5 000 to the wallet of the viewer who redeemed (1, 2)', async () => {
      await credit(VIEWER, 500);

      expect(await storedBalance(VIEWER)).toBe(5000);
      const rows = await ledgerOf(VIEWER);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'EXCHANGE_CREDIT',
        amount: 5000,
        balance_after: 5000,
        twitch_reward_id: exchangeRewardId,
        channel_points_cost: 500,
        fulfillment_status: 'FULFILLED',
      });
    });

    it('prices what Twitch actually charged at the rate in force when it is processed', async () => {
      const { saveSettings } = await import('../src/domain/settings.js');
      await saveSettings(TEST_CHANNEL, { gtaDollarsPerChannelPoint: 12 });

      await credit(VIEWER, 250);
      expect(await storedBalance(VIEWER)).toBe(3000);
    });

    it('never touches another viewer’s wallet (3)', async () => {
      await credit(VIEWER, 500);
      expect(await storedBalance(OTHER)).toBeNull();

      await credit(OTHER, 30);
      expect(await storedBalance(OTHER)).toBe(300);
      expect(await storedBalance(VIEWER)).toBe(5000);
    });

    it('credits one redemption once, however it is redelivered (4)', async () => {
      const { redis } = await import('../src/redis/client.js');
      const event = redemptionEvent({ userId: VIEWER, cost: 500 });

      const messageId = await deliverAndSettle(event);
      // The same message again: stopped by the message-id dedupe.
      expect((await deliver(event, { messageId })).status).toBe(204);
      // The same redemption under a new message id: stopped by the ledger.
      await deliverAndSettle(event);
      // And again after Redis forgot everything.
      await redis.flushdb();
      await deliverAndSettle(event);

      expect(await storedBalance(VIEWER)).toBe(5000);
      expect(await ledgerOf(VIEWER)).toHaveLength(1);
      expect(h.statusCalls.filter((c) => c.status === 'FULFILLED')).toHaveLength(1);
    });

    it('credits nothing for any other reward, and never fulfils or refunds it (5)', async () => {
      await seedRewardPool(2);
      const { listSlots } = await import('../src/twitch/rewards.js');
      const slot = (await listSlots(TEST_CHANNEL))[0];
      expect(slot).toBeDefined();

      // A legacy slot reward: not ours to touch in gta_dollar mode.
      await deliverAndSettle(redemptionEvent({ rewardId: slot!.twitchRewardId, cost: 1500 }));
      // Somebody else's reward on the same channel.
      await deliverAndSettle(redemptionEvent({ rewardId: 'somebody-elses-reward', cost: 500 }));

      expect(await count('SELECT count(*)::int AS n FROM gta_wallets')).toBe(0);
      expect(await count('SELECT count(*)::int AS n FROM twitch_redemptions')).toBe(0);
      expect(h.statusCalls).toHaveLength(0);
    });

    it('refuses an invalid signature before anything is stored (6)', async () => {
      const event = redemptionEvent({ userId: VIEWER, cost: 500 });

      expect((await deliver(event, { secret: 'not-the-eventsub-secret-0000' })).status).toBe(403);
      expect((await deliver(event, { tamper: true })).status).toBe(403);

      expect(await count('SELECT count(*)::int AS n FROM eventsub_events')).toBe(0);
      expect(await storedBalance(VIEWER)).toBeNull();
      expect(h.statusCalls).toHaveLength(0);
    });

    it('ignores a redemption for another channel, or without a numeric user', async () => {
      await deliverAndSettle(redemptionEvent({ broadcaster: '900000002' }));
      await deliverAndSettle(redemptionEvent({ userId: 'not-a-number' }));

      expect(await count('SELECT count(*)::int AS n FROM gta_wallets')).toBe(0);
      expect(h.statusCalls).toHaveLength(0);
    });

    it('only logs an update event of the exchange reward', async () => {
      const event = redemptionEvent({ userId: VIEWER, cost: 500 });
      await credit(VIEWER, 500);
      const { status, messageId } = await deliver(
        { ...event, status: 'canceled' },
        { type: REDEMPTION_UPDATE },
      );
      expect(status).toBe(204);
      expect((await settled(messageId)).processed).toBe(true);
      expect(await storedBalance(VIEWER)).toBe(5000);
    });

    it('still credits in channel_points_reward mode', async () => {
      setPaymentModeOverride('channel_points_reward');
      try {
        await credit(VIEWER, 500);
      } finally {
        setPaymentModeOverride('gta_dollar');
      }
      expect(await storedBalance(VIEWER)).toBe(5000);
    });

    it('tells that viewer, and only that viewer, about the credit (14)', async () => {
      await credit(VIEWER, 500);

      const events = walletEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        to: 'viewer',
        channelId: TEST_CHANNEL,
        userId: VIEWER,
        payload: { type: 'EXCHANGE_CREDIT', amount: 5000, balance: 5000, transactionId: expect.any(String) },
      });
    });
  });

  // =========================================================================
  // 4.7 Fulfilment
  // =========================================================================

  describe('fulfilment', () => {
    it('marks FULFILLED only after the credit has committed', async () => {
      await credit(VIEWER, 500);
      expect(h.statusCalls).toEqual([
        { redemptionId: expect.any(String), status: 'FULFILLED', creditCommitted: true },
      ]);
    });

    it('fulfils nothing when the credit fails, and the event retry credits it later', async () => {
      const { query } = await import('../src/db/pool.js');
      await query(`CREATE OR REPLACE FUNCTION gta_test_refuse_ledger() RETURNS trigger
                     LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected ledger failure'; END $$`);
      await query(`CREATE TRIGGER gta_test_refuse_ledger BEFORE INSERT ON gta_wallet_transactions
                     FOR EACH ROW EXECUTE FUNCTION gta_test_refuse_ledger()`);
      let messageId = '';
      try {
        ({ messageId } = await deliver(redemptionEvent({ userId: VIEWER, cost: 500 })));
        const outcome = await settled(messageId);
        expect(outcome.processed).toBe(false);
        expect(outcome.lastError).toMatch(/injected ledger failure/);
      } finally {
        await query('DROP TRIGGER IF EXISTS gta_test_refuse_ledger ON gta_wallet_transactions');
        await query('DROP FUNCTION IF EXISTS gta_test_refuse_ledger()');
      }

      // Rolled back whole — not even the wallet row survived — and Twitch was told nothing.
      expect(await storedBalance(VIEWER)).toBeNull();
      expect(h.statusCalls).toHaveLength(0);

      // The stored event is retried like any other that failed.
      await query(
        `UPDATE eventsub_events SET received_at = now() - interval '2 minutes' WHERE message_id = $1`,
        [messageId],
      );
      const { retryPendingEvents } = await import('../src/twitch/eventsub.js');
      expect(await retryPendingEvents(30, 10)).toBe(1);

      expect(await storedBalance(VIEWER)).toBe(5000);
      expect(h.statusCalls).toEqual([
        { redemptionId: expect.any(String), status: 'FULFILLED', creditCommitted: true },
      ]);
    });

    it('retries a fulfilment Twitch did not accept, while the credit stands', async () => {
      const { failNextDevHelix } = await import('../src/twitch/devHelix.js');
      const { retryPendingFulfillments } = await import('../src/twitch/exchangeReward.js');
      failNextDevHelix('PATCH', '/channel_points/custom_rewards/redemptions', 503);

      await credit(VIEWER, 500);
      expect(await storedBalance(VIEWER)).toBe(5000);
      expect((await ledgerOf(VIEWER))[0]).toMatchObject({
        fulfillment_status: 'PENDING',
        fulfillment_attempts: 1,
      });

      expect(await retryPendingFulfillments(TEST_CHANNEL, 0)).toBe(1);
      expect((await ledgerOf(VIEWER))[0]).toMatchObject({
        fulfillment_status: 'FULFILLED',
        fulfillment_attempts: 2,
      });
      expect(await retryPendingFulfillments(TEST_CHANNEL, 0)).toBe(0);
    });

    it('gives up after 10 attempts and shows the failure to the admin', async () => {
      const { failNextDevHelix } = await import('../src/twitch/devHelix.js');
      const { retryPendingFulfillments } = await import('../src/twitch/exchangeReward.js');
      failNextDevHelix('PATCH', '/channel_points/custom_rewards/redemptions', 503, 10);

      await credit(VIEWER, 500);
      for (let i = 0; i < 9; i += 1) await retryPendingFulfillments(TEST_CHANNEL, 0);

      expect((await ledgerOf(VIEWER))[0]).toMatchObject({
        fulfillment_status: 'FAILED',
        fulfillment_attempts: 10,
      });
      expect(await retryPendingFulfillments(TEST_CHANNEL, 0)).toBe(0);
      expect(await storedBalance(VIEWER)).toBe(5000);

      const economy = await admin('GET', '/api/admin/economy');
      expect(economy.body).toMatchObject({ pendingFulfillments: 0, failedFulfillments: 1 });
    });

    it('settles a refused status update by reading the redemption back', async () => {
      const { setDevRedemption } = await import('../src/twitch/devHelix.js');

      const canceled = redemptionEvent({ userId: VIEWER, cost: 500 });
      setDevRedemption(canceled.id, exchangeRewardId, 'CANCELED');
      await deliverAndSettle(canceled);

      const fulfilled = redemptionEvent({ userId: OTHER, cost: 500 });
      setDevRedemption(fulfilled.id, exchangeRewardId, 'FULFILLED');
      await deliverAndSettle(fulfilled);

      expect((await ledgerOf(VIEWER))[0]).toMatchObject({ fulfillment_status: 'CANCELED_EXTERNALLY' });
      expect((await ledgerOf(OTHER))[0]).toMatchObject({ fulfillment_status: 'FULFILLED' });
      // Never clawed back automatically: that is the admin's call.
      expect(await storedBalance(VIEWER)).toBe(5000);

      const economy = await admin('GET', '/api/admin/economy');
      expect(economy.body).toMatchObject({ canceledExternally: 1, pendingFulfillments: 0 });
    });
  });

  // =========================================================================
  // 5–6. Identity and the wallet API
  // =========================================================================

  describe('wallet API', () => {
    it('returns the wallet of the token’s own user (7)', async () => {
      await credit(VIEWER, 500);

      const res = await ext('GET', '/api/ext/wallet', viewerToken(VIEWER));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        currency: 'GTA_DOLLAR',
        symbol: 'GTA$',
        balance: 5000,
        exchangeRate: 10,
        exchange: {
          rewardTitle: EXCHANGE_TITLE,
          rewardCost: 500,
          gtaPerRedemption: 5000,
          available: true,
        },
      });
      expect(res.body.recent).toHaveLength(1);
      expect(res.body.recent[0]).toMatchObject({
        id: expect.any(String),
        type: 'EXCHANGE_CREDIT',
        amount: 5000,
        balanceAfter: 5000,
      });
      expect(new Date(res.body.recent[0].createdAt).toISOString()).toBe(res.body.recent[0].createdAt);
    });

    it('ignores a userId in the query string or the body (8)', async () => {
      await credit(VIEWER, 500);
      await credit(OTHER, 100);

      const read = await ext('GET', `/api/ext/wallet?userId=${OTHER}`, viewerToken(VIEWER));
      expect(read.body.balance).toBe(5000);

      const q = await quote(VIEWER);
      const bought = await purchase(VIEWER, q.quoteId, { userId: OTHER, cost: 1 });
      expect(bought.status).toBe(200);
      expect(bought.body).toMatchObject({ charged: true, cost: 1500, balance: 3500 });

      expect(await storedBalance(VIEWER)).toBe(3500);
      expect(await storedBalance(OTHER)).toBe(1000);
    });

    it('reads 0 for a linked viewer who never had GTA$, without creating a wallet', async () => {
      const res = await ext('GET', '/api/ext/wallet', viewerToken(VIEWER));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ balance: 0, recent: [] });
      expect(await count('SELECT count(*)::int AS n FROM gta_wallets')).toBe(0);
    });

    it('refuses anonymous and unshared viewers, and never gives them a wallet', async () => {
      await credit(VIEWER, 500);
      const q = await quote(VIEWER);

      for (const [token, code] of [
        [anonymousToken(), 'needs_login'],
        [unsharedToken(), 'needs_id_share'],
      ] as const) {
        const wallet = await ext('GET', '/api/ext/wallet', token);
        expect(wallet.status).toBe(403);
        expect(wallet.body.error).toBe(code);

        const bought = await ext('POST', '/api/ext/waypoints/purchase', token, { quoteId: q.quoteId });
        expect(bought.status).toBe(403);
        expect(bought.body.error).toBe(code);
      }
      expect((await ext('GET', '/api/ext/wallet', null)).status).toBe(401);

      expect(await count('SELECT count(*)::int AS n FROM gta_wallets')).toBe(1);
      expect(await count('SELECT count(*)::int AS n FROM waypoints')).toBe(0);
    });

    it('keeps channels apart', async () => {
      const { creditExchange } = await import('../src/domain/wallet.js');
      // The same Twitch user holding GTA$ on some other channel.
      await creditExchange({
        channelId: '900000002',
        twitchUserId: VIEWER,
        redemptionId: randomUUID(),
        rewardId: 'elsewhere',
        channelPointsCost: 77,
        amount: 770,
      });

      const mine = await ext('GET', '/api/ext/wallet', viewerToken(VIEWER));
      expect(mine.body.balance).toBe(0);

      const foreign = await ext('GET', '/api/ext/wallet', viewerToken(VIEWER, '900000002'));
      expect(foreign.status).toBe(403);
      expect(foreign.body.error).toBe('forbidden');

      const economy = await admin('GET', '/api/admin/economy');
      expect(economy.body.totals).toMatchObject({ issued: 0, circulating: 0, wallets: 0 });
    });

    it('keeps the balance across reads and a Redis flush (13)', async () => {
      const { redis } = await import('../src/redis/client.js');
      await credit(VIEWER, 500);

      expect((await ext('GET', '/api/ext/wallet', viewerToken(VIEWER))).body.balance).toBe(5000);
      expect((await ext('GET', '/api/ext/wallet', viewerToken(VIEWER))).body.balance).toBe(5000);
      await redis.flushdb();
      expect((await ext('GET', '/api/ext/wallet', viewerToken(VIEWER))).body.balance).toBe(5000);
    });

    it('caps wallet reads per viewer, and only that viewer', async () => {
      const token = viewerToken(VIEWER);
      for (let i = 0; i < 60; i += 1) {
        expect((await ext('GET', '/api/ext/wallet', token)).status).toBe(200);
      }
      const refused = await ext('GET', '/api/ext/wallet', token);
      expect(refused.status).toBe(429);
      expect(refused.body.error).toBe('rate_limited');

      expect((await ext('GET', '/api/ext/wallet', viewerToken(OTHER))).status).toBe(200);
    });

    it('publishes the payment mode and the exchange terms in /api/ext/state', async () => {
      const { query } = await import('../src/db/pool.js');

      const res = await ext('GET', '/api/ext/state', anonymousToken());
      expect(res.status).toBe(200);
      expect(res.body.paymentMode).toBe('gta_dollar');
      expect(res.body.economy).toEqual({
        symbol: 'GTA$',
        exchangeRate: 10,
        rewardTitle: EXCHANGE_TITLE,
        rewardCost: 500,
        gtaPerRedemption: 5000,
        available: true,
      });

      await query('DELETE FROM gta_exchange_rewards');
      const without = await ext('GET', '/api/ext/state', anonymousToken());
      expect(without.body.economy).toMatchObject({ available: false, rewardCost: 500 });
    });
  });

  // =========================================================================
  // 6. Buying a waypoint
  // =========================================================================

  describe('purchase', () => {
    it('prices the quote in GTA$', async () => {
      const res = await ext('POST', '/api/ext/quote', viewerToken(VIEWER), {
        lat: JUNGCEYLON.lat,
        lng: JUNGCEYLON.lng,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        cost: 1500,
        currency: 'GTA_DOLLAR',
        status: 'QUOTED',
        rewardTitle: null,
      });
    });

    it('turns GTA$ 5 000 into 3 500 and an active waypoint, in one step (9)', async () => {
      await credit(VIEWER, 500);
      const q = await quote(VIEWER);
      emitted.length = 0;

      const res = await purchase(VIEWER, q.quoteId);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        charged: true,
        cost: 1500,
        balance: 3500,
        waypoint: { currency: 'GTA_DOLLAR', channelPointsPaid: 1500, destinationName: 'Jungceylon' },
      });
      const waypointId = res.body.waypoint.id as string;

      expect(await storedBalance(VIEWER)).toBe(3500);
      const debit = (await ledgerOf(VIEWER))[1];
      expect(debit).toMatchObject({
        type: 'WAYPOINT_DEBIT',
        amount: -1500,
        balance_after: 3500,
        quote_id: q.quoteId,
        waypoint_id: waypointId,
      });

      const { getQuote } = await import('../src/domain/quotes.js');
      const { getActiveWaypoint } = await import('../src/domain/waypoints.js');
      expect((await getQuote(q.quoteId))?.status).toBe('PAID');
      expect(await getActiveWaypoint(TEST_CHANNEL)).toMatchObject({
        id: waypointId,
        currency: 'GTA_DOLLAR',
        channelPointsPaid: 1500,
        twitchUserId: VIEWER,
      });

      const activated = emitted.filter((e) => e.event === 'waypoint:activated');
      expect(activated.map((e) => e.audience).sort()).toEqual(['trusted', 'viewers']);
      expect(walletEvents()).toEqual([
        expect.objectContaining({
          to: 'viewer',
          userId: VIEWER,
          payload: { type: 'WAYPOINT_DEBIT', amount: -1500, balance: 3500, transactionId: expect.any(String) },
        }),
      ]);
      expect(emitted.filter((e) => e.event === 'waypoint:purchased')).toEqual([
        expect.objectContaining({
          to: 'channel',
          audience: 'trusted',
          payload: { waypointId, quoteId: q.quoteId, userId: VIEWER, cost: 1500, currency: 'GTA_DOLLAR' },
        }),
      ]);
      expect(await ledgerConsistent()).toBe(true);
    });

    it('refuses GTA$ 1 500 from a balance of 1 000 and changes nothing (10)', async () => {
      await credit(VIEWER, 100);
      const q = await quote(VIEWER);

      const res = await purchase(VIEWER, q.quoteId);
      expect(res.status).toBe(402);
      expect(res.body).toMatchObject({
        error: 'insufficient_funds',
        details: { balance: 1000, cost: 1500 },
      });

      expect(await storedBalance(VIEWER)).toBe(1000);
      expect(await ledgerOf(VIEWER)).toHaveLength(1);
      expect(await count('SELECT count(*)::int AS n FROM waypoints')).toBe(0);
      const { getQuote } = await import('../src/domain/quotes.js');
      expect((await getQuote(q.quoteId))?.status).toBe('QUOTED');
    });

    it('charges a quote once however often it is bought', async () => {
      await credit(VIEWER, 500);
      const q = await quote(VIEWER);

      const first = await purchase(VIEWER, q.quoteId);
      const second = await purchase(VIEWER, q.quoteId);
      expect(first.body).toMatchObject({ charged: true, balance: 3500 });
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ charged: false, balance: 3500, cost: 1500 });
      expect(second.body.waypoint.id).toBe(first.body.waypoint.id);

      expect(await countOfType('WAYPOINT_DEBIT')).toBe(1);
    });

    it('answers a repeat that comes after the job ended with how it ended', async () => {
      await credit(VIEWER, 500);
      const device = await deviceToken();

      const done = await quote(VIEWER);
      expect((await purchase(VIEWER, done.quoteId)).body).toMatchObject({
        charged: true,
        waypointStatus: 'ACTIVE',
      });
      expect((await ext('POST', '/api/streamer/waypoint/complete', device)).status).toBe(200);
      expect(emitted.find((e) => e.event === 'waypoint:completed')?.payload).toMatchObject({
        quoteId: done.quoteId,
      });
      // The response to the first press was lost; the viewer presses again.
      const afterCompletion = await purchase(VIEWER, done.quoteId);
      expect(afterCompletion.status).toBe(200);
      expect(afterCompletion.body).toMatchObject({
        charged: false,
        waypointStatus: 'COMPLETED',
        balance: 3500,
      });

      const dropped = await quote(VIEWER);
      expect((await purchase(VIEWER, dropped.quoteId)).body).toMatchObject({ charged: true, balance: 2000 });
      expect(
        (await ext('POST', '/api/streamer/waypoint/cancel', device, { reason: 'unsafe' })).status,
      ).toBe(200);
      const afterCancel = await purchase(VIEWER, dropped.quoteId);
      expect(afterCancel.body).toMatchObject({ charged: false, waypointStatus: 'CANCELED', balance: 3500 });

      expect(await countOfType('WAYPOINT_DEBIT')).toBe(2);
      expect(await ledgerConsistent()).toBe(true);
    });

    async function raceOneQuote(bypassLocks: boolean): Promise<void> {
      // Exactly one purchase worth: any second charge would have to go negative.
      await credit(VIEWER, 150);
      const q = await quote(VIEWER);

      h.bypassLocks = bypassLocks;
      let results: Awaited<ReturnType<typeof purchase>>[];
      try {
        results = await Promise.all(Array.from({ length: 6 }, () => purchase(VIEWER, q.quoteId)));
      } finally {
        h.bypassLocks = false;
      }

      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(results.filter((r) => r.body.charged === true)).toHaveLength(1);
      expect(new Set(results.map((r) => r.body.waypoint.id)).size).toBe(1);

      expect(await storedBalance(VIEWER)).toBe(0);
      expect(await countOfType('WAYPOINT_DEBIT')).toBe(1);
      expect(await count('SELECT count(*)::int AS n FROM waypoints')).toBe(1);
      expect(await ledgerConsistent()).toBe(true);
    }

    async function raceTwoViewers(bypassLocks: boolean): Promise<void> {
      await credit(VIEWER, 500);
      await credit(OTHER, 500);
      const a = await quote(VIEWER);
      const b = await quote(OTHER);

      h.bypassLocks = bypassLocks;
      let results: Awaited<ReturnType<typeof purchase>>[];
      try {
        results = await Promise.all([purchase(VIEWER, a.quoteId), purchase(OTHER, b.quoteId)]);
      } finally {
        h.bypassLocks = false;
      }

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const loser = results.find((r) => r.status === 409);
      expect(loser?.body.error).toBe('waypoint_active');

      expect(await count(`SELECT count(*)::int AS n FROM waypoints WHERE status = 'ACTIVE'`)).toBe(1);
      const balances = [await storedBalance(VIEWER), await storedBalance(OTHER)].sort();
      expect(balances).toEqual([3500, 5000]);
      expect(await ledgerConsistent()).toBe(true);
    }

    it('cannot be overspent by parallel purchases of one quote (11)', async () => {
      await raceOneQuote(false);
    });

    it('cannot be overspent by parallel purchases even without the Redis lock (11)', async () => {
      await raceOneQuote(true);
    });

    it('makes one waypoint when two viewers buy at once (11)', async () => {
      await raceTwoViewers(false);
    });

    it('makes one waypoint when two viewers buy at once, even without the Redis lock (11)', async () => {
      await raceTwoViewers(true);
    });

    it('is guarded by the database itself, not only by the code', async () => {
      const { query } = await import('../src/db/pool.js');
      await credit(VIEWER, 500);
      const q = await quote(VIEWER);
      const bought = await purchase(VIEWER, q.quoteId);
      const waypointId = bought.body.waypoint.id as string;

      // A second debit for the same quote.
      await expect(
        query(
          `INSERT INTO gta_wallet_transactions
             (id, channel_id, twitch_user_id, type, amount, balance_after, quote_id, waypoint_id)
           VALUES ($1, $2, $3, 'WAYPOINT_DEBIT', -1500, 2000, $4, $5)`,
          [randomUUID(), TEST_CHANNEL, VIEWER, q.quoteId, waypointId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      // A second credit for the same redemption.
      const creditRow = (await ledgerOf(VIEWER))[0];
      await expect(
        query(
          `INSERT INTO gta_wallet_transactions
             (id, channel_id, twitch_user_id, type, amount, balance_after, twitch_redemption_id)
           VALUES ($1, $2, $3, 'EXCHANGE_CREDIT', 5000, 8500, $4)`,
          [randomUUID(), TEST_CHANNEL, VIEWER, creditRow?.twitch_redemption_id],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      // A negative balance.
      await expect(
        query('UPDATE gta_wallets SET balance = -1 WHERE twitch_user_id = $1', [VIEWER]),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('refuses a quote whose price changed since, and cancels it', async () => {
      await credit(VIEWER, 500);
      const q = await quote(VIEWER);
      const { saveSettings } = await import('../src/domain/settings.js');
      await saveSettings(TEST_CHANNEL, { baseCost: 200 });

      const res = await purchase(VIEWER, q.quoteId);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'price_changed', details: { quoted: 1500, current: 1600 } });

      const { getQuote } = await import('../src/domain/quotes.js');
      expect((await getQuote(q.quoteId))?.status).toBe('CANCELED');
      expect(await storedBalance(VIEWER)).toBe(5000);
      expect(await count('SELECT count(*)::int AS n FROM waypoints')).toBe(0);
    });

    it('refuses an expired quote, somebody else’s quote and an unknown one', async () => {
      const { query } = await import('../src/db/pool.js');
      const { getQuote } = await import('../src/domain/quotes.js');
      await credit(VIEWER, 500);
      await credit(OTHER, 500);
      const q = await quote(VIEWER);

      const stolen = await purchase(OTHER, q.quoteId);
      expect(stolen.status).toBe(403);
      expect(stolen.body.error).toBe('forbidden');

      const unknown = await purchase(VIEWER, randomUUID());
      expect(unknown.status).toBe(404);
      expect(unknown.body.error).toBe('quote_not_found');

      await query(
        `UPDATE waypoint_quotes SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [q.quoteId],
      );
      const expired = await purchase(VIEWER, q.quoteId);
      expect(expired.status).toBe(409);
      expect(expired.body.error).toBe('quote_expired');
      expect((await getQuote(q.quoteId))?.status).toBe('EXPIRED');

      expect(await storedBalance(VIEWER)).toBe(5000);
      expect(await storedBalance(OTHER)).toBe(5000);
    });

    it('refuses while waypoints are closed', async () => {
      await credit(VIEWER, 500);
      const q = await quote(VIEWER);
      const { setWaypointsOpen } = await import('../src/domain/settings.js');
      await setWaypointsOpen(TEST_CHANNEL, false);

      const res = await purchase(VIEWER, q.quoteId);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('waypoints_closed');
      expect(await storedBalance(VIEWER)).toBe(5000);
    });

    it('answers the legacy confirm with 409 payment_mode and leases no slot', async () => {
      await seedRewardPool(3);
      const q = await quote(VIEWER);

      const res = await ext('POST', `/api/ext/quote/${q.quoteId}/confirm`, viewerToken(VIEWER));
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('payment_mode');

      const { countFreeSlots } = await import('../src/domain/slots.js');
      const { getQuote } = await import('../src/domain/quotes.js');
      expect((await countFreeSlots(TEST_CHANNEL, 3)).free).toBe(3);
      expect((await getQuote(q.quoteId))?.status).toBe('QUOTED');
    });
  });

  // =========================================================================
  // 7. Refunds
  // =========================================================================

  describe('refunds', () => {
    async function buy(): Promise<string> {
      const q = await quote(VIEWER);
      const res = await purchase(VIEWER, q.quoteId);
      expect(res.status).toBe(200);
      return res.body.waypoint.id as string;
    }

    it('refunds a canceled mission exactly once (12)', async () => {
      await credit(VIEWER, 500);
      const waypointId = await buy();
      const device = await deviceToken();
      emitted.length = 0;

      const first = await ext('POST', '/api/streamer/waypoint/cancel', device, { reason: 'cannot' });
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ ok: true, refunded: true, amount: 1500 });
      expect(await storedBalance(VIEWER)).toBe(5000);
      expect((await ledgerOf(VIEWER))[2]).toMatchObject({
        type: 'MISSION_REFUND',
        amount: 1500,
        balance_after: 5000,
        waypoint_id: waypointId,
      });
      expect(walletEvents()).toEqual([
        expect.objectContaining({
          userId: VIEWER,
          payload: expect.objectContaining({ type: 'MISSION_REFUND', amount: 1500, balance: 5000 }),
        }),
      ]);

      // Nothing left to cancel, and the refund cannot be booked twice however it is asked for.
      const second = await ext('POST', '/api/streamer/waypoint/cancel', device, { reason: 'unsafe' });
      expect(second.status).toBe(404);
      const { withTransaction } = await import('../src/db/pool.js');
      const { refundWaypoint } = await import('../src/domain/wallet.js');
      const again = await withTransaction((client) =>
        refundWaypoint(client, { channelId: TEST_CHANNEL, waypointId, reason: 'again' }),
      );
      expect(again).toEqual({ refunded: false, amount: 0 });

      expect(await storedBalance(VIEWER)).toBe(5000);
      expect(await countOfType('MISSION_REFUND')).toBe(1);
      // Channel Points were never touched: only the exchange was ever FULFILLED.
      expect(h.statusCalls.map((c) => c.status)).toEqual(['FULFILLED']);
      expect(await ledgerConsistent()).toBe(true);
    });

    it('refunds through the admin cancel too, but only when asked', async () => {
      await credit(VIEWER, 500);

      await buy();
      const refunded = await admin('POST', '/api/admin/waypoint/cancel', { refund: true });
      expect(refunded.status).toBe(200);
      expect(refunded.body).toMatchObject({ ok: true, refunded: true, amount: 1500 });
      expect(await storedBalance(VIEWER)).toBe(5000);

      await buy();
      const kept = await admin('POST', '/api/admin/waypoint/cancel', {});
      expect(kept.body).toMatchObject({ ok: true, refunded: false, amount: 0 });
      expect(await storedBalance(VIEWER)).toBe(3500);
    });

    it('refunds once when the admin resets the route', async () => {
      await credit(VIEWER, 500);
      const waypointId = await buy();
      emitted.length = 0;

      const cleared = await admin('POST', '/api/admin/waypoint/clear');
      expect(cleared.status).toBe(200);
      expect(cleared.body).toEqual({ ok: true, refunded: true, amount: 1500 });
      expect(await storedBalance(VIEWER)).toBe(5000);
      expect((await ledgerOf(VIEWER))[2]).toMatchObject({
        type: 'MISSION_REFUND',
        amount: 1500,
        waypoint_id: waypointId,
      });
      expect(walletEvents()).toEqual([
        expect.objectContaining({ userId: VIEWER, payload: expect.objectContaining({ type: 'MISSION_REFUND' }) }),
      ]);

      // Nothing left to reset, and nothing paid back twice.
      expect((await admin('POST', '/api/admin/waypoint/clear')).body).toEqual({
        ok: true,
        refunded: false,
        amount: 0,
      });
      expect(await countOfType('MISSION_REFUND')).toBe(1);
      expect(await ledgerConsistent()).toBe(true);
    });

    it('never refunds a completed mission', async () => {
      await credit(VIEWER, 500);
      await buy();
      const device = await deviceToken();

      expect((await ext('POST', '/api/streamer/waypoint/complete', device)).status).toBe(200);
      expect((await ext('POST', '/api/streamer/waypoint/cancel', device, { reason: 'cannot' })).status).toBe(404);
      expect(await storedBalance(VIEWER)).toBe(3500);
      expect(await countOfType('MISSION_REFUND')).toBe(0);
    });

    it('accepts only a paired phone and the two reasons', async () => {
      await credit(VIEWER, 500);
      await buy();

      expect((await ext('POST', '/api/streamer/waypoint/cancel', null, { reason: 'cannot' })).status).toBe(401);
      const device = await deviceToken();
      expect((await ext('POST', '/api/streamer/waypoint/cancel', device, { reason: 'bored' })).status).toBe(422);
      expect(await storedBalance(VIEWER)).toBe(3500);
    });
  });

  // =========================================================================
  // 6. Admin
  // =========================================================================

  describe('admin economy', () => {
    it('reports rate, reward, totals and ledger health', async () => {
      expect((await ext('GET', '/api/admin/economy', null)).status).toBe(401);

      await credit(VIEWER, 500);
      const q = await quote(VIEWER);
      await purchase(VIEWER, q.quoteId);
      await ext('POST', '/api/streamer/waypoint/cancel', await deviceToken(), { reason: 'unsafe' });

      const res = await admin('GET', '/api/admin/economy');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        paymentMode: 'gta_dollar',
        exchangeRate: 10,
        reward: { id: exchangeRewardId, title: EXCHANGE_TITLE, cost: 500, enabledOnTwitch: true },
        gtaPerRedemption: 5000,
        totals: { issued: 5000, spent: 1500, refunded: 1500, adjusted: 0, circulating: 5000, wallets: 1 },
        ledgerConsistent: true,
        pendingFulfillments: 0,
        failedFulfillments: 0,
        canceledExternally: 0,
      });
      expect(res.body.recent).toHaveLength(3);
      expect(res.body.recent[0]).toMatchObject({
        createdAt: expect.any(String),
        type: expect.any(String),
        amount: expect.any(Number),
        twitchUserId: VIEWER,
        balanceAfter: expect.any(Number),
      });

      // A balance written behind the ledger's back is reported, not hidden.
      const { query } = await import('../src/db/pool.js');
      await query('UPDATE gta_wallets SET balance = balance + 1 WHERE twitch_user_id = $1', [VIEWER]);
      expect((await admin('GET', '/api/admin/economy')).body.ledgerConsistent).toBe(false);
    });

    it('saves new exchange terms once Twitch has taken them', async () => {
      const res = await admin('PUT', '/api/admin/economy', {
        exchangeRewardCost: 600,
        gtaDollarsPerChannelPoint: 12,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        exchangeRate: 12,
        reward: { cost: 600 },
        gtaPerRedemption: 7200,
      });

      const { getCustomReward } = await import('../src/twitch/helix.js');
      const live = await getCustomReward(TEST_CHANNEL, exchangeRewardId);
      expect(live?.cost).toBe(600);
      expect(live?.prompt).toContain('1 ETH = 12 GTA$');

      const state = await ext('GET', '/api/ext/state', viewerToken(VIEWER));
      expect(state.body.economy).toMatchObject({ rewardCost: 600, exchangeRate: 12, gtaPerRedemption: 7200 });

      await credit(VIEWER, 600);
      expect(await storedBalance(VIEWER)).toBe(7200);
    });

    it('keeps the old cost when Twitch refuses the new one', async () => {
      const { failNextDevHelix } = await import('../src/twitch/devHelix.js');
      const { getSettings } = await import('../src/domain/settings.js');
      const { getCustomReward } = await import('../src/twitch/helix.js');
      failNextDevHelix('PATCH', '/channel_points/custom_rewards', 400);

      const res = await admin('PUT', '/api/admin/economy', { exchangeRewardCost: 700 });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error).toBe('provider_error');

      expect((await getSettings(TEST_CHANNEL)).exchangeRewardCost).toBe(500);
      expect((await getCustomReward(TEST_CHANNEL, exchangeRewardId))?.cost).toBe(500);

      for (const bad of [
        { exchangeRewardCost: 0 },
        { exchangeRewardCost: 1_000_001 },
        { gtaDollarsPerChannelPoint: 1001 },
        { gtaDollarsPerChannelPoint: 2.5 },
        { baseCost: 1 },
      ]) {
        expect((await admin('PUT', '/api/admin/economy', bad)).status).toBe(422);
      }
    });

    it('pushes new terms only once a running reward sync has finished', async () => {
      const { tryAcquireLock } = await import('../src/redis/lock.js');
      const { K } = await import('../src/redis/keys.js');
      const { getSettings } = await import('../src/domain/settings.js');
      const { getCustomReward } = await import('../src/twitch/helix.js');

      // Stands in for ensureExchangeReward, mid-way through reconciling.
      const sync = await tryAcquireLock(K.lockExchangeReward(TEST_CHANNEL), 30_000);
      expect(sync).not.toBeNull();
      try {
        const saving = admin('PUT', '/api/admin/economy', { exchangeRewardCost: 650 });

        // A save that leaves the exchange terms alone does not wait for it.
        const unrelated = await admin('PUT', '/api/admin/settings', { quotesPerMinute: 7 });
        expect(unrelated.status).toBe(200);

        await new Promise((r) => setTimeout(r, 300));
        expect((await getCustomReward(TEST_CHANNEL, exchangeRewardId))?.cost).toBe(500);
        expect((await getSettings(TEST_CHANNEL)).exchangeRewardCost).toBe(500);

        await sync!.release();
        const saved = await saving;
        expect(saved.status).toBe(200);
        expect(saved.body).toMatchObject({ reward: { cost: 650 }, settings: { exchangeRewardCost: 650 } });
        expect((await getCustomReward(TEST_CHANNEL, exchangeRewardId))?.cost).toBe(650);
      } finally {
        await sync?.release();
      }
    });

    it('reports a reward Twitch did not answer about as unknown, not as disabled', async () => {
      const { failNextDevHelix } = await import('../src/twitch/devHelix.js');
      failNextDevHelix('GET', '/channel_points/custom_rewards', 503);

      const res = await admin('GET', '/api/admin/economy');
      expect(res.status).toBe(200);
      expect(res.body.reward).toMatchObject({ id: exchangeRewardId, enabledOnTwitch: null });
      expect(res.body.rewardCheckError).toEqual(expect.any(String));
    });

    it('tells the admin console which unit prices are in', async () => {
      await quote(VIEWER);
      const state = await admin('GET', '/api/admin/state');
      expect(state.status).toBe(200);
      expect(state.body.paymentMode).toBe('gta_dollar');
      expect(state.body.quotes[0]).toMatchObject({ currency: 'GTA_DOLLAR', cost: 1500 });
    });

    it('creates the exchange reward after OAuth only on the configured channel', async () => {
      const { completeOAuth } = await import('../src/twitch/oauth.js');
      const { getExchangeReward } = await import('../src/twitch/exchangeReward.js');

      h.oauthUser = TEST_CHANNEL;
      const own = await completeOAuth('test-code');
      expect(own.exchangeReward).toMatchObject({ action: 'unchanged', reward: { id: exchangeRewardId } });

      // Somebody else connected (a moderator, an alt): an enabled exchange on
      // their channel would take its viewers' ETH for credits never booked.
      h.oauthUser = '900000002';
      const foreign = await completeOAuth('test-code');
      expect(foreign.exchangeReward).toBeNull();
      expect(foreign.warnings.join('\n')).toMatch(/exchange reward not created/);
      expect(await getExchangeReward('900000002')).toBeNull();
      expect(await count('SELECT count(*)::int AS n FROM gta_exchange_rewards')).toBe(1);
    });

    it('syncs the exchange reward: reconciles, adopts and recreates', async () => {
      const { query } = await import('../src/db/pool.js');
      const { deleteCustomReward, getCustomReward, updateCustomReward } = await import(
        '../src/twitch/helix.js'
      );
      const sync = () => admin('POST', '/api/admin/economy/exchange-reward/sync');

      expect((await sync()).body).toMatchObject({ action: 'unchanged', reward: { id: exchangeRewardId } });

      // Edited by hand in the Twitch dashboard: put back as configured.
      await updateCustomReward(TEST_CHANNEL, exchangeRewardId, { cost: 999, isEnabled: false });
      expect((await sync()).body).toMatchObject({
        action: 'updated',
        reward: { id: exchangeRewardId, cost: 500, isEnabled: true },
      });

      // Our record lost, the reward still on Twitch: the duplicate-title refusal
      // is the one case where it is found by title, among our own rewards.
      await query('DELETE FROM gta_exchange_rewards');
      expect((await sync()).body).toMatchObject({ action: 'adopted', reward: { id: exchangeRewardId } });

      // Deleted on Twitch: created again.
      await deleteCustomReward(TEST_CHANNEL, exchangeRewardId);
      const recreated = await sync();
      expect(recreated.body).toMatchObject({ action: 'created', reward: { title: EXCHANGE_TITLE, cost: 500 } });
      const newId = recreated.body.reward.id as string;
      expect(await getCustomReward(TEST_CHANNEL, newId)).toMatchObject({ is_enabled: true });
      expect(
        await count('SELECT count(*)::int AS n FROM gta_exchange_rewards WHERE twitch_reward_id = $1', [
          newId,
        ]),
      ).toBe(1);
    });
  });
});
