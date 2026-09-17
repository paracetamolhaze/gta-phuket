import { logger } from '../logger.js';
import { K } from '../redis/keys.js';
import { withLock } from '../redis/lock.js';
import { emitRealtime } from '../realtime/bus.js';
import { getWalkingRoute } from '../maps/mapbox.js';
import { activateSlotReward, activeTitle } from '../twitch/rewards.js';
import { getPublicGps, requireFreshGps } from './gps.js';
import { findRestrictedZone, haversineMeters, inBounds, sanitizeName } from './geo.js';
import { calculatePrice } from './pricing.js';
import {
  attachSlot,
  createQuote,
  findExpiredQuotes,
  getQuote,
  getViewerLiveQuote,
  setQuoteStatus,
  toQuoteView,
} from './quotes.js';
import { countFreeSlots, getSlot, leaseSlot, releaseSlot } from './slots.js';
import { getActiveWaypoint, getActiveWaypointView, hasActiveWaypoint } from './waypoints.js';
import { sanitizeRouteGeometry } from './privacy.js';
import { getSettings } from './settings.js';
import { AppError, type LatLng, type Quote, type QuoteView } from './types.js';

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
  const settings = await getSettings(channelId);
  const quote = await getQuote(quoteId);

  if (!quote || quote.channelId !== channelId) {
    throw new AppError('quote_not_found', 'Расчёт не найден', 404);
  }
  if (quote.twitchUserId !== twitchUserId) {
    throw new AppError('forbidden', 'Это чужой расчёт', 403);
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

/** Everything the extension needs in one round trip. */
export async function buildViewerState(channelId: string, identityLinked: boolean) {
  const settings = await getSettings(channelId);
  const [gps, waypoint, slots] = await Promise.all([
    getPublicGps(channelId, settings),
    getActiveWaypoint(channelId),
    countFreeSlots(channelId, settings.rewardSlotPoolSize),
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
  };
}
