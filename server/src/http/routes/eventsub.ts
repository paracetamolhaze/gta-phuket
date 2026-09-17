import type { FastifyInstance, FastifyRequest } from 'fastify';
import { logger } from '../../logger.js';
import {
  claimMessage,
  readEventSubHeaders,
  runEvent,
  verifySignature,
} from '../../twitch/eventsub.js';

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

      // The event is now durably recorded, so Twitch can be released. The work
      // itself — fulfil or refund, rewrite rewards, free the other slots — runs
      // after the response, because it is several Twitch API calls deep and
      // holding the webhook open for it invites a timeout, and a timeout
      // invites a redelivery of an event already being processed.
      //
      // Nothing is lost by answering early: runEvent() records success or
      // failure on the row, and retryPendingEvents() picks up whatever failed.
      setImmediate(() => {
        void runEvent({ messageId: headers.messageId, subscriptionType, payload: body });
      });

      return reply.code(204).send();
    },
  );
}
