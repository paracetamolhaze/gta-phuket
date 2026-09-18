import { createHash, randomUUID } from 'node:crypto';
import { env } from '../env.js';
import { logger } from '../logger.js';
import type {
  CustomReward,
  CustomRewardRedemption,
  EventSubSubscription,
  RedemptionStatus,
} from './helix.js';

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
 * so anything that would break against real Twitch breaks here too — including
 * the refusals the GTA$ exchange depends on: a duplicate reward title is a 400,
 * an unknown reward is a 404, and a redemption that is no longer UNFULFILLED
 * cannot be updated again.
 */

export function twitchConfigured(): boolean {
  return Boolean(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);
}

/**
 * The stub is only ever used when there is no real Twitch application to talk
 * to AND real mode is off. REAL_TWITCH is checked first and on its own, so that
 * turning it on can never silently leave a simulated reward in the flow.
 */
export function useDevHelix(): boolean {
  if (env.realTwitch) return false;
  return env.devModeEnabled && !twitchConfigured();
}

const rewards = new Map<string, CustomReward>();
const subscriptions = new Map<string, EventSubSubscription>();
/**
 * Redemptions the stub has heard of. Twitch knows every redemption from the
 * moment a viewer makes it; the stub only learns of one when something
 * mentions it, so an unknown id is treated as a fresh UNFULFILLED one.
 */
const redemptions = new Map<string, CustomRewardRedemption>();

interface InjectedFailure {
  method: string;
  path: string;
  status: number;
  remaining: number;
}
const failures: InjectedFailure[] = [];

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

function refusal(status: number, message: string): { handled: true; status: number; data: unknown } {
  const error = status === 404 ? 'Not Found' : status === 400 ? 'Bad Request' : 'Error';
  return { handled: true, status, data: { error, status, message } };
}

export interface DevHelixRequest {
  path: string;
  method: string;
  query: Record<string, string | number | boolean | undefined>;
  body: unknown;
}

export interface DevHelixResult {
  handled: boolean;
  data?: unknown;
  /** HTTP status Twitch would have answered with; >= 400 is a refusal. */
  status?: number;
}

/** Returns `{ handled: false }` for anything the stub does not model. */
export function devHelix(req: DevHelixRequest): DevHelixResult {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const injected = failures.find(
    (f) => f.remaining > 0 && f.method === req.method && f.path === req.path,
  );
  if (injected) {
    injected.remaining -= 1;
    return refusal(injected.status, 'dev helix: injected failure');
  }

  if (req.path === '/users') {
    const id = String(req.query.id ?? '0');
    return { handled: true, data: { data: [{ id, login: `dev_${id}`, display_name: `Dev ${id}` }] } };
  }

  if (req.path === '/channel_points/custom_rewards') {
    const broadcasterId = String(req.query.broadcaster_id ?? 'dev');

    if (req.method === 'POST') {
      const title = String(body.title ?? 'REWARD');
      // Twitch refuses a second reward with the same title on one channel.
      if ([...rewards.values()].some((r) => r.title === title)) {
        return refusal(400, 'CREATE_CUSTOM_REWARD_DUPLICATE_REWARD');
      }
      // The id is stable per title so a restarted dev server finds the same
      // rewards again, unless a renamed reward already holds it.
      const seeded = stableId(`${broadcasterId}:${title}`);
      const id = rewards.has(seeded) ? stableId(randomUUID()) : seeded;
      const reward = ensureReward(id, title, Number(body.cost ?? 1));
      reward.prompt = String(body.prompt ?? '');
      reward.is_enabled = body.is_enabled === true;
      if (typeof body.background_color === 'string') reward.background_color = body.background_color;
      reward.should_redemptions_skip_request_queue =
        body.should_redemptions_skip_request_queue === true;
      logger.debug({ title, id: reward.id }, 'dev helix: reward created');
      return { handled: true, data: { data: [reward] } };
    }

    if (req.method === 'PATCH') {
      const id = String(req.query.id ?? '');
      const reward = rewards.get(id);
      if (!reward) return refusal(404, 'reward not found');
      if (body.title !== undefined) reward.title = String(body.title);
      if (body.cost !== undefined) reward.cost = Number(body.cost);
      if (body.prompt !== undefined) reward.prompt = String(body.prompt);
      if (body.is_enabled !== undefined) reward.is_enabled = body.is_enabled === true;
      if (body.is_paused !== undefined) reward.is_paused = body.is_paused === true;
      if (body.background_color !== undefined) reward.background_color = String(body.background_color);
      return { handled: true, data: { data: [reward] } };
    }

    if (req.method === 'DELETE') {
      rewards.delete(String(req.query.id ?? ''));
      return { handled: true, data: undefined };
    }

    // GET — one reward by id (404 when it is gone), or every manageable one.
    if (req.query.id !== undefined) {
      const reward = rewards.get(String(req.query.id));
      if (!reward) return refusal(404, 'reward not found');
      return { handled: true, data: { data: [reward] } };
    }
    return { handled: true, data: { data: [...rewards.values()] } };
  }

  if (req.path === '/channel_points/custom_rewards/redemptions') {
    const id = String(req.query.id ?? '');
    const rewardId = String(req.query.reward_id ?? '');

    if (req.method === 'PATCH') {
      const current = redemptions.get(id);
      // Only an UNFULFILLED redemption can be resolved, and only once.
      if (current && current.status !== 'UNFULFILLED') {
        return refusal(404, 'redemption not found or not UNFULFILLED');
      }
      const status = String(body.status ?? '') as RedemptionStatus;
      const next: CustomRewardRedemption = { id, status, reward: { id: rewardId } };
      redemptions.set(id, next);
      logger.debug({ status, id }, 'dev helix: redemption resolved');
      return { handled: true, data: { data: [next] } };
    }

    if (req.method === 'GET') {
      const known = redemptions.get(id);
      return { handled: true, data: { data: known ? [known] : [] } };
    }
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
  redemptions.clear();
  failures.length = 0;
}

/**
 * Stand in for something that happened on Twitch's side, out of our sight:
 * a viewer's redemption sitting in the queue, or a moderator resolving it.
 */
export function setDevRedemption(id: string, rewardId: string, status: RedemptionStatus): void {
  redemptions.set(id, { id, status, reward: { id: rewardId } });
}

/** Tests only: answer the next `times` matching calls with an HTTP error. */
export function failNextDevHelix(method: string, path: string, status: number, times = 1): void {
  failures.push({ method, path, status, remaining: times });
}
