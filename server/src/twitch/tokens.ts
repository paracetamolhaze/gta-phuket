import { query } from '../db/pool.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { redis } from '../redis/client.js';
import { K } from '../redis/keys.js';
import { withLock } from '../redis/lock.js';
import { AppError } from '../domain/types.js';

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';

/** Scopes needed to create/edit rewards and to fulfil or refund redemptions. */
export const BROADCASTER_SCOPES = ['channel:manage:redemptions', 'channel:read:redemptions'];

export interface BroadcasterTokens {
  channelId: string;
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string[] | string;
  token_type: string;
}

function parseScopes(scope: TokenResponse['scope']): string[] {
  if (Array.isArray(scope)) return scope;
  if (typeof scope === 'string') return scope.split(' ').filter(Boolean);
  return [];
}

// ---------------------------------------------------------------------------
// Broadcaster (user) token
// ---------------------------------------------------------------------------

export async function storeBroadcasterTokens(input: {
  channelId: string;
  login?: string | null;
  displayName?: string | null;
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  expiresInSeconds: number;
}): Promise<BroadcasterTokens> {
  const expiresAt = Date.now() + input.expiresInSeconds * 1000;

  await query(
    `INSERT INTO channels (id, login, display_name, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE
       SET login = COALESCE(EXCLUDED.login, channels.login),
           display_name = COALESCE(EXCLUDED.display_name, channels.display_name),
           updated_at = now()`,
    [input.channelId, input.login ?? null, input.displayName ?? null],
  );

  await query(
    `INSERT INTO broadcaster_oauth (channel_id, access_token, refresh_token, scopes, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), now())
     ON CONFLICT (channel_id) DO UPDATE
       SET access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           scopes = EXCLUDED.scopes,
           expires_at = EXCLUDED.expires_at,
           updated_at = now()`,
    [input.channelId, input.accessToken, input.refreshToken, input.scopes, expiresAt],
  );

  return {
    channelId: input.channelId,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    scopes: input.scopes,
    expiresAt,
  };
}

export async function loadBroadcasterTokens(channelId: string): Promise<BroadcasterTokens | null> {
  const { rows } = await query<{
    access_token: string;
    refresh_token: string;
    scopes: string[];
    expires_at: Date;
  }>(
    'SELECT access_token, refresh_token, scopes, expires_at FROM broadcaster_oauth WHERE channel_id = $1',
    [channelId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    channelId,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    scopes: row.scopes ?? [],
    expiresAt: row.expires_at.getTime(),
  };
}

export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new AppError('provider_error', `Twitch token exchange failed: ${res.status} ${text}`, 502);
  }
  return (await res.json()) as TokenResponse;
}

async function refreshBroadcasterTokens(current: BroadcasterTokens): Promise<BroadcasterTokens> {
  const body = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    // A dead refresh token means the broadcaster must reconnect; surfacing it
    // as provider_error keeps the admin UI honest instead of retrying forever.
    throw new AppError(
      'provider_error',
      `Twitch refresh failed (${res.status}). The broadcaster must reconnect: ${text}`,
      502,
    );
  }
  const data = (await res.json()) as TokenResponse;

  return storeBroadcasterTokens({
    channelId: current.channelId,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? current.refreshToken,
    scopes: parseScopes(data.scope),
    expiresInSeconds: data.expires_in,
  });
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Returns a token that is valid for at least the next five minutes, refreshing
 * under a Redis lock so parallel requests do not each burn a refresh token.
 */
export async function getBroadcasterAccessToken(channelId: string): Promise<string> {
  const tokens = await loadBroadcasterTokens(channelId);
  if (!tokens) {
    throw new AppError(
      'forbidden',
      'Channel is not connected to Twitch. Open /api/oauth/twitch/start as the broadcaster.',
      403,
    );
  }
  if (tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) return tokens.accessToken;

  return withLock(
    K.lockTokenRefresh(channelId),
    async () => {
      // Another worker may have refreshed while we waited for the lock.
      const fresh = await loadBroadcasterTokens(channelId);
      if (fresh && fresh.expiresAt - Date.now() > REFRESH_MARGIN_MS) return fresh.accessToken;
      const refreshed = await refreshBroadcasterTokens(fresh ?? tokens);
      logger.info({ channelId }, 'broadcaster token refreshed');
      return refreshed.accessToken;
    },
    { ttlMs: 15_000, waitMs: 10_000 },
  );
}

export async function revokeBroadcasterConnection(channelId: string): Promise<void> {
  await query('DELETE FROM broadcaster_oauth WHERE channel_id = $1', [channelId]);
}

// ---------------------------------------------------------------------------
// App access token (client credentials) — required for EventSub webhooks
// ---------------------------------------------------------------------------

const APP_TOKEN_KEY = 'gta:twitch:app_token';

export async function getAppAccessToken(force = false): Promise<string> {
  if (!force) {
    const cached = await redis.get(APP_TOKEN_KEY);
    if (cached) return cached;
  }

  const body = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    grant_type: 'client_credentials',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new AppError('provider_error', `Twitch app token failed: ${res.status} ${text}`, 502);
  }
  const data = (await res.json()) as TokenResponse;
  // Expire our copy well before Twitch does.
  const ttl = Math.max(60, data.expires_in - 300);
  await redis.set(APP_TOKEN_KEY, data.access_token, 'EX', ttl);
  return data.access_token;
}

export async function validateToken(
  accessToken: string,
): Promise<{ userId: string; login: string; scopes: string[] } | null> {
  const res = await fetch(VALIDATE_URL, {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { user_id: string; login: string; scopes?: string[] };
  return { userId: data.user_id, login: data.login, scopes: data.scopes ?? [] };
}
