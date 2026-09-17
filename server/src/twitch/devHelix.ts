import { createHash } from 'node:crypto';
import { env } from '../env.js';
import { logger } from '../logger.js';
import type { CustomReward, EventSubSubscription } from './helix.js';

/**
 * Local stand-in for the Twitch API, used only when DEV_MODE is on and no
 * Twitch application is configured.
 *
 * This exists so the whole chain — quote, slot lease, reward, redemption,
 * EventSub, waypoint — can be exercised on a laptop with no stream, no
 * credentials and no real Channel Points. It is never reachable in production:
 * `env.devModeEnabled` is forced false when NODE_ENV=production, and a
 * configured TWITCH_CLIENT_ID also takes precedence.
 *
 * The stub is deliberately dumb. It fakes only the shapes this app reads back,
 * so anything that would break against real Twitch breaks here too.
 */

export function twitchConfigured(): boolean {
  return Boolean(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);
}

export function useDevHelix(): boolean {
  return env.devModeEnabled && !twitchConfigured();
}

const rewards = new Map<string, CustomReward>();
const subscriptions = new Map<string, EventSubSubscription>();

function stableId(seed: string): string {
  return createHash('sha1').update(seed).digest('hex').slice(0, 32);
}

function ensureReward(id: string, title: string, cost: number): CustomReward {
  const existing = rewards.get(id);
  if (existing) return existing;
  const created: CustomReward = {
    id,
    title,
    cost,
    prompt: '',
    is_enabled: false,
    is_paused: true,
    is_in_stock: true,
    is_user_input_required: false,
    should_redemptions_skip_request_queue: false,
    background_color: '#FFC247',
  };
  rewards.set(id, created);
  return created;
}

export interface DevHelixRequest {
  path: string;
  method: string;
  query: Record<string, string | number | boolean | undefined>;
  body: unknown;
}

/** Returns `{ handled: false }` for anything the stub does not model. */
export function devHelix(req: DevHelixRequest): { handled: boolean; data?: unknown } {
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (req.path === '/users') {
    const id = String(req.query.id ?? '0');
    return { handled: true, data: { data: [{ id, login: `dev_${id}`, display_name: `Dev ${id}` }] } };
  }

  if (req.path === '/channel_points/custom_rewards') {
    const broadcasterId = String(req.query.broadcaster_id ?? 'dev');

    if (req.method === 'POST') {
      const title = String(body.title ?? 'REWARD');
      const reward = ensureReward(
        stableId(`${broadcasterId}:${title}`),
        title,
        Number(body.cost ?? 1),
      );
      reward.prompt = String(body.prompt ?? '');
      reward.is_enabled = body.is_enabled === true;
      logger.debug({ title, id: reward.id }, 'dev helix: reward created');
      return { handled: true, data: { data: [reward] } };
    }

    if (req.method === 'PATCH') {
      const id = String(req.query.id ?? '');
      const reward = rewards.get(id) ?? ensureReward(id, String(body.title ?? 'REWARD'), 1);
      if (body.title !== undefined) reward.title = String(body.title);
      if (body.cost !== undefined) reward.cost = Number(body.cost);
      if (body.prompt !== undefined) reward.prompt = String(body.prompt);
      if (body.is_enabled !== undefined) reward.is_enabled = body.is_enabled === true;
      if (body.is_paused !== undefined) reward.is_paused = body.is_paused === true;
      return { handled: true, data: { data: [reward] } };
    }

    if (req.method === 'DELETE') {
      rewards.delete(String(req.query.id ?? ''));
      return { handled: true, data: undefined };
    }

    // GET — list manageable rewards
    return { handled: true, data: { data: [...rewards.values()] } };
  }

  if (req.path === '/channel_points/custom_rewards/redemptions' && req.method === 'PATCH') {
    logger.debug({ status: body.status, id: req.query.id }, 'dev helix: redemption resolved');
    return { handled: true, data: { data: [{ id: String(req.query.id ?? ''), status: body.status }] } };
  }

  if (req.path === '/eventsub/subscriptions') {
    if (req.method === 'POST') {
      const type = String(body.type ?? '');
      const condition = (body.condition ?? {}) as Record<string, string>;
      const transport = (body.transport ?? {}) as { method?: string; callback?: string };
      const sub: EventSubSubscription = {
        id: stableId(`${type}:${condition.broadcaster_user_id ?? ''}`),
        type,
        version: String(body.version ?? '1'),
        status: 'enabled',
        condition,
        transport: { method: transport.method ?? 'webhook', callback: transport.callback },
        created_at: new Date().toISOString(),
      };
      subscriptions.set(sub.id, sub);
      return { handled: true, data: { data: [sub] } };
    }
    if (req.method === 'DELETE') {
      subscriptions.delete(String(req.query.id ?? ''));
      return { handled: true, data: undefined };
    }
    return { handled: true, data: { data: [...subscriptions.values()], pagination: {} } };
  }

  return { handled: false };
}

export function resetDevHelix(): void {
  rewards.clear();
  subscriptions.clear();
}
