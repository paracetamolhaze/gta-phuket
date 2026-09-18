import { logger } from '../logger.js';
import { query } from '../db/pool.js';
import { redis } from '../redis/client.js';
import { K } from '../redis/keys.js';

/**
 * Live acceptance monitor for the GTA$ economy.
 *
 * Observation only. Almost every step of the flow is already durable — the
 * EventSub event, the ledger row with its balance, the quote, the waypoint —
 * and is read straight from those tables. Two facts are not stored anywhere:
 * that a viewer proved their identity, and that `wallet:updated` actually went
 * out (and to how many of that viewer's sockets). Those two are noted here in a
 * short Redis ring. Noting never throws and never waits: a monitor must not be
 * able to break the thing it watches.
 *
 * Nothing here holds a token: identities are numeric Twitch user ids, which the
 * redemption event carries in the clear anyway.
 */

const RING_SIZE = 500;
const IDENTITY_NOTE_EVERY_SECONDS = 30;

export type AcceptanceNote =
  | {
      kind: 'identity_linked';
      channelId: string;
      userId: string;
      via: 'socket' | 'wallet_read';
    }
  | {
      kind: 'wallet_updated_emitted';
      channelId: string;
      userId: string;
      type: string | null;
      amount: number | null;
      balance: number | null;
      transactionId: string | null;
      /** Sockets in that viewer's wallet room at the moment of the emit. */
      viewerSockets: number | null;
    };

type StoredNote = AcceptanceNote & { ts: number };

function push(note: AcceptanceNote): void {
  const line = JSON.stringify({ ...note, ts: Date.now() });
  void redis
    .multi()
    .lpush(K.acceptanceLog, line)
    .ltrim(K.acceptanceLog, 0, RING_SIZE - 1)
    .exec()
    .catch((err: unknown) => logger.debug({ err }, 'acceptance note dropped'));
}

export function noteAcceptance(note: AcceptanceNote): void {
  try {
    if (note.kind !== 'identity_linked') {
      push(note);
      return;
    }
    // A viewer re-reads the wallet on every event; one line per half minute
    // per path is enough to show that the identity is there.
    void redis
      .set(K.acceptanceSeen(note.channelId, note.userId, note.via), '1', 'EX', IDENTITY_NOTE_EVERY_SECONDS, 'NX')
      .then((first) => {
        if (first === 'OK') push(note);
      })
      .catch((err: unknown) => logger.debug({ err }, 'acceptance note dropped'));
  } catch (err) {
    logger.debug({ err }, 'acceptance note dropped');
  }
}

async function readNotes(channelId: string, sinceMs: number): Promise<StoredNote[]> {
  const lines = await redis.lrange(K.acceptanceLog, 0, RING_SIZE - 1);
  const notes: StoredNote[] = [];
  for (const line of lines) {
    try {
      const note = JSON.parse(line) as StoredNote;
      if (note.channelId === channelId && note.ts >= sinceMs) notes.push(note);
    } catch {
      // A malformed line is simply not shown.
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export const REDEMPTION_ADD = 'channel.channel_points_custom_reward_redemption.add';

export interface RedemptionRow {
  messageId: string;
  receivedAt: number;
  processedAt: number | null;
  attempts: number;
  lastError: string | null;
  redemptionId: string | null;
  rewardId: string | null;
  rewardTitle: string | null;
  cost: number | null;
  userId: string | null;
  userLogin: string | null;
  status: string | null;
}

export interface LedgerRow {
  id: string;
  userId: string;
  type: string;
  amount: number;
  balanceAfter: number;
  redemptionId: string | null;
  rewardId: string | null;
  channelPointsCost: number | null;
  quoteId: string | null;
  waypointId: string | null;
  fulfillment: string | null;
  createdAt: number;
}

export interface QuoteRow {
  id: string;
  userId: string;
  userName: string | null;
  destination: string;
  cost: number;
  currency: string;
  status: string;
  distanceMeters: number;
  createdAt: number;
}

export interface WaypointRow {
  id: string;
  quoteId: string;
  userId: string;
  destination: string;
  cost: number;
  currency: string;
  status: string;
  activatedAt: number;
}

export interface AcceptanceInput {
  now: number;
  exchangeRewardId: string | null;
  exchangeRewardCost: number | null;
  redemptions: RedemptionRow[];
  ledger: LedgerRow[];
  quotes: QuoteRow[];
  waypoints: WaypointRow[];
  notes: StoredNote[];
  balances: Record<string, number>;
}

export interface ChecklistItem {
  key: string;
  label: string;
  ok: boolean;
  value: string | null;
  at: number | null;
}

export interface ViewerAcceptance {
  userId: string;
  userLogin: string | null;
  balance: number | null;
  lastActivity: number;
  checklist: ChecklistItem[];
}

export interface TimelineEntry {
  ts: number;
  userId: string | null;
  userLogin: string | null;
  step: string;
  text: string;
  ok: boolean;
}

export interface AcceptanceReport {
  serverTime: number;
  exchangeRewardId: string | null;
  exchangeRewardCost: number | null;
  viewers: ViewerAcceptance[];
  timeline: TimelineEntry[];
}

const newest = <T>(rows: T[], ts: (row: T) => number): T | null =>
  rows.reduce<T | null>((best, row) => (best === null || ts(row) > ts(best) ? row : best), null);

function gta(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const sign = n < 0 ? '−' : '';
  return `${sign}GTA$ ${String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`;
}

/** Pure: everything above, folded into one checklist per viewer and a timeline. */
export function buildAcceptanceReport(input: AcceptanceInput): AcceptanceReport {
  const exchangeId = input.exchangeRewardId;
  const isExchange = (r: RedemptionRow): boolean => !!exchangeId && r.rewardId === exchangeId;

  const logins = new Map<string, string>();
  for (const r of input.redemptions) if (r.userId && r.userLogin) logins.set(r.userId, r.userLogin);
  for (const q of input.quotes) if (q.userName && !logins.has(q.userId)) logins.set(q.userId, q.userName);

  const users = new Set<string>();
  for (const r of input.redemptions) if (r.userId && isExchange(r)) users.add(r.userId);
  for (const l of input.ledger) users.add(l.userId);
  for (const q of input.quotes) if (q.currency === 'GTA_DOLLAR') users.add(q.userId);
  for (const n of input.notes) users.add(n.userId);

  const viewers: ViewerAcceptance[] = [];
  for (const userId of users) {
    const identity = newest(
      input.notes.filter((n) => n.kind === 'identity_linked' && n.userId === userId),
      (n) => n.ts,
    );
    const redemption = newest(
      input.redemptions.filter((r) => r.userId === userId && isExchange(r)),
      (r) => r.receivedAt,
    );
    const credit =
      (redemption &&
        input.ledger.find((l) => l.type === 'EXCHANGE_CREDIT' && l.redemptionId === redemption.redemptionId)) ||
      newest(
        input.ledger.filter((l) => l.userId === userId && l.type === 'EXCHANGE_CREDIT'),
        (l) => l.createdAt,
      );
    const creditEmit = credit
      ? newest(
          input.notes.filter(
            (n) =>
              n.kind === 'wallet_updated_emitted' &&
              n.userId === userId &&
              (n.transactionId === credit.id || (n.transactionId === null && n.ts >= credit.createdAt)),
          ),
          (n) => n.ts,
        )
      : null;
    const quote = newest(
      input.quotes.filter((q) => q.userId === userId && q.currency === 'GTA_DOLLAR'),
      (q) => q.createdAt,
    );
    const debit = quote
      ? input.ledger.find((l) => l.type === 'WAYPOINT_DEBIT' && l.quoteId === quote.id) ?? null
      : null;
    const waypoint = quote ? input.waypoints.find((w) => w.quoteId === quote.id) ?? null : null;

    const emitNote = creditEmit && creditEmit.kind === 'wallet_updated_emitted' ? creditEmit : null;
    const checklist: ChecklistItem[] = [
      {
        key: 'identity',
        label: 'viewer identity linked',
        ok: !!identity || !!credit || !!quote,
        value: identity
          ? `user_id ${userId} (${identity.kind === 'identity_linked' && identity.via === 'socket' ? 'сокет' : 'кошелёк'})`
          : credit || quote
            ? `user_id ${userId}`
            : null,
        at: identity?.ts ?? null,
      },
      {
        key: 'redemption',
        label: 'exchange redemption received',
        ok: !!redemption,
        value: redemption
          ? `${redemption.processedAt ? 'обработано' : 'в обработке'}${redemption.attempts > 1 ? `, попыток ${redemption.attempts}` : ''}${redemption.lastError ? `, ошибка: ${redemption.lastError.slice(0, 120)}` : ''}`
          : null,
        at: redemption?.receivedAt ?? null,
      },
      { key: 'redemptionId', label: 'redemption id', ok: !!redemption?.redemptionId, value: redemption?.redemptionId ?? null, at: null },
      { key: 'rewardId', label: 'reward id', ok: !!redemption?.rewardId, value: redemption?.rewardId ?? null, at: null },
      {
        key: 'ethCost',
        label: 'ETH cost',
        ok: redemption?.cost != null,
        value: redemption?.cost != null ? `${redemption.cost} ETH` : null,
        at: null,
      },
      {
        key: 'credited',
        label: 'GTA$ credited',
        ok: !!credit,
        value: credit ? `+${gta(credit.amount)} · Twitch: ${credit.fulfillment ?? '—'}` : null,
        at: credit?.createdAt ?? null,
      },
      { key: 'walletBefore', label: 'wallet before', ok: !!credit, value: credit ? gta(credit.balanceAfter - credit.amount) : null, at: null },
      { key: 'walletAfter', label: 'wallet after', ok: !!credit, value: credit ? gta(credit.balanceAfter) : null, at: null },
      {
        key: 'walletUpdated',
        label: 'wallet:updated emitted',
        ok: !!emitNote,
        value: emitNote
          ? `сокетов зрителя онлайн: ${emitNote.viewerSockets ?? '—'}${emitNote.viewerSockets === 0 ? ' (оверлей не подключён — увидит при следующем чтении)' : ''}`
          : null,
        at: emitNote?.ts ?? null,
      },
      {
        key: 'quote',
        label: 'quote created',
        ok: !!quote,
        value: quote ? `${quote.destination} · ${(quote.distanceMeters / 1000).toFixed(1)} km · ${quote.status}` : null,
        at: quote?.createdAt ?? null,
      },
      { key: 'waypointCost', label: 'waypoint cost', ok: !!quote, value: quote ? gta(quote.cost) : null, at: null },
      {
        key: 'debited',
        label: 'GTA$ debited',
        ok: !!debit,
        value: debit ? `${gta(debit.amount)} · ${gta(debit.balanceAfter - debit.amount)} → ${gta(debit.balanceAfter)}` : null,
        at: debit?.createdAt ?? null,
      },
      {
        key: 'waypointActive',
        label: 'waypoint ACTIVE',
        ok: waypoint?.status === 'ACTIVE' || waypoint?.status === 'COMPLETED',
        value: waypoint ? `${waypoint.status} · ${waypoint.destination}` : null,
        at: waypoint?.activatedAt ?? null,
      },
    ];

    const lastActivity = Math.max(
      identity?.ts ?? 0,
      redemption?.receivedAt ?? 0,
      credit?.createdAt ?? 0,
      quote?.createdAt ?? 0,
      waypoint?.activatedAt ?? 0,
    );
    viewers.push({
      userId,
      userLogin: logins.get(userId) ?? null,
      balance: input.balances[userId] ?? null,
      lastActivity,
      checklist,
    });
  }
  viewers.sort((a, b) => b.lastActivity - a.lastActivity);

  const timeline: TimelineEntry[] = [];
  const login = (id: string | null): string | null => (id ? logins.get(id) ?? null : null);
  for (const r of input.redemptions) {
    timeline.push({
      ts: r.receivedAt,
      userId: r.userId,
      userLogin: r.userLogin,
      step: isExchange(r) ? 'exchange redemption' : 'other redemption',
      text: `${r.rewardTitle ?? r.rewardId ?? '?'} · ${r.cost ?? '?'} ETH · ${r.redemptionId ?? '?'}${r.processedAt ? '' : ' · ещё не обработано'}${r.lastError ? ` · ошибка: ${r.lastError.slice(0, 120)}` : ''}`,
      ok: isExchange(r) && !r.lastError,
    });
  }
  for (const l of input.ledger) {
    timeline.push({
      ts: l.createdAt,
      userId: l.userId,
      userLogin: login(l.userId),
      step: l.type,
      text: `${l.amount > 0 ? '+' : ''}${gta(l.amount)} · ${gta(l.balanceAfter - l.amount)} → ${gta(l.balanceAfter)}${l.fulfillment ? ` · Twitch ${l.fulfillment}` : ''}`,
      ok: true,
    });
  }
  for (const n of input.notes) {
    timeline.push(
      n.kind === 'identity_linked'
        ? {
            ts: n.ts,
            userId: n.userId,
            userLogin: login(n.userId),
            step: 'identity linked',
            text: n.via === 'socket' ? 'сокет вошёл в комнату кошелька' : 'кошелёк прочитан с проверенным JWT',
            ok: true,
          }
        : {
            ts: n.ts,
            userId: n.userId,
            userLogin: login(n.userId),
            step: 'wallet:updated',
            text: `${n.type ?? '?'} ${n.amount != null ? `${n.amount > 0 ? '+' : ''}${gta(n.amount)}` : ''} → ${gta(n.balance)} · сокетов онлайн: ${n.viewerSockets ?? '—'}`,
            ok: (n.viewerSockets ?? 0) > 0,
          },
    );
  }
  for (const q of input.quotes) {
    timeline.push({
      ts: q.createdAt,
      userId: q.userId,
      userLogin: q.userName,
      step: 'quote',
      text: `${q.destination} · ${(q.distanceMeters / 1000).toFixed(1)} km · ${q.currency === 'GTA_DOLLAR' ? gta(q.cost) : `${q.cost} pts`} · ${q.status}`,
      ok: q.status !== 'EXPIRED' && q.status !== 'CANCELED',
    });
  }
  for (const w of input.waypoints) {
    timeline.push({
      ts: w.activatedAt,
      userId: w.userId,
      userLogin: login(w.userId),
      step: 'waypoint',
      text: `${w.status} · ${w.destination} · ${w.currency === 'GTA_DOLLAR' ? gta(w.cost) : `${w.cost} pts`}`,
      ok: w.status !== 'CANCELED',
    });
  }
  timeline.sort((a, b) => b.ts - a.ts);

  return {
    serverTime: input.now,
    exchangeRewardId: input.exchangeRewardId,
    exchangeRewardCost: input.exchangeRewardCost,
    viewers,
    timeline: timeline.slice(0, 150),
  };
}

const ts = (value: Date | string | null): number | null => (value ? new Date(value).getTime() : null);

/** Reads the window and builds the report. */
export async function loadAcceptanceReport(channelId: string, minutes: number): Promise<AcceptanceReport> {
  const now = Date.now();
  const since = new Date(now - minutes * 60_000);

  const [reward, redemptions, ledger, quotes, waypoints, notes] = await Promise.all([
    query<{ twitch_reward_id: string; cost: number }>(
      'SELECT twitch_reward_id, cost FROM gta_exchange_rewards WHERE channel_id = $1',
      [channelId],
    ),
    query<{
      message_id: string;
      received_at: Date;
      processed_at: Date | null;
      attempts: number;
      last_error: string | null;
      ev: Record<string, unknown> | null;
    }>(
      `SELECT message_id, received_at, processed_at, attempts, last_error, payload->'event' AS ev
         FROM eventsub_events
        WHERE subscription_type = $1 AND (channel_id = $2 OR channel_id IS NULL) AND received_at >= $3
        ORDER BY received_at DESC LIMIT 200`,
      [REDEMPTION_ADD, channelId, since],
    ),
    query<{
      id: string;
      twitch_user_id: string;
      type: string;
      amount: string;
      balance_after: string;
      twitch_redemption_id: string | null;
      twitch_reward_id: string | null;
      channel_points_cost: number | null;
      quote_id: string | null;
      waypoint_id: string | null;
      fulfillment_status: string | null;
      created_at: Date;
    }>(
      `SELECT id, twitch_user_id, type, amount, balance_after, twitch_redemption_id, twitch_reward_id,
              channel_points_cost, quote_id, waypoint_id, fulfillment_status, created_at
         FROM gta_wallet_transactions
        WHERE channel_id = $1 AND created_at >= $2
        ORDER BY created_at DESC LIMIT 300`,
      [channelId, since],
    ),
    query<{
      id: string;
      twitch_user_id: string;
      twitch_user_name: string | null;
      dest_name: string;
      cost: number;
      currency: string;
      status: string;
      distance_meters: number;
      created_at: Date;
    }>(
      `SELECT id, twitch_user_id, twitch_user_name, dest_name, cost, currency, status, distance_meters, created_at
         FROM waypoint_quotes
        WHERE channel_id = $1 AND created_at >= $2
        ORDER BY created_at DESC LIMIT 200`,
      [channelId, since],
    ),
    query<{
      id: string;
      quote_id: string;
      twitch_user_id: string;
      dest_name: string;
      points_paid: number;
      currency: string;
      status: string;
      activated_at: Date;
    }>(
      `SELECT id, quote_id, twitch_user_id, dest_name, points_paid, currency, status, activated_at
         FROM waypoints
        WHERE channel_id = $1 AND activated_at >= $2
        ORDER BY activated_at DESC LIMIT 100`,
      [channelId, since],
    ),
    readNotes(channelId, since.getTime()),
  ]);

  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const redemptionRows: RedemptionRow[] = redemptions.rows.map((row) => {
    const ev = row.ev ?? {};
    const rewardObj = (ev.reward ?? {}) as Record<string, unknown>;
    const cost = Number(rewardObj.cost);
    return {
      messageId: row.message_id,
      receivedAt: ts(row.received_at) ?? now,
      processedAt: ts(row.processed_at),
      attempts: row.attempts,
      lastError: row.last_error,
      redemptionId: str(ev.id),
      rewardId: str(rewardObj.id),
      rewardTitle: str(rewardObj.title),
      cost: Number.isFinite(cost) ? cost : null,
      userId: str(ev.user_id),
      userLogin: str(ev.user_login),
      status: str(ev.status),
    };
  });

  const ledgerRows: LedgerRow[] = ledger.rows.map((row) => ({
    id: row.id,
    userId: row.twitch_user_id,
    type: row.type,
    amount: Number(row.amount),
    balanceAfter: Number(row.balance_after),
    redemptionId: row.twitch_redemption_id,
    rewardId: row.twitch_reward_id,
    channelPointsCost: row.channel_points_cost,
    quoteId: row.quote_id,
    waypointId: row.waypoint_id,
    fulfillment: row.fulfillment_status,
    createdAt: ts(row.created_at) ?? now,
  }));

  const users = new Set<string>([
    ...ledgerRows.map((l) => l.userId),
    ...quotes.rows.map((q) => q.twitch_user_id),
    ...notes.map((n) => n.userId),
    ...redemptionRows.map((r) => r.userId).filter((u): u is string => !!u),
  ]);
  const balances: Record<string, number> = {};
  if (users.size) {
    const { rows } = await query<{ twitch_user_id: string; balance: string }>(
      'SELECT twitch_user_id, balance FROM gta_wallets WHERE channel_id = $1 AND twitch_user_id = ANY($2)',
      [channelId, [...users]],
    );
    for (const row of rows) balances[row.twitch_user_id] = Number(row.balance);
  }

  return buildAcceptanceReport({
    now,
    exchangeRewardId: reward.rows[0]?.twitch_reward_id ?? null,
    exchangeRewardCost: reward.rows[0]?.cost ?? null,
    redemptions: redemptionRows,
    ledger: ledgerRows,
    quotes: quotes.rows.map((q) => ({
      id: q.id,
      userId: q.twitch_user_id,
      userName: q.twitch_user_name,
      destination: q.dest_name,
      cost: q.cost,
      currency: q.currency,
      status: q.status,
      distanceMeters: q.distance_meters,
      createdAt: ts(q.created_at) ?? now,
    })),
    waypoints: waypoints.rows.map((w) => ({
      id: w.id,
      quoteId: w.quote_id,
      userId: w.twitch_user_id,
      destination: w.dest_name,
      cost: w.points_paid,
      currency: w.currency,
      status: w.status,
      activatedAt: ts(w.activated_at) ?? now,
    })),
    notes,
    balances,
  });
}
