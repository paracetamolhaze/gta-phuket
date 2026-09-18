import { randomBytes } from 'node:crypto';
import { query } from '../db/pool.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { AppError } from '../domain/types.js';
import { getSettings } from '../domain/settings.js';
import {
  BROADCASTER_SCOPES,
  exchangeCodeForTokens,
  storeBroadcasterTokens,
  validateToken,
} from './tokens.js';
import { ensureRewardPool } from './rewards.js';
import { ensureEventSubSubscriptions } from './eventsub.js';
import { ensureExchangeReward, type EnsureExchangeRewardResult } from './exchangeReward.js';

const AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';
const STATE_TTL_MINUTES = 10;

export function redirectUri(): string {
  return `${env.PUBLIC_API_URL.replace(/\/$/, '')}/api/oauth/twitch/callback`;
}

/** Only our own web origin may be redirected to after the callback. */
export function safeRedirect(target: string | null | undefined): string | null {
  if (!target) return null;
  const base = env.PUBLIC_WEB_URL.replace(/\/$/, '');
  try {
    const url = new URL(target, base);
    return url.origin === new URL(base).origin ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function createOAuthState(redirectTo: string | null): Promise<string> {
  const state = randomBytes(24).toString('base64url');
  await query('INSERT INTO oauth_states (state, redirect_to) VALUES ($1, $2)', [state, redirectTo]);
  // Opportunistic cleanup; the table is tiny and this avoids a dedicated job.
  await query(
    `DELETE FROM oauth_states WHERE created_at < now() - ($1 || ' minutes')::interval`,
    [String(STATE_TTL_MINUTES)],
  );
  return state;
}

/** Single use: the row is deleted as it is read, so a replayed state fails. */
export async function consumeOAuthState(state: string): Promise<{ redirectTo: string | null } | null> {
  const { rows } = await query<{ redirect_to: string | null; created_at: Date }>(
    'DELETE FROM oauth_states WHERE state = $1 RETURNING redirect_to, created_at',
    [state],
  );
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - row.created_at.getTime() > STATE_TTL_MINUTES * 60 * 1000) return null;
  return { redirectTo: row.redirect_to };
}

export function authorizeUrl(state: string): string {
  if (!env.TWITCH_CLIENT_ID) {
    throw new AppError('internal', 'TWITCH_CLIENT_ID is not configured', 500);
  }
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', env.TWITCH_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', BROADCASTER_SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('force_verify', 'true');
  return url.toString();
}

export interface ConnectResult {
  channelId: string;
  login: string;
  scopes: string[];
  pool: { created: number; updated: number; total: number } | null;
  eventsub: { created: string[]; removed: string[]; kept: string[] } | null;
  exchangeReward: EnsureExchangeRewardResult | null;
  warnings: string[];
}

/**
 * Finish the OAuth dance, then bring the channel fully online: reward pool,
 * GTA$ exchange reward, EventSub subscriptions. Each step is best-effort and
 * its failure is reported rather than thrown, so a broadcaster never ends up
 * authorised but with no visible feedback about what is missing.
 */
export async function completeOAuth(code: string): Promise<ConnectResult> {
  const tokens = await exchangeCodeForTokens(code, redirectUri());

  const identity = await validateToken(tokens.access_token);
  if (!identity) {
    throw new AppError('provider_error', 'Twitch rejected the freshly issued token', 502);
  }

  const scopes = identity.scopes ?? [];
  const missing = BROADCASTER_SCOPES.filter((s) => !scopes.includes(s));

  await storeBroadcasterTokens({
    channelId: identity.userId,
    login: identity.login,
    displayName: identity.login,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? '',
    scopes,
    expiresInSeconds: tokens.expires_in,
  });

  const warnings: string[] = [];
  if (missing.length) {
    warnings.push(`Missing scopes: ${missing.join(', ')}. Reconnect and accept all permissions.`);
  }
  const foreignChannel = Boolean(env.TWITCH_CHANNEL_ID) && identity.userId !== env.TWITCH_CHANNEL_ID;
  if (foreignChannel) {
    warnings.push(
      `Connected account ${identity.userId} does not match TWITCH_CHANNEL_ID=${env.TWITCH_CHANNEL_ID}.`,
    );
  }

  let pool: ConnectResult['pool'] = null;
  let eventsub: ConnectResult['eventsub'] = null;
  let exchangeReward: ConnectResult['exchangeReward'] = null;

  try {
    const settings = await getSettings(identity.userId);
    pool = await ensureRewardPool(identity.userId, settings.rewardSlotPoolSize);
  } catch (err) {
    logger.error({ err }, 'reward pool setup failed');
    warnings.push(`Reward pool setup failed: ${(err as Error).message}`);
  }

  // Unlike the pool's slots, which are created disabled, the exchange reward
  // is live the moment it exists. On a channel this deployment does not serve
  // every redemption of it is ignored by the webhook, so its viewers would pay
  // ETH for nothing: it is only ever created on the configured channel.
  if (foreignChannel) {
    warnings.push(
      `GTA$ exchange reward not created: account ${identity.userId} is not TWITCH_CHANNEL_ID.`,
    );
  } else {
    try {
      exchangeReward = await ensureExchangeReward(identity.userId);
    } catch (err) {
      logger.error({ err }, 'exchange reward setup failed');
      warnings.push(`GTA$ exchange reward setup failed: ${(err as Error).message}`);
    }
  }

  try {
    eventsub = await ensureEventSubSubscriptions(identity.userId);
  } catch (err) {
    logger.error({ err }, 'eventsub setup failed');
    warnings.push(
      `EventSub setup failed: ${(err as Error).message}. PUBLIC_API_URL must be a public HTTPS URL.`,
    );
  }

  return {
    channelId: identity.userId,
    login: identity.login,
    scopes,
    pool,
    eventsub,
    exchangeReward,
    warnings,
  };
}
