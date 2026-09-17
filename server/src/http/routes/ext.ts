import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../env.js';
import { PHUKET } from '../../domain/geo.js';
import { getSettings } from '../../domain/settings.js';
import { getQuote, toQuoteView } from '../../domain/quotes.js';
import { getPublicGps } from '../../domain/gps.js';
import { searchPlaces } from '../../maps/mapbox.js';
import {
  buildViewerState,
  cancelViewerQuote,
  confirmViewerQuote,
  createViewerQuote,
  expireStaleQuotes,
} from '../../domain/waypointFlow.js';
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

  app.post('/api/ext/quote/:id/cancel', async (req) => {
    const identity = requireExtIdentity(req);
    const userId = requireLinkedViewer(identity);
    const { id } = req.params as { id: string };

    await cancelViewerQuote(identity.channelId, userId, id);
    return { ok: true };
  });
}
