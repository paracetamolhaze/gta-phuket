import { randomUUID, randomInt } from 'node:crypto';
import { query } from '../db/pool.js';
import { AppError } from './types.js';
import { redis } from '../redis/client.js';
import { K } from '../redis/keys.js';
import { activeTitle } from '../twitch/rewards.js';
import { sanitizeRouteGeometry } from './privacy.js';
import type {
  ChannelSettings,
  LatLng,
  PriceBreakdown,
  Quote,
  QuoteStatus,
  QuoteView,
} from './types.js';

/** No 0/O/1/I/L — the viewer has to read this off the screen and find it in a menu. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function generateCode(length = 4): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

interface QuoteRow {
  id: string;
  code: string;
  channel_id: string;
  twitch_user_id: string;
  twitch_user_name: string | null;
  origin_lat: number;
  origin_lng: number;
  dest_lat: number;
  dest_lng: number;
  dest_name: string;
  dest_category: string | null;
  distance_meters: number;
  duration_seconds: number;
  route_geometry: string;
  cost: number;
  status: string;
  slot_id: string | null;
  created_at: Date;
  expires_at: Date;
}

function rowToQuote(row: QuoteRow): Quote {
  return {
    id: row.id,
    code: row.code,
    channelId: row.channel_id,
    twitchUserId: row.twitch_user_id,
    twitchUserName: row.twitch_user_name,
    origin: { lat: row.origin_lat, lng: row.origin_lng },
    destination: { lat: row.dest_lat, lng: row.dest_lng },
    destinationName: row.dest_name,
    destinationCategory: row.dest_category,
    routeDistanceMeters: row.distance_meters,
    routeDurationSeconds: row.duration_seconds,
    routeGeometry: row.route_geometry,
    channelPointsCost: row.cost,
    status: row.status as QuoteStatus,
    slotId: row.slot_id,
    createdAt: row.created_at.getTime(),
    expiresAt: row.expires_at.getTime(),
  };
}

/**
 * `settings` is required for anything that reaches a viewer: the route
 * polyline starts at the streamer's exact position and must be put through the
 * privacy filter first. Omit it only for trusted output.
 */
export function toQuoteView(quote: Quote, settings?: ChannelSettings): QuoteView {
  return {
    quoteId: quote.id,
    code: quote.code,
    destinationName: quote.destinationName,
    destinationCategory: quote.destinationCategory,
    destination: quote.destination,
    distanceMeters: Math.round(quote.routeDistanceMeters),
    durationSeconds: Math.round(quote.routeDurationSeconds),
    cost: quote.channelPointsCost,
    expiresAt: quote.expiresAt,
    status: quote.status,
    routeGeometry: settings
      ? (sanitizeRouteGeometry(quote.routeGeometry, settings) ?? quote.routeGeometry)
      : quote.routeGeometry,
    rewardTitle: quote.status === 'AWAITING_REDEMPTION' ? activeTitle(quote.code) : null,
  };
}

export interface CreateQuoteInput {
  channelId: string;
  twitchUserId: string;
  twitchUserName: string | null;
  origin: LatLng;
  destination: LatLng;
  destinationName: string;
  destinationCategory: string | null;
  distanceMeters: number;
  durationSeconds: number;
  routeGeometry: string;
  price: PriceBreakdown;
  ttlSeconds: number;
}

/**
 * The price is frozen here. Later GPS movement does not change what the viewer
 * was quoted; when the quote expires they get a new route and a new price.
 */
export async function createQuote(input: CreateQuoteInput): Promise<Quote> {
  const id = randomUUID();
  const expiresAt = Date.now() + input.ttlSeconds * 1000;

  // The unique index on (channel_id, code) for live quotes makes a collision a
  // conflict rather than a mix-up; retry with a fresh code.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = generateCode();
    try {
      const { rows } = await query<QuoteRow>(
        `INSERT INTO waypoint_quotes
           (id, code, channel_id, twitch_user_id, twitch_user_name,
            origin_lat, origin_lng, dest_lat, dest_lng, dest_name, dest_category,
            distance_meters, duration_seconds, route_geometry, cost, price_breakdown,
            status, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,'QUOTED',
                 to_timestamp($17 / 1000.0))
         RETURNING *`,
        [
          id,
          code,
          input.channelId,
          input.twitchUserId,
          input.twitchUserName,
          input.origin.lat,
          input.origin.lng,
          input.destination.lat,
          input.destination.lng,
          input.destinationName,
          input.destinationCategory,
          input.distanceMeters,
          input.durationSeconds,
          input.routeGeometry,
          input.price.cost,
          JSON.stringify(input.price),
          expiresAt,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error('insert returned no row');
      const quote = rowToQuote(row);
      await cacheQuote(quote);
      return quote;
    } catch (err) {
      lastErr = err;
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code !== '23505') throw err;
      // A code collision is worth another spin; a second live quote for the
      // same viewer is not — that is the per-viewer guard doing its job.
      if (pgErr.constraint === 'quotes_one_live_per_viewer') {
        throw new AppError('quote_conflict', 'У тебя уже есть активный расчёт', 409);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('could not allocate a quote code');
}

async function cacheQuote(quote: Quote): Promise<void> {
  const ttl = Math.max(5, Math.ceil((quote.expiresAt - Date.now()) / 1000) + 120);
  await redis.set(K.quote(quote.id), JSON.stringify(quote), 'EX', ttl);
}

export async function getQuote(quoteId: string): Promise<Quote | null> {
  const { rows } = await query<QuoteRow>('SELECT * FROM waypoint_quotes WHERE id = $1', [quoteId]);
  const row = rows[0];
  return row ? rowToQuote(row) : null;
}

export async function getQuoteBySlot(slotId: string): Promise<Quote | null> {
  const { rows } = await query<QuoteRow>(
    `SELECT * FROM waypoint_quotes
      WHERE slot_id = $1 AND status = 'AWAITING_REDEMPTION'
      ORDER BY created_at DESC LIMIT 1`,
    [slotId],
  );
  const row = rows[0];
  return row ? rowToQuote(row) : null;
}

/**
 * Move QUOTED -> AWAITING_REDEMPTION and attach the reserved slot.
 * The WHERE clause makes this a compare-and-set: a double-confirm loses.
 */
export async function attachSlot(quoteId: string, slotId: string): Promise<Quote | null> {
  const { rows } = await query<QuoteRow>(
    `UPDATE waypoint_quotes
        SET status = 'AWAITING_REDEMPTION', slot_id = $2
      WHERE id = $1 AND status = 'QUOTED' AND expires_at > now()
      RETURNING *`,
    [quoteId, slotId],
  );
  const row = rows[0];
  if (!row) return null;
  const quote = rowToQuote(row);
  await cacheQuote(quote);
  return quote;
}

export async function setQuoteStatus(
  quoteId: string,
  next: QuoteStatus,
  allowedFrom: QuoteStatus[],
): Promise<Quote | null> {
  const { rows } = await query<QuoteRow>(
    `UPDATE waypoint_quotes SET status = $2
      WHERE id = $1 AND status = ANY($3::text[])
      RETURNING *`,
    [quoteId, next, allowedFrom],
  );
  const row = rows[0];
  if (!row) return null;
  const quote = rowToQuote(row);
  await cacheQuote(quote);
  return quote;
}

export async function listRecentQuotes(channelId: string, limit = 15): Promise<Quote[]> {
  const { rows } = await query<QuoteRow>(
    'SELECT * FROM waypoint_quotes WHERE channel_id = $1 ORDER BY created_at DESC LIMIT $2',
    [channelId, limit],
  );
  return rows.map(rowToQuote);
}

/** The quote a viewer is currently holding, if any. */
export async function getViewerLiveQuote(
  channelId: string,
  twitchUserId: string,
): Promise<Quote | null> {
  const { rows } = await query<QuoteRow>(
    `SELECT * FROM waypoint_quotes
      WHERE channel_id = $1 AND twitch_user_id = $2
        AND status IN ('QUOTED', 'AWAITING_REDEMPTION')
        AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [channelId, twitchUserId],
  );
  const row = rows[0];
  return row ? rowToQuote(row) : null;
}

/** Quotes whose deadline has passed and that still hold a slot. */
export async function findExpiredQuotes(channelId: string): Promise<Quote[]> {
  const { rows } = await query<QuoteRow>(
    `SELECT * FROM waypoint_quotes
      WHERE channel_id = $1
        AND status IN ('QUOTED', 'AWAITING_REDEMPTION')
        AND expires_at <= now()`,
    [channelId],
  );
  return rows.map(rowToQuote);
}

export function isExpired(quote: Quote, now = Date.now()): boolean {
  return quote.expiresAt <= now;
}
