import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../domain/types.js';
import { parseDiagBatch } from '../../diag/sanitize.js';
import { LIMITS } from '../../diag/schema.js';
import { insertDiagBatch, loadExtDiagnostics } from '../../diag/store.js';
import { requireAdmin } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';

/**
 * Per client IP. A healthy page load sends a handful of batches a minute.
 * req.ip is the viewer's own address only because the ingress trusts the
 * outer proxy's X-Forwarded-For (Caddyfile, `trusted_proxies`); without that,
 * every viewer on the internet would share one bucket and one flood would
 * silence them all.
 */
const DIAG_REQUESTS_PER_MINUTE = 120;

const adminQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function registerDiagRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The extension page reporting on itself (docs/EXTENSION_DIAGNOSTICS.md §3).
   *
   * Unauthenticated on purpose: it has to work before onAuthorized, and when
   * onAuthorized never comes, which is exactly when it is needed. The page
   * sends it as text/plain with mode no-cors so that no preflight stands
   * between a sandboxed Twitch iframe and this endpoint; application/json is
   * accepted too. The caller never reads the response.
   */
  app.post('/api/diag/ext', { bodyLimit: LIMITS.bodyBytes }, async (req, reply) => {
    // Counted before parsing, so junk costs the sender as much as real batches.
    await enforceRateLimit('extdiag', req.ip, DIAG_REQUESTS_PER_MINUTE);

    const parsed = parseDiagBatch(req.body);
    if (!parsed.ok) {
      throw new AppError('invalid_request', 'Некорректный пакет диагностики', 400, parsed.error);
    }
    await insertDiagBatch(parsed.batch);
    req.log.debug(
      { session: parsed.batch.session, events: parsed.batch.events.map((e) => e.event) },
      'extension diagnostics stored',
    );
    return reply.code(204).send();
  });

  /** What /admin shows in TWITCH EXTENSION DIAGNOSTICS (§5). */
  app.get('/api/admin/ext-diagnostics', async (req) => {
    requireAdmin(req);
    const { limit } = adminQuerySchema.parse(req.query);
    return loadExtDiagnostics(limit);
  });
}
