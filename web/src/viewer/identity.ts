/**
 * Who the extension JWT says the viewer is, as far as the GTA$ wallet cares.
 *
 * The server decides from the very same token — the numeric `user_id` claim,
 * which Twitch adds only after the viewer shares their identity — and its
 * answer (403 needs_id_share / needs_login) always wins. Reading the claim
 * here just lets the overlay pick the right prompt without a round trip, and
 * notice when the person behind the token changes.
 *
 * Nothing derived here is logged, stored or sent anywhere.
 */

import type { ExtAuth } from './twitch';

export type WalletIdentityKind = 'linked' | 'unlinked' | 'anonymous' | 'unknown';

export interface WalletIdentity {
  kind: WalletIdentityKind;
  /**
   * Changes when the viewer does (anonymous → logged in → identity shared),
   * and NOT when Twitch merely rotates the token for the same viewer. Keys the
   * wallet re-read and the socket reconnect, so a rotation costs nothing.
   */
  key: string;
}

const UNKNOWN: WalletIdentity = { kind: 'unknown', key: 'none' };

function jwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    // The claims we read are ASCII ids, so atob's Latin-1 output is enough.
    const parsed: unknown = JSON.parse(atob(padded));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function claim(claims: Record<string, unknown> | null, key: string): string | null {
  const value = claims?.[key];
  return typeof value === 'string' && value ? value : null;
}

export function walletIdentity(auth: ExtAuth | null): WalletIdentity {
  if (!auth) return UNKNOWN;
  const claims = jwtClaims(auth.token);
  // Twitch's onAuthorized `userId` is the opaque id; the dev fallback puts the
  // numeric one there. The claims are what the server reads, so they go first.
  const opaque = claim(claims, 'opaque_user_id') ?? auth.userId;
  const numeric = claim(claims, 'user_id') ?? (/^\d+$/.test(auth.userId) ? auth.userId : null);
  const userId = numeric && /^\d+$/.test(numeric) ? numeric : null;
  const channel = claim(claims, 'channel_id') ?? auth.channelId;

  const kind: WalletIdentityKind = userId ? 'linked' : opaque.startsWith('A') ? 'anonymous' : 'unlinked';
  return { kind, key: `${channel}|${opaque}|${userId ?? ''}` };
}
