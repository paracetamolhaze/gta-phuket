import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { env } from '../src/env.js';
import {
  computeSignature,
  parseRedemption,
  readEventSubHeaders,
  verifySignature,
} from '../src/twitch/eventsub.js';

const SECRET = env.TWITCH_EVENTSUB_SECRET;

function message(overrides: { body?: string; timestamp?: string; secret?: string } = {}) {
  const body = overrides.body ?? JSON.stringify({ subscription: { type: 'test' }, event: {} });
  const messageId = randomUUID();
  const timestamp = overrides.timestamp ?? new Date().toISOString();
  const signature = computeSignature(messageId, timestamp, body, overrides.secret ?? SECRET);
  return { messageId, timestamp, signature, body };
}

describe('EventSub signature verification', () => {
  it('accepts a correctly signed message', () => {
    const m = message();
    expect(
      verifySignature(
        { messageId: m.messageId, messageType: 'notification', timestamp: m.timestamp, signature: m.signature },
        m.body,
      ),
    ).toBe(true);
  });

  it('matches Twitch: HMAC over messageId + timestamp + rawBody', () => {
    const m = message();
    const expected = `sha256=${createHmac('sha256', SECRET)
      .update(m.messageId + m.timestamp + m.body)
      .digest('hex')}`;
    expect(m.signature).toBe(expected);
  });

  it('rejects a body that was modified in transit', () => {
    const m = message();
    const tampered = JSON.stringify({ subscription: { type: 'test' }, event: { evil: true } });
    expect(
      verifySignature(
        { messageId: m.messageId, messageType: 'notification', timestamp: m.timestamp, signature: m.signature },
        tampered,
      ),
    ).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const m = message({ secret: 'not-the-real-secret' });
    expect(
      verifySignature(
        { messageId: m.messageId, messageType: 'notification', timestamp: m.timestamp, signature: m.signature },
        m.body,
      ),
    ).toBe(false);
  });

  it('rejects a replay from more than ten minutes ago', () => {
    const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const m = message({ timestamp: old });
    expect(
      verifySignature(
        { messageId: m.messageId, messageType: 'notification', timestamp: old, signature: m.signature },
        m.body,
      ),
    ).toBe(false);
  });

  it('rejects a timestamp far in the future', () => {
    const future = new Date(Date.now() + 11 * 60 * 1000).toISOString();
    const m = message({ timestamp: future });
    expect(
      verifySignature(
        { messageId: m.messageId, messageType: 'notification', timestamp: future, signature: m.signature },
        m.body,
      ),
    ).toBe(false);
  });

  it('rejects a malformed or truncated signature without throwing', () => {
    const m = message();
    for (const bad of ['', 'sha256=', 'garbage', m.signature.slice(0, -4)]) {
      expect(
        verifySignature(
          { messageId: m.messageId, messageType: 'notification', timestamp: m.timestamp, signature: bad },
          m.body,
        ),
      ).toBe(false);
    }
  });

  it('verifies the exact bytes, not a re-serialised object', () => {
    // Twitch signs the raw body; key order and spacing must survive untouched.
    // Twitch pretty-prints nothing, but any whitespace or key-order change a
    // proxy or a JSON round-trip introduces must break the signature.
    const raw = '{ "a": 1,  "b": [2, 3] }';
    const m = message({ body: raw });
    const reserialised = JSON.stringify(JSON.parse(raw));
    expect(reserialised).not.toBe(raw);
    expect(
      verifySignature(
        { messageId: m.messageId, messageType: 'notification', timestamp: m.timestamp, signature: m.signature },
        Buffer.from(raw),
      ),
    ).toBe(true);
    expect(
      verifySignature(
        { messageId: m.messageId, messageType: 'notification', timestamp: m.timestamp, signature: m.signature },
        reserialised,
      ),
    ).toBe(false);
  });
});

describe('EventSub header parsing', () => {
  it('reads all required headers', () => {
    const headers = readEventSubHeaders({
      'twitch-eventsub-message-id': 'abc',
      'twitch-eventsub-message-type': 'notification',
      'twitch-eventsub-message-timestamp': '2026-01-01T00:00:00Z',
      'twitch-eventsub-message-signature': 'sha256=x',
      'twitch-eventsub-subscription-type': 'channel.x',
    });
    expect(headers?.messageId).toBe('abc');
    expect(headers?.subscriptionType).toBe('channel.x');
  });

  it('returns null when a required header is missing', () => {
    expect(
      readEventSubHeaders({
        'twitch-eventsub-message-id': 'abc',
        'twitch-eventsub-message-type': 'notification',
      }),
    ).toBeNull();
  });
});

describe('redemption payload parsing', () => {
  it('maps the Twitch shape onto our event', () => {
    const event = parseRedemption('msg-1', {
      id: 'red-1',
      broadcaster_user_id: '900000001',
      user_id: '123',
      user_login: 'viewer',
      user_name: 'Viewer',
      user_input: '',
      status: 'unfulfilled',
      redeemed_at: '2026-01-01T00:00:00Z',
      reward: { id: 'rew-1', title: 'WAYPOINT • A7K3', cost: 1350, prompt: '' },
    });
    expect(event?.redemptionId).toBe('red-1');
    expect(event?.rewardCost).toBe(1350);
    expect(event?.userId).toBe('123');
  });

  it('returns null for a payload that is not a redemption', () => {
    expect(parseRedemption('msg-1', undefined)).toBeNull();
    expect(parseRedemption('msg-1', { id: 'x' })).toBeNull();
    expect(parseRedemption('msg-1', { reward: { id: 'y' } })).toBeNull();
  });
});
