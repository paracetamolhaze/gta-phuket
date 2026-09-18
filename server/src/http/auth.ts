import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { FastifyRequest } from 'fastify';
import { env } from '../env.js';
import { query } from '../db/pool.js';
import { AppError, type ExtIdentity } from '../domain/types.js';
import { bearerToken, verifyExtensionJwt } from '../twitch/extJwt.js';

// ---------------------------------------------------------------------------
// Twitch extension viewers
// ---------------------------------------------------------------------------

export function requireExtIdentity(req: FastifyRequest): ExtIdentity {
  const token = bearerToken(req.headers.authorization);
  if (!token) throw new AppError('unauthorized', 'Missing extension token', 401);
  return verifyExtensionJwt(token);
}

/**
 * A redemption arrives with a real Twitch user id, so a quote can only be
 * matched back to its buyer — and a wallet to its owner — if the viewer shared
 * their identity first. The id comes from the verified token and nowhere else.
 *
 * Twitch marks a logged-out viewer with an opaque id starting with `A`: there
 * is no identity to share, so they are told to log in rather than to share.
 */
export function requireLinkedViewer(identity: ExtIdentity): string {
  if (!identity.userId) {
    if (identity.opaqueUserId.startsWith('A')) {
      throw new AppError('needs_login', 'Войдите в Twitch, чтобы использовать GTA$', 403);
    }
    throw new AppError(
      'needs_id_share',
      'Нужно поделиться Twitch-аккаунтом, чтобы засчитать оплату',
      403,
    );
  }
  return identity.userId;
}

// ---------------------------------------------------------------------------
// Streamer devices
// ---------------------------------------------------------------------------

export interface DeviceClaims {
  deviceId: string;
  channelId: string;
}

export function signDeviceToken(claims: DeviceClaims): string {
  return jwt.sign({ ...claims, kind: 'device' }, env.ADMIN_SESSION_SECRET, {
    algorithm: 'HS256',
    expiresIn: '30d',
  });
}

export function verifyDeviceToken(token: string): DeviceClaims {
  try {
    const payload = jwt.verify(token, env.ADMIN_SESSION_SECRET, { algorithms: ['HS256'] }) as {
      deviceId?: string;
      channelId?: string;
      kind?: string;
    };
    if (payload.kind !== 'device' || !payload.deviceId || !payload.channelId) {
      throw new Error('wrong token kind');
    }
    return { deviceId: payload.deviceId, channelId: payload.channelId };
  } catch (err) {
    throw new AppError('unauthorized', `Device token rejected: ${(err as Error).message}`, 401);
  }
}

/** Also checks the device has not been revoked since the token was issued. */
export async function requireDevice(req: FastifyRequest): Promise<DeviceClaims> {
  const token = bearerToken(req.headers.authorization);
  if (!token) throw new AppError('unauthorized', 'Missing device token', 401);
  const claims = verifyDeviceToken(token);

  const { rows } = await query<{ revoked: boolean }>(
    'SELECT revoked FROM streamer_devices WHERE id = $1 AND channel_id = $2',
    [claims.deviceId, claims.channelId],
  );
  const row = rows[0];
  if (!row) throw new AppError('unauthorized', 'Device is not registered', 401);
  if (row.revoked) throw new AppError('forbidden', 'Device was revoked', 403);
  return claims;
}

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison for the pairing code. */
export function checkPairingCode(supplied: string): boolean {
  const expected = Buffer.from(env.STREAMER_DEVICE_SECRET);
  const given = Buffer.from(String(supplied ?? ''));
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

// ---------------------------------------------------------------------------
// OBS browser source
// ---------------------------------------------------------------------------

/**
 * A stable, derived token rather than a configured one: it needs no extra
 * setup step, rotates automatically with ADMIN_SESSION_SECRET, and can be
 * pasted straight into the OBS Browser Source URL. It is printed at startup
 * and shown in the admin console.
 */
export function obsToken(): string {
  return createHmac('sha256', env.ADMIN_SESSION_SECRET).update('obs-source').digest('hex').slice(0, 32);
}

export function isObsToken(supplied: unknown): boolean {
  if (typeof supplied !== 'string' || !supplied) return false;
  const expected = Buffer.from(obsToken());
  const given = Buffer.from(supplied);
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

export function obsUrl(): string {
  return `${env.PUBLIC_WEB_URL.replace(/\/$/, '')}/obs.html?token=${obsToken()}`;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export function signAdminToken(): string {
  return jwt.sign({ kind: 'admin' }, env.ADMIN_SESSION_SECRET, {
    algorithm: 'HS256',
    expiresIn: '12h',
  });
}

export function verifyAdminToken(token: string): true {
  try {
    const payload = jwt.verify(token, env.ADMIN_SESSION_SECRET, { algorithms: ['HS256'] }) as {
      kind?: string;
    };
    if (payload.kind !== 'admin') throw new Error('wrong token kind');
    return true;
  } catch (err) {
    throw new AppError('unauthorized', `Admin token rejected: ${(err as Error).message}`, 401);
  }
}

export function requireAdmin(req: FastifyRequest): true {
  const token = bearerToken(req.headers.authorization);
  if (!token) throw new AppError('unauthorized', 'Missing admin token', 401);
  return verifyAdminToken(token);
}

export function checkAdminPassword(supplied: string): boolean {
  const expected = Buffer.from(env.ADMIN_SESSION_SECRET);
  const given = Buffer.from(String(supplied ?? ''));
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}
