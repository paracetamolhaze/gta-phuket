import type { PoolClient } from 'pg';
import { withTransaction } from '../db/pool.js';
import { logger } from '../logger.js';
import { K } from '../redis/keys.js';
import { withLock } from '../redis/lock.js';
import { emitRealtime, emitToViewer } from '../realtime/bus.js';
import { getWalkingRoute } from '../maps/mapbox.js';
import { activateSlotReward, activeTitle } from '../twitch/rewards.js';
import { getEconomyInfo } from '../twitch/exchangeReward.js';
import { getPublicGps, requireFreshGps } from './gps.js';
import { findRestrictedZone, haversineMeters, inBounds, sanitizeName } from './geo.js';
import { calculatePrice } from './pricing.js';
import {
  attachSlot,
  createQuote,
  findExpiredQuotes,
  getQuote,
  getViewerLiveQuote,
  lockQuote,
  refreshQuoteCache,
  setQuoteStatus,
  toQuoteView,
} from './quotes.js';
import { countFreeSlots, getSlot, leaseSlot, releaseSlot } from './slots.js';
import {
  getActiveWaypoint,
  getActiveWaypointView,
  getWaypointByQuote,
  hasActiveWaypoint,
  insertActiveWaypoint,
  primeLiveNav,
  toView,
} from './waypoints.js';
import { sanitizeRouteGeometry } from './privacy.js';
import { getSettings } from './settings.js';
import { paymentMode } from './paymentMode.js';
import { debitForWaypoint, getBalance, isUniqueViolation, lockWallet } from './wallet.js';
import {
  AppError,
  type ActiveWaypointView,
  type ChannelSettings,
  type LatLng,
  type Quote,
  type QuoteView,
  type ViewerStatePayload,
  type Waypoint,
} from './types.js';

export interface QuoteRequest {
  channelId: string;
  twitchUserId: string;
  twitchUserName: string | null;
  destination: LatLng;
  destinationName?: string | null;
  destinationCategory?: string | null;
}

/**
 * Build a priced walking route from where the streamer actually is.
 *
 * Order matters: the cheap local rejections run before anything that costs a
 * Mapbox call, and the price is only ever produced here, from the router's own
 * distance.
 */
export async function createViewerQuote(req: QuoteRequest): Promise<QuoteView> {
  const settings = await getSettings(req.channelId);

  if (!settings.waypointsOpen) {
    throw new AppError('waypoints_closed', 'Приём точек сейчас закрыт', 409);
  }
  if (await hasActiveWaypoint(req.channelId)) {
    throw new AppError(
      'waypoint_active',
      'Сейчас выполняется задание. Следующую точку можно будет выбрать после завершения',
      409,
    );
  }

  const destination = req.destination;
  if (!Number.isFinite(destination.lat) || !Number.isFinite(destination.lng)) {
    throw new AppError('invalid_request', 'Некорректные координаты', 422);
  }
  if (!inBounds(destination)) {
    throw new AppError('out_of_bounds', 'Эта точка вне Пхукета', 422);
  }

  const zone = findRestrictedZone(destination, settings.restrictedZones);
  if (zone) {
    throw new AppError('restricted_zone', 'Эта зона закрыта стримером', 422, { zone: zone.name });
  }

  // Origin comes from the server's GPS state, never from the request body.
  const origin = await requireFreshGps(req.channelId, settings);
  const originPoint: LatLng = { lat: origin.lat, lng: origin.lng };

  // A straight line can only ever be shorter than the walk, so this rejects
  // hopeless destinations without paying for a Directions call.
  const crowFlies = haversineMeters(originPoint, destination);
  if (crowFlies > settings.maxWalkingDistanceMeters) {
    throw new AppError('too_far', 'Слишком далеко для пешего задания', 422, {
      straightLineMeters: Math.round(crowFlies),
      maxWalkingDistanceMeters: settings.maxWalkingDistanceMeters,
    });
  }

  const route = await getWalkingRoute(originPoint, destination);

  // The router snaps to the nearest pedestrian way. A tap in the sea, on a
  // rooftop or inside a closed compound lands far from anything walkable.
  if (route.snapDistanceMeters > settings.maxSnapDistanceMeters) {
    throw new AppError('too_far_from_walkable', 'Сюда нельзя построить пеший маршрут', 422, {
      snapDistanceMeters: Math.round(route.snapDistanceMeters),
    });
  }
  if (route.distanceMeters > settings.maxWalkingDistanceMeters) {
    throw new AppError('too_far', 'Слишком далеко для пешего задания', 422, {
      walkingDistanceMeters: Math.round(route.distanceMeters),
      maxWalkingDistanceMeters: settings.maxWalkingDistanceMeters,
    });
  }

  const price = calculatePrice(route.distanceMeters, settings);

  const name = sanitizeName(req.destinationName, 80) || 'Точка на карте';

  // Supersede-then-create must be atomic per viewer, otherwise two parallel
  // taps both see "no live quote" and each walks off with a reward slot.
  // The partial unique index quotes_one_live_per_viewer is the real backstop;
  // this lock is what turns a hard 23505 into an orderly replacement.
  const quote = await withLock(
    K.viewerQuote(req.channelId, req.twitchUserId),
    async () => {
      const existing = await getViewerLiveQuote(req.channelId, req.twitchUserId);
      if (existing) await releaseQuoteResources(existing, 'superseded by a new quote');

      return createQuote({
        channelId: req.channelId,
        twitchUserId: req.twitchUserId,
        twitchUserName: req.twitchUserName,
        origin: originPoint,
        destination,
        destinationName: name,
        destinationCategory: sanitizeName(req.destinationCategory, 40) || null,
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        routeGeometry: route.geometry,
        price,
        ttlSeconds: settings.quoteTtlSeconds,
        // Priced in whatever the channel sells in right now. The formula is
        // the same either way; only its unit differs.
        currency: paymentMode() === 'gta_dollar' ? 'GTA_DOLLAR' : 'CHANNEL_POINTS',
      });
    },
    {
      ttlMs: 15_000,
      waitMs: 5000,
      onBusy: () => new AppError('rate_limited', 'Подожди секунду и попробуй снова', 429),
    },
  );

  emitRealtime(
    req.channelId,
    'waypoint:quoted',
    { quoteId: quote.id, code: quote.code, destinationName: quote.destinationName, cost: price.cost },
    'trusted',
  );

  return toQuoteView(quote, settings);
}

/**
 * Reserve a reward slot and put it in front of this viewer at the quoted price.
 * Nothing is charged here — Twitch charges only when the viewer redeems.
 */
export async function confirmViewerQuote(
  channelId: string,
  twitchUserId: string,
  quoteId: string,
): Promise<QuoteView> {
  // In GTA$ mode the slot pool is left exactly as it is: nothing is leased and
  // no reward is put in front of anyone. Waypoints are bought with
  // POST /api/ext/waypoints/purchase instead.
  if (paymentMode() !== 'channel_points_reward') {
    throw new AppError('payment_mode', 'Точки оплачиваются GTA$ прямо в карте', 409);
  }

  const settings = await getSettings(channelId);
  const quote = await getQuote(quoteId);

  if (!quote || quote.channelId !== channelId) {
    throw new AppError('quote_not_found', 'Расчёт не найден', 404);
  }
  if (quote.twitchUserId !== twitchUserId) {
    throw new AppError('forbidden', 'Это чужой расчёт', 403);
  }
  if (quote.currency !== 'CHANNEL_POINTS') {
    // Priced in GTA$ before a switch back to the legacy mode.
    throw new AppError('payment_mode', 'Этот расчёт оплачивается GTA$', 409);
  }
  if (quote.status === 'AWAITING_REDEMPTION') {
    // Idempotent: a double tap returns the same instruction card.
    return toQuoteView(quote, settings);
  }
  if (quote.status !== 'QUOTED') {
    throw new AppError('quote_conflict', 'Этот расчёт уже использован', 409);
  }
  if (quote.expiresAt <= Date.now()) {
    await setQuoteStatus(quote.id, 'EXPIRED', ['QUOTED']);
    throw new AppError('quote_expired', 'Расчёт устарел. Выбери точку заново', 409);
  }
  if (await hasActiveWaypoint(channelId)) {
    throw new AppError(
      'waypoint_active',
      'Сейчас выполняется задание. Следующую точку можно будет выбрать после завершения',
      409,
    );
  }

  const slot = await leaseSlot(channelId, quote.id, twitchUserId, settings.rewardSlotPoolSize);
  if (!slot) {
    throw new AppError(
      'no_free_slots',
      'Сейчас слишком много запросов. Попробуй через несколько секунд',
      503,
    );
  }

  let updated: Quote | null = null;
  try {
    await activateSlotReward(channelId, slot, quote.code, quote.channelPointsCost, quote.destinationName);
    updated = await attachSlot(quote.id, slot.id);
    if (!updated) {
      // The quote expired or was cancelled between the checks and the lease.
      throw new AppError('quote_expired', 'Расчёт устарел. Выбери точку заново', 409);
    }
  } catch (err) {
    await releaseSlot(channelId, slot, 'confirm failed').catch(() => undefined);
    throw err;
  }

  emitRealtime(channelId, 'waypoint:awaiting_payment', {
    quoteId: updated.id,
    code: updated.code,
    rewardTitle: activeTitle(updated.code),
    cost: updated.channelPointsCost,
  });
  await emitSlotCounts(channelId);

  return toQuoteView(updated, settings);
}

export async function cancelViewerQuote(
  channelId: string,
  twitchUserId: string,
  quoteId: string,
  reason = 'canceled by viewer',
): Promise<void> {
  const quote = await getQuote(quoteId);
  if (!quote || quote.channelId !== channelId) return;
  if (quote.twitchUserId !== twitchUserId) {
    throw new AppError('forbidden', 'Это чужой расчёт', 403);
  }
  await releaseQuoteResources(quote, reason);
}

/** Free whatever a dead quote is holding, and tell Twitch to hide the reward. */
export async function releaseQuoteResources(quote: Quote, reason: string): Promise<void> {
  const changed = await setQuoteStatus(quote.id, 'CANCELED', ['QUOTED', 'AWAITING_REDEMPTION']);
  if (!changed) return;

  if (quote.slotId) {
    const slot = await getSlot(quote.slotId);
    if (slot && slot.status === 'RESERVED') {
      await releaseSlot(quote.channelId, slot, reason).catch((err) =>
        logger.warn({ err, slotId: slot.id }, 'slot release failed'),
      );
      await emitSlotCounts(quote.channelId);
    }
  }

  emitRealtime(quote.channelId, 'quote:canceled', { quoteId: quote.id, reason });
}

/** Sweep quotes past their deadline; runs on a timer and before each new quote. */
export async function expireStaleQuotes(channelId: string): Promise<number> {
  const expired = await findExpiredQuotes(channelId);
  for (const quote of expired) {
    const changed = await setQuoteStatus(quote.id, 'EXPIRED', ['QUOTED', 'AWAITING_REDEMPTION']);
    if (!changed) continue;
    if (quote.slotId) {
      const slot = await getSlot(quote.slotId);
      if (slot && slot.status === 'RESERVED') {
        await releaseSlot(channelId, slot, 'quote expired').catch(() => undefined);
      }
    }
    emitRealtime(channelId, 'quote:canceled', { quoteId: quote.id, reason: 'quote expired' });
  }
  if (expired.length) await emitSlotCounts(channelId);
  return expired.length;
}

export async function emitSlotCounts(channelId: string): Promise<void> {
  const settings = await getSettings(channelId);
  const counts = await countFreeSlots(channelId, settings.rewardSlotPoolSize);
  emitRealtime(channelId, 'slots:update', counts);
}

// ---------------------------------------------------------------------------
// GTA$ purchase
// ---------------------------------------------------------------------------

export interface PurchaseResult {
  ok: true;
  /** False when this quote had already been bought: same waypoint, no second charge. */
  charged: boolean;
  /** Viewer copy: the route is privacy-filtered like every other viewer feed. */
  waypoint: ActiveWaypointView;
  /**
   * Where that waypoint stands now. Always ACTIVE on a fresh charge; a repeat
   * (a retry after a lost response) can come after the job was completed or
   * cancelled, and the viewer must not be shown a finished job as running.
   */
  waypointStatus: 'ACTIVE' | 'COMPLETED' | 'CANCELED';
  balance: number;
  cost: number;
}

type PurchaseStep =
  | { kind: 'charged'; waypoint: Waypoint; cost: number; balance: number; transactionId: string }
  | { kind: 'already'; cost: number }
  | { kind: 'expired' }
  | { kind: 'price_changed'; quoted: number; current: number };

function waypointActiveError(): AppError {
  return new AppError(
    'waypoint_active',
    'Сейчас выполняется задание. Следующую точку можно будет выбрать после завершения',
    409,
  );
}

function viewerCopy(view: ActiveWaypointView, settings: ChannelSettings): ActiveWaypointView {
  return {
    ...view,
    routeGeometry: sanitizeRouteGeometry(view.routeGeometry, settings) ?? view.routeGeometry,
    liveRouteGeometry: null,
  };
}

/**
 * Everything that decides a purchase, in one transaction with the quote row
 * locked. Outcomes that must leave a trace (an expired or repriced quote is
 * closed) are returned rather than thrown, so that trace commits; everything
 * else throws and rolls back, which is what leaves the balance untouched.
 */
async function purchaseInTransaction(
  client: PoolClient,
  input: { channelId: string; twitchUserId: string; quoteId: string; settings: ChannelSettings },
): Promise<PurchaseStep> {
  const { channelId, twitchUserId, settings } = input;

  const quote = await lockQuote(client, input.quoteId);
  if (!quote || quote.channelId !== channelId) {
    throw new AppError('quote_not_found', 'Расчёт не найден', 404);
  }
  if (quote.twitchUserId !== twitchUserId) {
    throw new AppError('forbidden', 'Это чужой расчёт', 403);
  }

  if (quote.status === 'PAID') {
    const { rows } = await client.query<{ amount: number }>(
      `SELECT amount FROM gta_wallet_transactions
        WHERE quote_id = $1 AND type = 'WAYPOINT_DEBIT' AND twitch_user_id = $2`,
      [quote.id, twitchUserId],
    );
    // A double click, a retry after a lost response: same waypoint, no charge.
    if (rows[0]) return { kind: 'already', cost: -rows[0].amount };
  }
  if (quote.status !== 'QUOTED') {
    throw new AppError('quote_conflict', 'Этот расчёт уже использован', 409);
  }
  if (quote.expiresAt <= Date.now()) {
    await client.query(
      `UPDATE waypoint_quotes SET status = 'EXPIRED' WHERE id = $1 AND status = 'QUOTED'`,
      [quote.id],
    );
    return { kind: 'expired' };
  }
  if (quote.currency !== 'GTA_DOLLAR') {
    throw new AppError('payment_mode', 'Этот расчёт нельзя оплатить GTA$', 409);
  }

  // The quote froze a price; the admin may have changed pricing since. Never
  // charge a number the formula no longer produces: the quote dies and the
  // viewer asks again, and sees the new price before paying it.
  const current = calculatePrice(quote.routeDistanceMeters, settings).cost;
  if (current !== quote.channelPointsCost) {
    await client.query(
      `UPDATE waypoint_quotes SET status = 'CANCELED' WHERE id = $1 AND status = 'QUOTED'`,
      [quote.id],
    );
    return { kind: 'price_changed', quoted: quote.channelPointsCost, current };
  }

  if (!settings.waypointsOpen) {
    throw new AppError('waypoints_closed', 'Приём точек сейчас закрыт', 409);
  }
  const active = await client.query(
    `SELECT 1 FROM waypoints WHERE channel_id = $1 AND status = 'ACTIVE' LIMIT 1`,
    [channelId],
  );
  if (active.rows.length > 0) throw waypointActiveError();

  const cost = quote.channelPointsCost;
  const balance = await lockWallet(client, channelId, twitchUserId);
  if (balance < cost) {
    throw new AppError('insufficient_funds', 'Не хватает GTA$', 402, { balance, cost });
  }

  const paid = await client.query(
    `UPDATE waypoint_quotes SET status = 'PAID' WHERE id = $1 AND status = 'QUOTED' RETURNING id`,
    [quote.id],
  );
  if (!paid.rows[0]) throw new Error('quote changed state under its row lock');

  const waypoint = await insertActiveWaypoint(client, quote);
  const debit = await debitForWaypoint(client, {
    channelId,
    twitchUserId,
    quoteId: quote.id,
    waypointId: waypoint.id,
    cost,
    balanceBefore: balance,
  });
  return { kind: 'charged', waypoint, cost, ...debit };
}

/**
 * Buy a quoted waypoint with GTA$, in one click and one transaction.
 *
 * The body carries a quote id and nothing else: the buyer is the verified
 * token's user, and the price, route and deadline are the quote's own. The
 * per-channel activation lock serialises this with the legacy redemption
 * path; the quote row lock, the wallet row lock and the unique indexes make a
 * second charge or a second active waypoint impossible regardless.
 */
export async function purchaseViewerWaypoint(
  channelId: string,
  twitchUserId: string,
  quoteId: string,
): Promise<PurchaseResult> {
  return withLock(
    K.lockActivation(channelId),
    async (): Promise<PurchaseResult> => {
      const settings = await getSettings(channelId);

      let step: PurchaseStep;
      try {
        step = await withTransaction((client) =>
          purchaseInTransaction(client, { channelId, twitchUserId, quoteId, settings }),
        );
      } catch (err) {
        if (isUniqueViolation(err, 'waypoints_one_active_per_channel')) throw waypointActiveError();
        if (
          isUniqueViolation(err, 'gta_tx_one_debit_per_quote') ||
          isUniqueViolation(err, 'waypoints_one_per_quote')
        ) {
          // Another transaction bought this very quote first.
          step = { kind: 'already', cost: (await getQuote(quoteId))?.channelPointsCost ?? 0 };
        } else {
          throw err;
        }
      }

      if (step.kind === 'expired') {
        await refreshQuoteCache(quoteId);
        emitRealtime(channelId, 'quote:canceled', { quoteId, reason: 'quote expired' });
        throw new AppError('quote_expired', 'Расчёт устарел. Выбери точку заново', 409);
      }
      if (step.kind === 'price_changed') {
        await refreshQuoteCache(quoteId);
        emitRealtime(channelId, 'quote:canceled', { quoteId, reason: 'price changed' });
        throw new AppError('price_changed', 'Цена изменилась. Выбери точку заново', 409, {
          quoted: step.quoted,
          current: step.current,
        });
      }
      if (step.kind === 'already') {
        const waypoint = await getWaypointByQuote(quoteId);
        if (!waypoint) throw new AppError('quote_conflict', 'Этот расчёт уже использован', 409);
        return {
          ok: true,
          charged: false,
          waypoint: viewerCopy(toView(waypoint, null), settings),
          waypointStatus:
            waypoint.status === 'COMPLETED' || waypoint.status === 'CANCELED' ? waypoint.status : 'ACTIVE',
          balance: await getBalance(channelId, twitchUserId),
          cost: step.cost,
        };
      }

      // Committed. Side effects only from here, and none of them may turn a
      // completed purchase into an error response.
      const { waypoint, cost, balance, transactionId } = step;
      const view = toView(waypoint, null);
      try {
        await primeLiveNav(waypoint);
        await refreshQuoteCache(quoteId);
      } catch (err) {
        logger.warn({ err, waypointId: waypoint.id }, 'post-purchase cache update failed');
      }
      emitRealtime(channelId, 'waypoint:activated', view, 'trusted');
      emitRealtime(channelId, 'waypoint:activated', viewerCopy(view, settings), 'viewers');
      emitToViewer(channelId, twitchUserId, 'wallet:updated', {
        type: 'WAYPOINT_DEBIT',
        amount: -cost,
        balance,
        transactionId,
      });
      emitRealtime(
        channelId,
        'waypoint:purchased',
        { waypointId: waypoint.id, quoteId, userId: twitchUserId, cost, currency: 'GTA_DOLLAR' },
        'trusted',
      );
      logger.info(
        { waypointId: waypoint.id, quoteId, user: twitchUserId, cost, balance },
        'waypoint bought with GTA$',
      );

      return {
        ok: true,
        charged: true,
        waypoint: viewerCopy(view, settings),
        waypointStatus: 'ACTIVE',
        balance,
        cost,
      };
    },
    {
      ttlMs: 20_000,
      waitMs: 10_000,
      onBusy: () => new AppError('rate_limited', 'Подожди секунду и попробуй снова', 429),
    },
  );
}

/** Everything the extension needs in one round trip. */
export async function buildViewerState(
  channelId: string,
  identityLinked: boolean,
): Promise<ViewerStatePayload> {
  const settings = await getSettings(channelId);
  const [gps, waypoint, slots, economy] = await Promise.all([
    getPublicGps(channelId, settings),
    getActiveWaypoint(channelId),
    countFreeSlots(channelId, settings.rewardSlotPoolSize),
    getEconomyInfo(channelId, settings),
  ]);

  const activeWaypoint = waypoint ? await getActiveWaypointView(channelId) : null;
  if (activeWaypoint) {
    activeWaypoint.routeGeometry =
      sanitizeRouteGeometry(activeWaypoint.routeGeometry, settings) ?? activeWaypoint.routeGeometry;
    activeWaypoint.liveRouteGeometry = sanitizeRouteGeometry(
      activeWaypoint.liveRouteGeometry,
      settings,
    );
  }

  return {
    channelId,
    serverTime: Date.now(),
    waypointsOpen: settings.waypointsOpen,
    gps,
    activeWaypoint,
    identityLinked,
    limits: {
      maxWalkingDistanceMeters: settings.maxWalkingDistanceMeters,
      quoteTtlSeconds: settings.quoteTtlSeconds,
    },
    slots,
    paymentMode: paymentMode(),
    economy,
  };
}
