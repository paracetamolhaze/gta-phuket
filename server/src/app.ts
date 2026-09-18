import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { env } from './env.js';
import { loggerOptions } from './logger.js';
import { AppError } from './domain/types.js';
import { registerHealthRoutes } from './http/routes/health.js';
import { registerExtRoutes } from './http/routes/ext.js';
import { registerStreamerRoutes } from './http/routes/streamer.js';
import { registerAdminRoutes } from './http/routes/admin.js';
import { registerObsRoutes } from './http/routes/obs.js';
import { registerOAuthRoutes } from './http/routes/oauth.js';
import { registerEventSubRoutes } from './http/routes/eventsub.js';
import { registerDevRoutes } from './http/routes/dev.js';
import { registerDiagRoutes } from './http/routes/diag.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

/** `false` | `true` | a hop count | a comma-separated list of proxy IPs/CIDRs. */
function parseTrustProxy(value: string): boolean | number | string[] {
  const raw = value.trim();
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  return raw.split(',').map((v) => v.trim()).filter(Boolean);
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
    // Never blanket-true: req.ip is what the login and pairing rate limits are
    // keyed on, and a trusted X-Forwarded-For is a client-controlled string.
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    bodyLimit: 256 * 1024,
    // An upgraded WebSocket is never idle, so without this app.close() would
    // hang forever and shutdown would never finish.
    forceCloseConnections: true,
    disableRequestLogging: env.isProduction,
  });

  /**
   * The Twitch extension is served from Twitch's own CDN, so its origin is
   * never ours. Nothing is authorised by origin here: every privileged call
   * carries a signed bearer token, and EventSub is authenticated by HMAC.
   */
  await app.register(cors, {
    origin: true,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  /**
   * Keep the raw bytes of every JSON body. EventSub signatures are computed
   * over the exact payload Twitch sent, so a re-serialised object would not
   * verify.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      req.rawBody = body;
      if (body.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (err) {
        const error = err as Error & { statusCode?: number };
        error.statusCode = 400;
        done(error, undefined);
      }
    },
  );

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      // Expected, user-visible outcomes: log at debug so the real log stays useful.
      req.log.debug({ code: error.code, path: req.url }, error.message);
      return reply.code(error.httpStatus).send(error.toJSON());
    }
    if (error instanceof ZodError) {
      return reply.code(422).send({
        error: 'invalid_request',
        message: 'Некорректные данные запроса',
        details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode >= 500) {
      req.log.error({ err: error, path: req.url }, 'unhandled error');
    }
    return reply.code(statusCode).send({
      error: statusCode >= 500 ? 'internal' : 'invalid_request',
      message: statusCode >= 500 && env.isProduction ? 'Internal error' : error.message,
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: 'not_found', message: `No route for ${req.method} ${req.url}` }),
  );

  await registerHealthRoutes(app);
  await registerExtRoutes(app);
  await registerStreamerRoutes(app);
  await registerAdminRoutes(app);
  await registerObsRoutes(app);
  await registerOAuthRoutes(app);
  await registerEventSubRoutes(app);
  await registerDevRoutes(app);
  await registerDiagRoutes(app);

  return app;
}
