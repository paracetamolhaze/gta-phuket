import type { FastifyInstance } from 'fastify';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import {
  authorizeUrl,
  completeOAuth,
  consumeOAuthState,
  createOAuthState,
  safeRedirect,
} from '../../twitch/oauth.js';
import { enforceRateLimit } from '../rateLimit.js';

export async function registerOAuthRoutes(app: FastifyInstance): Promise<void> {
  /** Broadcaster-only entry point; open it while logged into Twitch as the channel. */
  app.get('/api/oauth/twitch/start', async (req, reply) => {
    await enforceRateLimit('oauthstart', req.ip, 20);
    const query = req.query as { redirect?: string };
    // An open redirect here would turn our OAuth entry point into someone
    // else's phishing hop, so anything outside PUBLIC_WEB_URL is dropped.
    const state = await createOAuthState(safeRedirect(query.redirect));
    return reply.redirect(302, authorizeUrl(state));
  });

  app.get('/api/oauth/twitch/callback', async (req, reply) => {
    const query = req.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };

    const adminUrl = `${env.PUBLIC_WEB_URL.replace(/\/$/, '')}/admin.html`;

    if (query.error) {
      return reply.redirect(
        302,
        `${adminUrl}?connected=0&error=${encodeURIComponent(query.error_description ?? query.error)}`,
      );
    }
    if (!query.code || !query.state) {
      return reply.redirect(302, `${adminUrl}?connected=0&error=missing_code`);
    }

    // CSRF: the state must be one we issued, and it is single use.
    const state = await consumeOAuthState(query.state);
    if (!state) {
      return reply.redirect(302, `${adminUrl}?connected=0&error=bad_state`);
    }

    try {
      const result = await completeOAuth(query.code);
      logger.info(
        { channelId: result.channelId, warnings: result.warnings },
        'broadcaster connected',
      );
      const params = new URLSearchParams({ connected: '1', channel: result.channelId });
      if (result.warnings.length) params.set('warn', result.warnings.join(' | '));
      const target = safeRedirect(state.redirectTo) ?? adminUrl;
      return reply.redirect(302, `${target}?${params.toString()}`);
    } catch (err) {
      logger.error({ err }, 'oauth callback failed');
      return reply.redirect(
        302,
        `${adminUrl}?connected=0&error=${encodeURIComponent((err as Error).message)}`,
      );
    }
  });
}
