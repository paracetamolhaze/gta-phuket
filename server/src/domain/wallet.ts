import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool.js';
import {
  AppError,
  type EconomyInfo,
  type FulfillmentStatus,
  type WalletTransaction,
  type WalletTransactionType,
  type WalletView,
} from './types.js';

/**
 * The GTA$ ledger.
 *
 * Every balance change in the system goes through `appendEntry`: one ledger
 * row and one balance update, inside the caller's transaction, with the
 * wallet row held FOR UPDATE. That is what keeps sum(amount) equal to the
 * balance, and it is why nothing here ever sets a balance directly.
 *
 * The unique indexes from 005_gta_dollar.sql are the last line: a redemption
 * credits once, a quote is charged once, a waypoint is refunded once, even if
 * the Redis dedupe, the locks and this code were all wrong at the same time.
 */

export const GTA_SYMBOL = 'GTA$';
/** After this many failed attempts an exchange fulfilment is left for a human. */
export const MAX_FULFILLMENT_ATTEMPTS = 10;

const TWITCH_USER_ID = /^[0-9]{1,20}$/;

interface TransactionRow {
  id: string;
  channel_id: string;
  twitch_user_id: string;
  type: string;
  amount: number;
  balance_after: number;
  twitch_redemption_id: string | null;
  twitch_reward_id: string | null;
  channel_points_cost: number | null;
  quote_id: string | null;
  waypoint_id: string | null;
  fulfillment_status: string | null;
  fulfillment_attempts: number;
  created_at: Date;
}

function rowToTransaction(row: TransactionRow): WalletTransaction {
  return {
    id: row.id,
    channelId: row.channel_id,
    twitchUserId: row.twitch_user_id,
    type: row.type as WalletTransactionType,
    amount: row.amount,
    balanceAfter: row.balance_after,
    twitchRedemptionId: row.twitch_redemption_id,
    twitchRewardId: row.twitch_reward_id,
    channelPointsCost: row.channel_points_cost,
    quoteId: row.quote_id,
    waypointId: row.waypoint_id,
    fulfillmentStatus: row.fulfillment_status as FulfillmentStatus | null,
    fulfillmentAttempts: row.fulfillment_attempts,
    createdAt: row.created_at.getTime(),
  };
}

/** Postgres unique violation, optionally on one named constraint or index. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pgErr = err as { code?: string; constraint?: string } | null;
  if (pgErr?.code !== '23505') return false;
  return constraint === undefined || pgErr.constraint === constraint;
}

// ---------------------------------------------------------------------------
// Primitives (inside the caller's transaction)
// ---------------------------------------------------------------------------

/**
 * Create the wallet if it is new, then hold its row lock until the caller's
 * transaction ends. Returns the balance as of the lock. Anything that changes
 * a balance must come through here first, so concurrent changes to one wallet
 * queue up instead of reading the same starting balance.
 */
export async function lockWallet(
  client: PoolClient,
  channelId: string,
  twitchUserId: string,
): Promise<number> {
  if (!TWITCH_USER_ID.test(twitchUserId)) {
    // The database CHECK would refuse it too; this just says why.
    throw new Error('a wallet belongs to a numeric Twitch user id');
  }
  await client.query(
    `INSERT INTO gta_wallets (channel_id, twitch_user_id) VALUES ($1, $2)
     ON CONFLICT (channel_id, twitch_user_id) DO NOTHING`,
    [channelId, twitchUserId],
  );
  const { rows } = await client.query<{ balance: number }>(
    `SELECT balance FROM gta_wallets
      WHERE channel_id = $1 AND twitch_user_id = $2
      FOR UPDATE`,
    [channelId, twitchUserId],
  );
  const balance = rows[0]?.balance;
  if (balance === undefined) throw new Error('wallet row vanished under its own lock');
  return balance;
}

interface LedgerEntry {
  channelId: string;
  twitchUserId: string;
  type: WalletTransactionType;
  amount: number;
  /** Balance held under lockWallet before this entry. */
  balanceBefore: number;
  twitchRedemptionId?: string;
  twitchRewardId?: string;
  channelPointsCost?: number;
  quoteId?: string;
  waypointId?: string;
  fulfillmentStatus?: FulfillmentStatus;
  metadata?: Record<string, unknown>;
}

/**
 * The "at most once" key of an entry kind whose repeat is an expected answer
 * ("already done") rather than an error: the insert is skipped and the balance
 * left untouched. A repeated debit, by contrast, is a unique violation that
 * rolls the whole purchase back.
 */
type DuplicateKey = 'redemption' | 'refund';

const ON_CONFLICT: Record<DuplicateKey, string> = {
  redemption: 'ON CONFLICT (twitch_redemption_id) DO NOTHING',
  refund: `ON CONFLICT (waypoint_id) WHERE type = 'MISSION_REFUND' DO NOTHING`,
};

/**
 * Ledger row first, then the balance, in the caller's transaction and under
 * the wallet lock. Returns null when `skipIfDuplicate` found the entry
 * already booked.
 */
async function appendEntry(
  client: PoolClient,
  entry: LedgerEntry,
  skipIfDuplicate?: DuplicateKey,
): Promise<{ transactionId: string; balance: number } | null> {
  if (!Number.isSafeInteger(entry.amount) || entry.amount === 0) {
    throw new Error(`refusing a ledger entry of ${entry.amount}`);
  }
  const balanceAfter = entry.balanceBefore + entry.amount;
  if (balanceAfter < 0) {
    throw new AppError('insufficient_funds', 'Не хватает GTA$', 402, {
      balance: entry.balanceBefore,
      cost: -entry.amount,
    });
  }

  const transactionId = randomUUID();
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO gta_wallet_transactions
       (id, channel_id, twitch_user_id, type, amount, balance_after,
        twitch_redemption_id, twitch_reward_id, channel_points_cost,
        quote_id, waypoint_id, fulfillment_status, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
     ${skipIfDuplicate ? ON_CONFLICT[skipIfDuplicate] : ''}
     RETURNING id`,
    [
      transactionId,
      entry.channelId,
      entry.twitchUserId,
      entry.type,
      entry.amount,
      balanceAfter,
      entry.twitchRedemptionId ?? null,
      entry.twitchRewardId ?? null,
      entry.channelPointsCost ?? null,
      entry.quoteId ?? null,
      entry.waypointId ?? null,
      entry.fulfillmentStatus ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
  if (!rows[0]) return null;

  const updated = await client.query<{ balance: number }>(
    `UPDATE gta_wallets SET balance = balance + $3, updated_at = now()
      WHERE channel_id = $1 AND twitch_user_id = $2
      RETURNING balance`,
    [entry.channelId, entry.twitchUserId, entry.amount],
  );
  // Only possible if someone changed the balance without taking the lock;
  // throwing rolls the entry back rather than booking a ledger that lies.
  if (updated.rows[0]?.balance !== balanceAfter) {
    throw new Error('wallet balance moved outside its row lock');
  }
  return { transactionId, balance: balanceAfter };
}

/**
 * Charge a waypoint purchase. The caller holds the quote lock and the wallet
 * lock (`balanceBefore` comes from lockWallet) and has already checked funds;
 * a second debit for the same quote is a unique violation that rolls the whole
 * purchase back.
 */
export async function debitForWaypoint(
  client: PoolClient,
  input: {
    channelId: string;
    twitchUserId: string;
    quoteId: string;
    waypointId: string;
    cost: number;
    balanceBefore: number;
  },
): Promise<{ transactionId: string; balance: number }> {
  const booked = await appendEntry(client, {
    channelId: input.channelId,
    twitchUserId: input.twitchUserId,
    type: 'WAYPOINT_DEBIT',
    amount: -input.cost,
    balanceBefore: input.balanceBefore,
    quoteId: input.quoteId,
    waypointId: input.waypointId,
  });
  if (!booked) throw new Error('debit insert returned no row');
  return booked;
}

export type RefundOutcome =
  | {
      refunded: true;
      amount: number;
      balance: number;
      transactionId: string;
      twitchUserId: string;
    }
  | { refunded: false; amount: 0 };

/**
 * Give a waypoint's GTA$ back to whoever paid for it, at most once.
 *
 * The amount and the owner come from the waypoint's own debit, not from the
 * caller: the ledger already knows exactly who paid what. A waypoint with no
 * debit (paid in Channel Points, or placed by hand) refunds nothing.
 */
export async function refundWaypoint(
  client: PoolClient,
  input: { channelId: string; waypointId: string; reason: string },
): Promise<RefundOutcome> {
  const { rows } = await client.query<{ twitch_user_id: string; amount: number; quote_id: string }>(
    `SELECT twitch_user_id, amount, quote_id FROM gta_wallet_transactions
      WHERE channel_id = $1 AND waypoint_id = $2 AND type = 'WAYPOINT_DEBIT'`,
    [input.channelId, input.waypointId],
  );
  const debit = rows[0];
  if (!debit) return { refunded: false, amount: 0 };

  const amount = -debit.amount;
  const balanceBefore = await lockWallet(client, input.channelId, debit.twitch_user_id);
  const booked = await appendEntry(
    client,
    {
      channelId: input.channelId,
      twitchUserId: debit.twitch_user_id,
      type: 'MISSION_REFUND',
      amount,
      balanceBefore,
      waypointId: input.waypointId,
      metadata: { reason: input.reason.slice(0, 200), quoteId: debit.quote_id },
    },
    'refund',
  );
  if (!booked) return { refunded: false, amount: 0 };
  return {
    refunded: true,
    amount,
    balance: booked.balance,
    transactionId: booked.transactionId,
    twitchUserId: debit.twitch_user_id,
  };
}

// ---------------------------------------------------------------------------
// Whole operations (own transaction)
// ---------------------------------------------------------------------------

export interface ExchangeCreditInput {
  channelId: string;
  twitchUserId: string;
  redemptionId: string;
  rewardId: string;
  /** What Twitch actually charged, in ETH. */
  channelPointsCost: number;
  amount: number;
  metadata?: Record<string, unknown>;
}

export type ExchangeCreditOutcome =
  | { outcome: 'credited'; transactionId: string; amount: number; balance: number }
  | { outcome: 'duplicate' };

/**
 * Book one exchange redemption. The redemption id is unique in the ledger, so
 * a redelivery — even hours later, even after Redis lost every marker — finds
 * the first credit and changes nothing.
 */
export async function creditExchange(input: ExchangeCreditInput): Promise<ExchangeCreditOutcome> {
  return withTransaction(async (client) => {
    const balanceBefore = await lockWallet(client, input.channelId, input.twitchUserId);
    const booked = await appendEntry(
      client,
      {
        channelId: input.channelId,
        twitchUserId: input.twitchUserId,
        type: 'EXCHANGE_CREDIT',
        amount: input.amount,
        balanceBefore,
        twitchRedemptionId: input.redemptionId,
        twitchRewardId: input.rewardId,
        channelPointsCost: input.channelPointsCost,
        fulfillmentStatus: 'PENDING',
        metadata: input.metadata,
      },
      'redemption',
    );
    if (!booked) return { outcome: 'duplicate' as const };
    return { outcome: 'credited' as const, amount: input.amount, ...booked };
  });
}

/**
 * A manual correction by the channel owner, e.g. taking back GTA$ whose
 * exchange redemption a moderator cancelled on Twitch. Recorded in the ledger
 * like everything else; it can never push a balance below zero.
 */
export async function adjustBalance(input: {
  channelId: string;
  twitchUserId: string;
  amount: number;
  reason: string;
}): Promise<{ transactionId: string; balance: number }> {
  return withTransaction(async (client) => {
    const balanceBefore = await lockWallet(client, input.channelId, input.twitchUserId);
    const booked = await appendEntry(client, {
      channelId: input.channelId,
      twitchUserId: input.twitchUserId,
      type: 'ADMIN_ADJUSTMENT',
      amount: input.amount,
      balanceBefore,
      metadata: { reason: input.reason.slice(0, 200) },
    });
    if (!booked) throw new Error('adjustment insert returned no row');
    return booked;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** 0 for a viewer who never had GTA$. Reading never creates a wallet. */
export async function getBalance(channelId: string, twitchUserId: string): Promise<number> {
  const { rows } = await query<{ balance: number }>(
    'SELECT balance FROM gta_wallets WHERE channel_id = $1 AND twitch_user_id = $2',
    [channelId, twitchUserId],
  );
  return rows[0]?.balance ?? 0;
}

export async function listWalletTransactions(
  channelId: string,
  twitchUserId: string,
  limit = 10,
): Promise<WalletTransaction[]> {
  const { rows } = await query<TransactionRow>(
    `SELECT * FROM gta_wallet_transactions
      WHERE channel_id = $1 AND twitch_user_id = $2
      ORDER BY created_at DESC, id
      LIMIT $3`,
    [channelId, twitchUserId, limit],
  );
  return rows.map(rowToTransaction);
}

export async function listRecentLedger(channelId: string, limit = 20): Promise<WalletTransaction[]> {
  const { rows } = await query<TransactionRow>(
    `SELECT * FROM gta_wallet_transactions
      WHERE channel_id = $1
      ORDER BY created_at DESC, id
      LIMIT $2`,
    [channelId, limit],
  );
  return rows.map(rowToTransaction);
}

/** Exactly what GET /api/ext/wallet returns, for one verified viewer. */
export async function buildWalletView(
  channelId: string,
  twitchUserId: string,
  economy: EconomyInfo,
): Promise<WalletView> {
  const [balance, recent] = await Promise.all([
    getBalance(channelId, twitchUserId),
    listWalletTransactions(channelId, twitchUserId, 10),
  ]);
  return {
    currency: 'GTA_DOLLAR',
    symbol: GTA_SYMBOL,
    balance,
    exchangeRate: economy.exchangeRate,
    exchange: {
      rewardTitle: economy.rewardTitle,
      rewardCost: economy.rewardCost,
      gtaPerRedemption: economy.gtaPerRedemption,
      available: economy.available,
    },
    recent: recent.map((t) => ({
      id: t.id,
      type: t.type,
      amount: t.amount,
      balanceAfter: t.balanceAfter,
      createdAt: new Date(t.createdAt).toISOString(),
    })),
  };
}

export interface EconomyTotals {
  /** Σ EXCHANGE_CREDIT */
  issued: number;
  /** −Σ WAYPOINT_DEBIT */
  spent: number;
  /** Σ MISSION_REFUND */
  refunded: number;
  /** Σ ADMIN_ADJUSTMENT (signed) */
  adjusted: number;
  /** Σ balances */
  circulating: number;
  wallets: number;
}

export async function economyTotals(channelId: string): Promise<EconomyTotals> {
  const [ledger, wallets] = await Promise.all([
    query<{ issued: number; spent: number; refunded: number; adjusted: number }>(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE type = 'EXCHANGE_CREDIT'), 0)::bigint   AS issued,
         COALESCE(-SUM(amount) FILTER (WHERE type = 'WAYPOINT_DEBIT'), 0)::bigint   AS spent,
         COALESCE(SUM(amount) FILTER (WHERE type = 'MISSION_REFUND'), 0)::bigint    AS refunded,
         COALESCE(SUM(amount) FILTER (WHERE type = 'ADMIN_ADJUSTMENT'), 0)::bigint  AS adjusted
       FROM gta_wallet_transactions WHERE channel_id = $1`,
      [channelId],
    ),
    query<{ circulating: number; wallets: number }>(
      `SELECT COALESCE(SUM(balance), 0)::bigint AS circulating, count(*)::int AS wallets
         FROM gta_wallets WHERE channel_id = $1`,
      [channelId],
    ),
  ]);
  const l = ledger.rows[0];
  const w = wallets.rows[0];
  return {
    issued: l?.issued ?? 0,
    spent: l?.spent ?? 0,
    refunded: l?.refunded ?? 0,
    adjusted: l?.adjusted ?? 0,
    circulating: w?.circulating ?? 0,
    wallets: w?.wallets ?? 0,
  };
}

export interface LedgerMismatch {
  twitchUserId: string;
  balance: number;
  ledgerSum: number;
}

/**
 * The invariant, checked from scratch: every wallet's balance equals the sum
 * of its ledger. Any row returned here means something wrote a balance
 * without the ledger, which should be impossible.
 */
export async function checkLedgerConsistency(
  channelId: string,
): Promise<{ consistent: boolean; mismatches: LedgerMismatch[] }> {
  const { rows } = await query<{ twitch_user_id: string; balance: number; ledger_sum: number }>(
    `SELECT w.twitch_user_id, w.balance, COALESCE(t.total, 0)::bigint AS ledger_sum
       FROM gta_wallets w
       LEFT JOIN (
         SELECT twitch_user_id, SUM(amount) AS total
           FROM gta_wallet_transactions
          WHERE channel_id = $1
          GROUP BY twitch_user_id
       ) t ON t.twitch_user_id = w.twitch_user_id
      WHERE w.channel_id = $1
        AND w.balance <> COALESCE(t.total, 0)
      LIMIT 50`,
    [channelId],
  );
  return {
    consistent: rows.length === 0,
    mismatches: rows.map((r) => ({
      twitchUserId: r.twitch_user_id,
      balance: r.balance,
      ledgerSum: r.ledger_sum,
    })),
  };
}

// ---------------------------------------------------------------------------
// Exchange fulfilment bookkeeping
// ---------------------------------------------------------------------------

export async function fulfillmentCounts(
  channelId: string,
): Promise<{ pending: number; failed: number; canceledExternally: number }> {
  const { rows } = await query<{ pending: number; failed: number; canceled: number }>(
    `SELECT
       count(*) FILTER (WHERE fulfillment_status = 'PENDING')::int             AS pending,
       count(*) FILTER (WHERE fulfillment_status = 'FAILED')::int              AS failed,
       count(*) FILTER (WHERE fulfillment_status = 'CANCELED_EXTERNALLY')::int AS canceled
     FROM gta_wallet_transactions
     WHERE channel_id = $1 AND type = 'EXCHANGE_CREDIT'`,
    [channelId],
  );
  const row = rows[0];
  return {
    pending: row?.pending ?? 0,
    failed: row?.failed ?? 0,
    canceledExternally: row?.canceled ?? 0,
  };
}

/**
 * Committed credits whose redemption Twitch has not yet been told to keep.
 * `minAgeSeconds` leaves alone a credit whose first attempt may still be in
 * flight right after its commit.
 */
export async function listPendingFulfillments(
  channelId: string,
  minAgeSeconds: number,
  limit = 20,
): Promise<WalletTransaction[]> {
  const { rows } = await query<TransactionRow>(
    `SELECT * FROM gta_wallet_transactions
      WHERE fulfillment_status = 'PENDING'
        AND type = 'EXCHANGE_CREDIT'
        AND channel_id = $1
        AND fulfillment_attempts < $2
        AND created_at < now() - ($3 || ' seconds')::interval
      ORDER BY created_at
      LIMIT $4`,
    [channelId, MAX_FULFILLMENT_ATTEMPTS, String(Math.max(0, Math.trunc(minAgeSeconds))), limit],
  );
  return rows.map(rowToTransaction);
}

/** A final answer from Twitch. Only a PENDING or FAILED row can take it. */
export async function recordFulfillment(
  transactionId: string,
  status: 'FULFILLED' | 'CANCELED_EXTERNALLY',
): Promise<void> {
  await query(
    `UPDATE gta_wallet_transactions
        SET fulfillment_status = $2,
            fulfillment_attempts = fulfillment_attempts + 1
      WHERE id = $1 AND fulfillment_status IN ('PENDING', 'FAILED')`,
    [transactionId, status],
  );
}

/**
 * One more failed attempt; FAILED once the budget is spent. Returns the new
 * state, or null when the row had meanwhile stopped being PENDING.
 */
export async function recordFulfillmentFailure(
  transactionId: string,
  error: string,
): Promise<{ status: FulfillmentStatus; attempts: number } | null> {
  const { rows } = await query<{ fulfillment_status: FulfillmentStatus; fulfillment_attempts: number }>(
    `UPDATE gta_wallet_transactions
        SET fulfillment_attempts = fulfillment_attempts + 1,
            fulfillment_status = CASE
              WHEN fulfillment_attempts + 1 >= $3 THEN 'FAILED' ELSE 'PENDING' END,
            metadata = metadata || jsonb_build_object('lastFulfillmentError', $2::text)
      WHERE id = $1 AND fulfillment_status = 'PENDING'
      RETURNING fulfillment_status, fulfillment_attempts`,
    [transactionId, error.slice(0, 300), MAX_FULFILLMENT_ATTEMPTS],
  );
  const row = rows[0];
  return row ? { status: row.fulfillment_status, attempts: row.fulfillment_attempts } : null;
}
