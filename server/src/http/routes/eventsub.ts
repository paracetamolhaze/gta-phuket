import type { FastifyInstance, FastifyRequest } from 'fastify';
import { logger } from '../../logger.js';
import {
  REDEMPTION_ADD,
  REDEMPTION_UPDATE,
  claimMessage,
  handleRedemption,
  parseRedemption,
  readEventSubHeaders,
  verifySignature,
} from '../../twitch/eventsub.js';
import { emitSlotCounts } from '../../domain/waypointFlow.js';
import { query } from '../../db/pool.js';
import { redis } from '../../redis/client.js';
import { K } from '../../redis/keys.js';

/**
 * Undo everything claimMessage() recorded, so the retry Twitch is guaranteed to
 * send is processed instead of being mistaken for a duplicate.
 */
async function releaseClaim(messageId: string, redemptionId: string | null): Promise<void> {
  const keys = redemptionId
    ? [K.eventSeen(messageId), K.redemptionSeen(redemptionId)]
    : [K.eventSeen(messageId)];
  await redis.del(...keys).catch(() => undefined);
  await query('DELETE FROM eventsub_events WHERE message_id = $1', [messageId]).catch(() => undefined);
}

interface NotificationBody {
  subscription?: { id?: string; type?: string; condition?: Record<string, string> };
  event?: unknown;
  challenge?: string;
}

/**
 * Twitch's webhook endpoint.
 *
 * This is the only place the system learns that Channel Points were actually
 * spent. Nothing the browser says about payment is ever believed.
 */
export async function registerEventSubRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/eventsub/twitch',
    { config: { rawBody: true } },
    async (req: FastifyRequest, reply) => {
      const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
      if (!raw) {
        logger.error('eventsub request arrived without a raw body');
        return reply.code(500).send({ error: 'internal', message: 'raw body unavailable' });
      }

      const headers = readEventSubHeaders(req.headers);
      if (!headers) {
        return reply.code(400).send({ error: 'invalid_request', message: 'missing EventSub headers' });
      }

      // Signature first: an unsigned request is not allowed to touch anything,
      // not even the dedupe table.
      if (!verifySignature(headers, raw)) {
        logger.warn({ messageId: headers.messageId }, 'eventsub signature rejected');
        return reply.code(403).send({ error: 'forbidden', message: 'bad signature' });
      }

      let body: NotificationBody;
      try {
        body = JSON.parse(raw.toString('utf8')) as NotificationBody;
      } catch {
        return reply.code(400).send({ error: 'invalid_request', message: 'malformed body' });
      }

      // Twitch proves it owns the callback by asking us to echo a challenge.
      if (headers.messageType === 'webhook_callback_verification') {
        logger.info({ type: body.subscription?.type }, 'eventsub callback verified');
        return reply.code(200).type('text/plain').send(body.challenge ?? '');
      }

      if (headers.messageType === 'revocation') {
        logger.warn(
          { type: body.subscription?.type, id: body.subscription?.id },
          'eventsub subscription revoked by Twitch',
        );
        return reply.code(204).send();
      }

      if (headers.messageType !== 'notification') {
        return reply.code(204).send();
      }

      const subscriptionType = body.subscription?.type ?? headers.subscriptionType ?? 'unknown';
      const channelId = body.subscription?.condition?.broadcaster_user_id ?? null;

      const fresh = await claimMessage(headers.messageId, subscriptionType, channelId, body);
      if (!fresh) {
        // A redelivery. Answering 200 stops Twitch retrying; doing nothing else
        // is what makes the handler idempotent.
        logger.debug({ messageId: headers.messageId }, 'duplicate eventsub message ignored');
        return reply.code(204).send();
      }

      if (subscriptionType === REDEMPTION_ADD) {
        const event = parseRedemption(headers.messageId, body.event);
        if (!event) {
          logger.warn({ messageId: headers.messageId }, 'unparseable redemption payload');
          return reply.code(204).send();
        }

        try {
          const outcome = await handleRedemption(event);
          logger.info({ outcome, user: event.userId, reward: event.rewardId }, 'redemption handled');
          if (outcome.result === 'activated' || outcome.result === 'refunded') {
            await emitSlotCounts(event.broadcasterUserId).catch(() => undefined);
          }
        } catch (err) {
          // Returning 500 makes Twitch retry. Both dedupe layers were already
          // written, so BOTH have to be released or the retry would be treated
          // as a duplicate and dropped — leaving the viewer charged with no
          // waypoint and no refund.
          logger.error({ err, messageId: headers.messageId }, 'redemption handling failed');
          await releaseClaim(headers.messageId, event.redemptionId);
          return reply.code(500).send({ error: 'internal', message: 'processing failed' });
        }
        return reply.code(204).send();
      }

      if (subscriptionType === REDEMPTION_UPDATE) {
        // A moderator resolving a redemption in the Twitch UI. We record it for
        // the audit trail; the waypoint itself is driven by the add event.
        const event = parseRedemption(headers.messageId, body.event);
        if (event) {
          await query(
            `UPDATE twitch_redemptions SET resolution = $2 WHERE id = $1`,
            [event.redemptionId, event.status.toUpperCase()],
          ).catch(() => undefined);
          logger.info(
            { redemption: event.redemptionId, status: event.status },
            'redemption status updated externally',
          );
        }
        return reply.code(204).send();
      }

      logger.debug({ subscriptionType }, 'unhandled eventsub type');
      return reply.code(204).send();
    },
  );
}
