import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../env.js';
import { PHUKET } from '../../domain/geo.js';
import { getSettings } from '../../domain/settings.js';
import { getQuote, toQuoteView } from '../../domain/quotes.js';
import { getGpsState, getPublicGps } from '../../domain/gps.js';
import { countFreeSlots } from '../../domain/slots.js';
import { loadBroadcasterTokens } from '../../twitch/tokens.js';
import { listEventSubSubscriptions } from '../../twitch/helix.js';
import { useDevHelix } from '../../twitch/devHelix.js';
import { getEconomyInfo } from '../../twitch/exchangeReward.js';
import { searchPlaces } from '../../maps/mapbox.js';
import {
  buildViewerState,
  cancelViewerQuote,
  confirmViewerQuote,
  createViewerQuote,
  expireStaleQuotes,
  purchaseViewerWaypoint,
} from '../../domain/waypointFlow.js';
import { buildWalletView } from '../../domain/wallet.js';
import { AppError } from '../../domain/types.js';
import { requireExtIdentity, requireLinkedViewer } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';

const quoteBodySchema = z.object({
  lat: z.number(),
  lng: z.number(),
  name: z.string().max(200).optional().nullable(),
  category: z.string().max(80).optional().nullable(),
});

const searchQuerySchema = z.object({ q: z.string().min(1).max(120) });

/**
 * A quote id and nothing else. Unknown keys (a `userId`, a `cost`) are
 * dropped, not honoured: the buyer and the price never come from the body.
 */
const purchaseBodySchema = z.object({ quoteId: z.string().min(1).max(64) });

export async function registerExtRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Map bootstrap. The public Mapbox token is meant to live in browsers; the
   * server token that pays for Directions is never sent here.
   */
  app.get('/api/ext/config', async (req) => {
    const identity = requireExtIdentity(req);
    return {
      mapboxToken: env.MAPBOX_PUBLIC_TOKEN,
      styleUrl: env.MAPBOX_STYLE_URL,
      bounds: PHUKET,
      channelId: identity.channelId,
    };
  });

  app.get('/api/ext/state', async (req) => {
    const identity = requireExtIdentity(req);
    return buildViewerState(identity.channelId, identity.userId !== null);
  });

  app.get('/api/ext/search', async (req) => {
    const identity = requireExtIdentity(req);
    const { q } = searchQuerySchema.parse(req.query);
    const settings = await getSettings(identity.channelId);

    await enforceRateLimit(
      'search',
      `${identity.channelId}:${identity.userId ?? identity.opaqueUserId}`,
      settings.searchesPerMinute,
    );

    const gps = await getPublicGps(identity.channelId, settings);
    const proximity = gps.lat !== null && gps.lng !== null ? { lat: gps.lat, lng: gps.lng } : null;

    const results = await searchPlaces(q, { proximity, bbox: PHUKET, limit: 8 });
    return { results };
  });

  /** Price a destination. Everything that matters is decided server-side. */
  app.post('/api/ext/quote', async (req) => {
    const identity = requireExtIdentity(req);
    const userId = requireLinkedViewer(identity);
    const settings = await getSettings(identity.channelId);

    await enforceRateLimit('quote', `${identity.channelId}:${userId}`, settings.quotesPerMinute);
    await expireStaleQuotes(identity.channelId);

    const body = quoteBodySchema.parse(req.body);
    return createViewerQuote({
      channelId: identity.channelId,
      twitchUserId: userId,
      twitchUserName: null,
      destination: { lat: body.lat, lng: body.lng },
      destinationName: body.name ?? null,
      destinationCategory: body.category ?? null,
    });
  });

  app.get('/api/ext/quote/:id', async (req) => {
    const identity = requireExtIdentity(req);
    const userId = requireLinkedViewer(identity);
    const { id } = req.params as { id: string };

    const quote = await getQuote(id);
    if (!quote || quote.channelId !== identity.channelId) {
      throw new AppError('quote_not_found', 'Расчёт не найден', 404);
    }
    if (quote.twitchUserId !== userId) {
      throw new AppError('forbidden', 'Это чужой расчёт', 403);
    }
    return toQuoteView(quote, await getSettings(identity.channelId));
  });

  /**
   * Put the reward in front of this viewer. Still no charge: Twitch has no API
   * to take points, so the viewer must redeem the reward themselves.
   */
  app.post('/api/ext/quote/:id/confirm', async (req) => {
    const identity = requireExtIdentity(req);
    const userId = requireLinkedViewer(identity);
    const { id } = req.params as { id: string };

    await enforceRateLimit('confirm', `${identity.channelId}:${userId}`, 20);
    return confirmViewerQuote(identity.channelId, userId, id);
  });

  /**
   * The viewer's own GTA$ wallet. Whose wallet is decided by the verified
   * token alone; a `userId` in the query string is ignored like any other
   * unknown parameter. Reading never creates a wallet.
   *
   * Capped per viewer: each read is several queries on the pool that credits,
   * purchases and refunds share. The overlay re-reads on a handful of events
   * (open, reconnect, wallet:updated, a purchase), far below this, and keeps
   * its last balance when a read is refused.
   */
  app.get('/api/ext/wallet', async (req) => {
    const identity = requireExtIdentity(req);
    const userId = requireLinkedViewer(identity);
    await enforceRateLimit('wallet', `${identity.channelId}:${userId}`, 60);
    const economy = await getEconomyInfo(identity.channelId);
    return buildWalletView(identity.channelId, userId, economy);
  });

  /** One click, one atomic GTA$ purchase of a quoted waypoint. */
  app.post('/api/ext/waypoints/purchase', async (req) => {
    const identity = requireExtIdentity(req);
    const userId = requireLinkedViewer(identity);

    await enforceRateLimit('purchase', `${identity.channelId}:${userId}`, 10);
    const { quoteId } = purchaseBodySchema.parse(req.body ?? {});
    return purchaseViewerWaypoint(identity.channelId, userId, quoteId);
  });

  app.post('/api/ext/quote/:id/cancel', async (req) => {
    const identity = requireExtIdentity(req);
    const userId = requireLinkedViewer(identity);
    const { id } = req.params as { id: string };

    await cancelViewerQuote(identity.channelId, userId, id);
    return { ok: true };
  });

  /**
   * Status for the Twitch broadcaster Config surface (`config.html`).
   *
   * Deliberately booleans and counters only. The broadcaster is trusted, but
   * this response travels to a page Twitch frames, so it carries no token, no
   * secret, no OAuth material and no coordinates — just enough to answer "is
   * the thing wired up", with the real controls living in /admin.
   */
  app.get('/api/ext/broadcaster/status', async (req) => {
    const identity = requireExtIdentity(req);
    if (identity.role !== 'broadcaster') {
      throw new AppError('forbidden', 'Эта страница только для владельца канала', 403);
    }

    const channelId = identity.channelId;
    const settings = await getSettings(channelId);
    const [gps, counts, tokens] = await Promise.all([
      getGpsState(channelId, settings),
      countFreeSlots(channelId, settings.rewardSlotPoolSize),
      loadBroadcasterTokens(channelId),
    ]);

    let eventsubCount = 0;
    if (tokens || useDevHelix()) {
      try {
        eventsubCount = (await listEventSubSubscriptions()).filter(
          (s) => s.condition.broadcaster_user_id === channelId,
        ).length;
      } catch {
        eventsubCount = -1; // "could not ask Twitch", distinct from "none"
      }
    }

    return {
      channelId,
      serverTime: Date.now(),
      backend: { ok: true, devMode: env.devModeEnabled },
      twitch: {
        connected: Boolean(tokens),
        usingLocalStub: useDevHelix(),
        scopes: tokens?.scopes ?? [],
        eventsubCount,
      },
      gps: { status: gps.status, ageMs: gps.ageMs, accuracy: gps.sample?.accuracy ?? null },
      mapboxConfigured: Boolean(env.MAPBOX_SERVER_TOKEN || env.MAPBOX_PUBLIC_TOKEN),
      waypointsOpen: settings.waypointsOpen,
      slots: counts,
      adminUrl: `${env.PUBLIC_WEB_URL.replace(/\/$/, '')}/admin.html`,
    };
  });
}
