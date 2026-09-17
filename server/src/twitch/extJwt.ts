import jwt from 'jsonwebtoken';
import { env } from '../env.js';
import { AppError, type ExtIdentity, type ExtRole } from '../domain/types.js';

/**
 * Payload Twitch puts in an Extension JWT. `user_id` only appears once the
 * viewer has granted identity sharing; without it we cannot match a Channel
 * Points redemption back to the person who asked for the waypoint.
 */
interface ExtJwtPayload {
  exp: number;
  channel_id: string;
  opaque_user_id: string;
  user_id?: string;
  role: ExtRole;
  is_unlinked?: boolean;
  pubsub_perms?: { listen?: string[]; send?: string[] };
}

let cachedSecret: Buffer | null = null;
let cachedSecretSource = '';

/** The console shows the extension secret base64-encoded; JWTs are signed with the raw bytes. */
export function extensionSecret(): Buffer {
  const raw = env.TWITCH_EXT_SECRET;
  if (!raw) {
    throw new AppError('internal', 'TWITCH_EXT_SECRET is not configured', 500);
  }
  if (cachedSecret && cachedSecretSource === raw) return cachedSecret;
  cachedSecret = Buffer.from(raw, 'base64');
  cachedSecretSource = raw;
  return cachedSecret;
}

const ROLES: ReadonlySet<string> = new Set(['broadcaster', 'moderator', 'viewer', 'external']);

/**
 * Real Twitch user ids are numeric. Opaque ids look like `UG1234` (linked,
 * still opaque) or `A1234` (anonymous). Treat anything non-numeric as unlinked,
 * which is the only safe reading.
 */
function realUserId(payload: ExtJwtPayload): string | null {
  const id = payload.user_id;
  if (typeof id !== 'string' || !/^\d+$/.test(id)) return null;
  return id;
}

export function verifyExtensionJwt(token: string): ExtIdentity {
  let decoded: ExtJwtPayload;
  try {
    decoded = jwt.verify(token, extensionSecret(), {
      algorithms: ['HS256'],
      clockTolerance: 5,
    }) as ExtJwtPayload;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid token';
    throw new AppError('unauthorized', `Extension token rejected: ${message}`, 401);
  }

  if (!decoded || typeof decoded !== 'object') {
    throw new AppError('unauthorized', 'Extension token has no payload', 401);
  }
  if (typeof decoded.channel_id !== 'string' || !decoded.channel_id) {
    throw new AppError('unauthorized', 'Extension token has no channel_id', 401);
  }
  if (typeof decoded.opaque_user_id !== 'string' || !decoded.opaque_user_id) {
    throw new AppError('unauthorized', 'Extension token has no opaque_user_id', 401);
  }
  const role = ROLES.has(decoded.role) ? decoded.role : 'viewer';

  // A deployment serves exactly one channel. A token minted for a different
  // channel is a valid Twitch token but not one we accept.
  if (env.TWITCH_CHANNEL_ID && decoded.channel_id !== env.TWITCH_CHANNEL_ID) {
    throw new AppError('forbidden', 'Extension token is for a different channel', 403);
  }

  return {
    channelId: decoded.channel_id,
    opaqueUserId: decoded.opaque_user_id,
    userId: realUserId(decoded),
    role,
    expSeconds: typeof decoded.exp === 'number' ? decoded.exp : 0,
    isUnlinked: decoded.is_unlinked === true || realUserId(decoded) === null,
  };
}

/** Pull the bearer token out of an Authorization header. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

export interface DevTokenOptions {
  channelId: string;
  userId?: string;
  role?: ExtRole;
  linked?: boolean;
  ttlSeconds?: number;
}

/**
 * Mint a token that is byte-for-byte the shape Twitch produces, signed with the
 * same secret. Only reachable through /api/dev/*, which is refused in production.
 * Dev mode therefore exercises the real verification path rather than skipping it.
 */
export function signDevExtensionJwt(opts: DevTokenOptions): string {
  const linked = opts.linked !== false;
  const userId = opts.userId ?? '100000001';
  const payload: ExtJwtPayload = {
    exp: Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? 3600),
    channel_id: opts.channelId,
    opaque_user_id: linked ? `U${userId}` : `A${userId}`,
    role: opts.role ?? 'viewer',
    is_unlinked: !linked,
    pubsub_perms: { listen: ['broadcast'], send: [] },
  };
  if (linked) payload.user_id = userId;

  return jwt.sign(payload, extensionSecret(), { algorithm: 'HS256', noTimestamp: true });
}
