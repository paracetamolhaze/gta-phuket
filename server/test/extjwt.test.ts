import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { env } from '../src/env.js';
import {
  bearerToken,
  extensionSecret,
  signDevExtensionJwt,
  verifyExtensionJwt,
} from '../src/twitch/extJwt.js';
import { AppError } from '../src/domain/types.js';

const CHANNEL = env.TWITCH_CHANNEL_ID;

function sign(payload: Record<string, unknown>, secret = extensionSecret()): string {
  return jwt.sign(payload, secret, { algorithm: 'HS256', noTimestamp: true });
}

const valid = (): Record<string, unknown> => ({
  exp: Math.floor(Date.now() / 1000) + 600,
  channel_id: CHANNEL,
  opaque_user_id: 'U123456',
  user_id: '123456',
  role: 'viewer',
  is_unlinked: false,
});

describe('Twitch extension JWT verification', () => {
  it('accepts a well-formed token and exposes the real user id', () => {
    const identity = verifyExtensionJwt(sign(valid()));
    expect(identity.channelId).toBe(CHANNEL);
    expect(identity.userId).toBe('123456');
    expect(identity.opaqueUserId).toBe('U123456');
    expect(identity.role).toBe('viewer');
    expect(identity.isUnlinked).toBe(false);
  });

  it('treats a token without user_id as unlinked', () => {
    const payload = valid();
    delete payload.user_id;
    payload.opaque_user_id = 'A987654';
    payload.is_unlinked = true;
    const identity = verifyExtensionJwt(sign(payload));
    expect(identity.userId).toBeNull();
    expect(identity.isUnlinked).toBe(true);
  });

  it('refuses a non-numeric user_id rather than trusting it', () => {
    // An opaque id in the user_id slot must never be mistaken for a real one:
    // redemptions arrive keyed by the numeric Twitch id.
    const identity = verifyExtensionJwt(sign({ ...valid(), user_id: 'U123456' }));
    expect(identity.userId).toBeNull();
    expect(identity.isUnlinked).toBe(true);
  });

  it('rejects a token signed with the wrong secret', () => {
    const forged = sign(valid(), Buffer.from('some-other-secret'));
    expect(() => verifyExtensionJwt(forged)).toThrowError(AppError);
    try {
      verifyExtensionJwt(forged);
    } catch (err) {
      expect((err as AppError).code).toBe('unauthorized');
      expect((err as AppError).httpStatus).toBe(401);
    }
  });

  it('rejects an expired token', () => {
    const expired = sign({ ...valid(), exp: Math.floor(Date.now() / 1000) - 120 });
    expect(() => verifyExtensionJwt(expired)).toThrowError(/expired|jwt expired/i);
  });

  it('rejects the "none" algorithm', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(valid())).toString('base64url');
    expect(() => verifyExtensionJwt(`${header}.${body}.`)).toThrowError(AppError);
  });

  it('rejects an HS256 token issued for another channel', () => {
    const other = sign({ ...valid(), channel_id: '999999999' });
    try {
      verifyExtensionJwt(other);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as AppError).code).toBe('forbidden');
    }
  });

  it('rejects a token with no channel or opaque id', () => {
    const noChannel = valid();
    delete noChannel.channel_id;
    expect(() => verifyExtensionJwt(sign(noChannel))).toThrowError(AppError);

    const noOpaque = valid();
    delete noOpaque.opaque_user_id;
    expect(() => verifyExtensionJwt(sign(noOpaque))).toThrowError(AppError);
  });

  it('falls back to the viewer role for an unknown role string', () => {
    expect(verifyExtensionJwt(sign({ ...valid(), role: 'wizard' })).role).toBe('viewer');
  });

  it('mints dev tokens that pass the real verifier', () => {
    const token = signDevExtensionJwt({ channelId: CHANNEL, userId: '100000001' });
    const identity = verifyExtensionJwt(token);
    expect(identity.userId).toBe('100000001');
    expect(identity.isUnlinked).toBe(false);

    const unlinked = verifyExtensionJwt(
      signDevExtensionJwt({ channelId: CHANNEL, userId: '100000002', linked: false }),
    );
    expect(unlinked.userId).toBeNull();
  });
});

describe('bearer header parsing', () => {
  it('extracts the token', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer   abc')).toBe('abc');
  });

  it('returns null for anything else', () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('')).toBeNull();
  });
});
