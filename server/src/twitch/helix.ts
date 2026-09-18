import { env } from '../env.js';
import { logger } from '../logger.js';
import { AppError } from '../domain/types.js';
import { getAppAccessToken, getBroadcasterAccessToken } from './tokens.js';
import { devHelix, useDevHelix } from './devHelix.js';

const HELIX = 'https://api.twitch.tv/helix';

export interface CustomReward {
  id: string;
  title: string;
  cost: number;
  prompt: string;
  is_enabled: boolean;
  is_paused: boolean;
  is_in_stock: boolean;
  is_user_input_required: boolean;
  should_redemptions_skip_request_queue: boolean;
  background_color: string;
}

export interface EventSubSubscription {
  id: string;
  type: string;
  version: string;
  status: string;
  condition: Record<string, string>;
  transport: { method: string; callback?: string };
  created_at: string;
}

export type RedemptionStatus = 'UNFULFILLED' | 'FULFILLED' | 'CANCELED';

export interface CustomRewardRedemption {
  id: string;
  status: RedemptionStatus;
  reward: { id: string };
}

/**
 * A non-2xx answer from Twitch. Keeps the HTTP status, because a few callers
 * must tell "Twitch says no" (400/404: the thing is gone or already resolved)
 * apart from "Twitch is unreachable" (worth retrying as is).
 */
export class TwitchApiError extends AppError {
  constructor(
    public readonly twitchStatus: number,
    message: string,
  ) {
    super('provider_error', message, twitchStatus === 429 ? 429 : 502);
  }
}

/** The Twitch HTTP status behind an error, or null when it never got an answer. */
export function twitchStatusOf(err: unknown): number | null {
  const status = (err as { twitchStatus?: unknown } | null)?.twitchStatus;
  return typeof status === 'number' ? status : null;
}

type Auth = { kind: 'app' } | { kind: 'broadcaster'; channelId: string };

interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  auth: Auth;
  /** Internal: set while retrying once after a 401. */
  retried?: boolean;
}

async function tokenFor(auth: Auth, force = false): Promise<string> {
  return auth.kind === 'app'
    ? getAppAccessToken(force)
    : getBroadcasterAccessToken(auth.channelId);
}

async function helix<T>(path: string, opts: RequestOptions): Promise<T> {
  // Local development without a Twitch application: serve the handful of calls
  // this app makes from an in-process stub. Never active in production.
  if (useDevHelix()) {
    const stub = devHelix({
      path,
      method: opts.method ?? 'GET',
      query: opts.query ?? {},
      body: opts.body,
    });
    if (stub.handled) {
      // The stub refuses what Twitch refuses, in the same shape, so the error
      // paths run offline too.
      if (stub.status !== undefined && stub.status >= 400) {
        throw new TwitchApiError(
          stub.status,
          `Twitch API ${stub.status} on ${opts.method ?? 'GET'} ${path}: ${JSON.stringify(stub.data ?? {})}`,
        );
      }
      return stub.data as T;
    }
  }

  if (!env.TWITCH_CLIENT_ID) {
    throw new AppError('internal', 'TWITCH_CLIENT_ID is not configured', 500);
  }

  const url = new URL(`${HELIX}${path}`);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) url.searchParams.append(key, String(value));
  }

  const token = await tokenFor(opts.auth, false);
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-Id': env.TWITCH_CLIENT_ID,
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  if (res.status === 401 && !opts.retried) {
    // App tokens can be revoked server-side; force a fresh one and retry once.
    if (opts.auth.kind === 'app') await getAppAccessToken(true);
    return helix<T>(path, { ...opts, retried: true });
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  if (!res.ok) {
    logger.warn({ path, status: res.status, body: text.slice(0, 400) }, 'helix request failed');
    throw new TwitchApiError(
      res.status,
      `Twitch API ${res.status} on ${opts.method ?? 'GET'} ${path}: ${text.slice(0, 300)}`,
    );
  }

  return (text ? JSON.parse(text) : undefined) as T;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function getUserById(
  userId: string,
): Promise<{ id: string; login: string; display_name: string } | null> {
  const data = await helix<{ data: { id: string; login: string; display_name: string }[] }>(
    '/users',
    { auth: { kind: 'app' }, query: { id: userId } },
  );
  return data.data[0] ?? null;
}

// ---------------------------------------------------------------------------
// Channel Points Custom Rewards
//
// Twitch only lets an application read or edit the rewards it created itself,
// which is why the pool is created by this same client id.
// ---------------------------------------------------------------------------

export interface CreateRewardInput {
  title: string;
  cost: number;
  prompt?: string;
  isEnabled?: boolean;
  backgroundColor?: string;
  isUserInputRequired?: boolean;
  /**
   * Must stay false. A redemption that skips the request queue is FULFILLED on
   * arrival and can never be refunded, and refunding losers is the whole point
   * of the slot pool. The exchange reward relies on it too: its redemption is
   * only marked FULFILLED once the GTA$ credit has committed.
   */
  shouldSkipRequestQueue?: false;
  isGlobalCooldownEnabled?: boolean;
  globalCooldownSeconds?: number;
}

export async function createCustomReward(
  channelId: string,
  input: CreateRewardInput,
): Promise<CustomReward> {
  const data = await helix<{ data: CustomReward[] }>('/channel_points/custom_rewards', {
    method: 'POST',
    auth: { kind: 'broadcaster', channelId },
    query: { broadcaster_id: channelId },
    body: {
      title: input.title,
      cost: input.cost,
      prompt: input.prompt ?? '',
      is_enabled: input.isEnabled ?? false,
      background_color: input.backgroundColor ?? '#FFC247',
      is_user_input_required: input.isUserInputRequired ?? false,
      should_redemptions_skip_request_queue: false,
      is_global_cooldown_enabled: input.isGlobalCooldownEnabled ?? false,
      global_cooldown_seconds: input.globalCooldownSeconds ?? 0,
    },
  });
  const reward = data.data[0];
  if (!reward) throw new AppError('provider_error', 'Twitch returned no reward', 502);
  return reward;
}

export interface UpdateRewardInput {
  title?: string;
  cost?: number;
  prompt?: string;
  isEnabled?: boolean;
  isPaused?: boolean;
  backgroundColor?: string;
}

export async function updateCustomReward(
  channelId: string,
  rewardId: string,
  input: UpdateRewardInput,
): Promise<CustomReward> {
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) body.title = input.title;
  if (input.cost !== undefined) body.cost = input.cost;
  if (input.prompt !== undefined) body.prompt = input.prompt;
  if (input.isEnabled !== undefined) body.is_enabled = input.isEnabled;
  if (input.isPaused !== undefined) body.is_paused = input.isPaused;
  if (input.backgroundColor !== undefined) body.background_color = input.backgroundColor;

  const data = await helix<{ data: CustomReward[] }>('/channel_points/custom_rewards', {
    method: 'PATCH',
    auth: { kind: 'broadcaster', channelId },
    query: { broadcaster_id: channelId, id: rewardId },
    body,
  });
  const reward = data.data[0];
  if (!reward) throw new AppError('provider_error', 'Twitch returned no reward', 502);
  return reward;
}

export async function listManagedRewards(channelId: string): Promise<CustomReward[]> {
  const data = await helix<{ data: CustomReward[] }>('/channel_points/custom_rewards', {
    auth: { kind: 'broadcaster', channelId },
    query: { broadcaster_id: channelId, only_manageable_rewards: true },
  });
  return data.data ?? [];
}

/**
 * One reward of ours by id, or null when Twitch no longer has it (deleted in
 * the dashboard). Any other failure throws: "could not ask" is not "gone".
 */
export async function getCustomReward(
  channelId: string,
  rewardId: string,
): Promise<CustomReward | null> {
  try {
    const data = await helix<{ data: CustomReward[] }>('/channel_points/custom_rewards', {
      auth: { kind: 'broadcaster', channelId },
      query: { broadcaster_id: channelId, id: rewardId, only_manageable_rewards: true },
    });
    return data.data?.find((r) => r.id === rewardId) ?? null;
  } catch (err) {
    if (twitchStatusOf(err) === 404) return null;
    throw err;
  }
}

export async function deleteCustomReward(channelId: string, rewardId: string): Promise<void> {
  await helix<void>('/channel_points/custom_rewards', {
    method: 'DELETE',
    auth: { kind: 'broadcaster', channelId },
    query: { broadcaster_id: channelId, id: rewardId },
  });
}

/**
 * FULFILLED keeps the viewer's points. CANCELED returns them — this is the only
 * refund mechanism Twitch offers, and it only works while the redemption is
 * still UNFULFILLED in the request queue.
 */
export async function updateRedemptionStatus(
  channelId: string,
  rewardId: string,
  redemptionId: string,
  status: 'FULFILLED' | 'CANCELED',
): Promise<void> {
  await helix<{ data: unknown[] }>('/channel_points/custom_rewards/redemptions', {
    method: 'PATCH',
    auth: { kind: 'broadcaster', channelId },
    query: { broadcaster_id: channelId, reward_id: rewardId, id: redemptionId },
    body: { status },
  });
}

/**
 * Where Twitch thinks a redemption stands. Used to settle an ambiguous
 * status update: a 400/404 on PATCH may mean "already fulfilled" or "a
 * moderator cancelled it in the queue", and only a read tells which.
 */
export async function getRedemption(
  channelId: string,
  rewardId: string,
  redemptionId: string,
): Promise<CustomRewardRedemption | null> {
  const data = await helix<{ data: CustomRewardRedemption[] }>(
    '/channel_points/custom_rewards/redemptions',
    {
      auth: { kind: 'broadcaster', channelId },
      query: { broadcaster_id: channelId, reward_id: rewardId, id: redemptionId },
    },
  );
  return data.data?.find((r) => r.id === redemptionId) ?? null;
}

// ---------------------------------------------------------------------------
// EventSub (webhook transport uses an app access token)
// ---------------------------------------------------------------------------

export async function listEventSubSubscriptions(): Promise<EventSubSubscription[]> {
  const out: EventSubSubscription[] = [];
  let cursor: string | undefined;
  do {
    const page = await helix<{
      data: EventSubSubscription[];
      pagination?: { cursor?: string };
    }>('/eventsub/subscriptions', { auth: { kind: 'app' }, query: { after: cursor } });
    out.push(...(page.data ?? []));
    cursor = page.pagination?.cursor;
  } while (cursor);
  return out;
}

export async function createEventSubSubscription(input: {
  type: string;
  version: string;
  condition: Record<string, string>;
  callback: string;
  secret: string;
}): Promise<EventSubSubscription> {
  const data = await helix<{ data: EventSubSubscription[] }>('/eventsub/subscriptions', {
    method: 'POST',
    auth: { kind: 'app' },
    body: {
      type: input.type,
      version: input.version,
      condition: input.condition,
      transport: { method: 'webhook', callback: input.callback, secret: input.secret },
    },
  });
  const sub = data.data[0];
  if (!sub) throw new AppError('provider_error', 'Twitch returned no subscription', 502);
  return sub;
}

export async function deleteEventSubSubscription(id: string): Promise<void> {
  await helix<void>('/eventsub/subscriptions', {
    method: 'DELETE',
    auth: { kind: 'app' },
    query: { id },
  });
}
