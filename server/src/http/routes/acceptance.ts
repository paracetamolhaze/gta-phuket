import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../env.js';
import { loadAcceptanceReport } from '../../diag/acceptance.js';
import { requireAdmin } from '../auth.js';

const querySchema = z.object({
  minutes: z.coerce.number().int().min(5).max(1440).default(180),
});

/** GTA$ live acceptance monitor: read-only, admin only. */
export async function registerAcceptanceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/acceptance', async (req) => {
    requireAdmin(req);
    const { minutes } = querySchema.parse(req.query ?? {});
    return loadAcceptanceReport(env.TWITCH_CHANNEL_ID || 'dev', minutes);
  });
}
