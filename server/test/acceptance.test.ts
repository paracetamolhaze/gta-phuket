import { describe, expect, it } from 'vitest';
import { buildAcceptanceReport, type AcceptanceInput } from '../src/diag/acceptance.js';

const EXCHANGE = 'reward-exchange';
const T0 = 1_800_000_000_000;

function input(overrides: Partial<AcceptanceInput> = {}): AcceptanceInput {
  return {
    now: T0 + 60_000,
    exchangeRewardId: EXCHANGE,
    exchangeRewardCost: 500,
    redemptions: [
      {
        messageId: 'm1',
        receivedAt: T0 + 1000,
        processedAt: T0 + 1500,
        attempts: 1,
        lastError: null,
        redemptionId: 'red-1',
        rewardId: EXCHANGE,
        rewardTitle: 'Обмен ETH на GTA DOLLAR',
        cost: 500,
        userId: '123',
        userLogin: 'viewer_a',
        status: 'unfulfilled',
      },
      {
        messageId: 'm2',
        receivedAt: T0 + 2000,
        processedAt: T0 + 2100,
        attempts: 1,
        lastError: null,
        redemptionId: 'red-x',
        rewardId: 'someone-elses-reward',
        rewardTitle: 'Hydrate',
        cost: 100,
        userId: '456',
        userLogin: 'viewer_b',
        status: 'unfulfilled',
      },
    ],
    ledger: [
      {
        id: 'tx-credit',
        userId: '123',
        type: 'EXCHANGE_CREDIT',
        amount: 5000,
        balanceAfter: 5000,
        redemptionId: 'red-1',
        rewardId: EXCHANGE,
        channelPointsCost: 500,
        quoteId: null,
        waypointId: null,
        fulfillment: 'FULFILLED',
        createdAt: T0 + 1400,
      },
      {
        id: 'tx-debit',
        userId: '123',
        type: 'WAYPOINT_DEBIT',
        amount: -1500,
        balanceAfter: 3500,
        redemptionId: null,
        rewardId: null,
        channelPointsCost: null,
        quoteId: 'q-1',
        waypointId: 'w-1',
        fulfillment: null,
        createdAt: T0 + 30_000,
      },
    ],
    quotes: [
      {
        id: 'q-1',
        userId: '123',
        userName: 'viewer_a',
        destination: 'Patong Beach',
        cost: 1500,
        currency: 'GTA_DOLLAR',
        status: 'PAID',
        distanceMeters: 1400,
        createdAt: T0 + 20_000,
      },
    ],
    waypoints: [
      {
        id: 'w-1',
        quoteId: 'q-1',
        userId: '123',
        destination: 'Patong Beach',
        cost: 1500,
        currency: 'GTA_DOLLAR',
        status: 'ACTIVE',
        activatedAt: T0 + 30_000,
      },
    ],
    notes: [
      { kind: 'identity_linked', channelId: 'c', userId: '123', via: 'socket', ts: T0 },
      {
        kind: 'wallet_updated_emitted',
        channelId: 'c',
        userId: '123',
        type: 'EXCHANGE_CREDIT',
        amount: 5000,
        balance: 5000,
        transactionId: 'tx-credit',
        viewerSockets: 1,
        ts: T0 + 1450,
      },
      { kind: 'identity_linked', channelId: 'c', userId: '456', via: 'wallet_read', ts: T0 + 5000 },
    ],
    balances: { '123': 3500 },
    ...overrides,
  };
}

describe('GTA$ acceptance monitor', () => {
  it('ticks all 13 steps for a complete viewer flow, with the real values', () => {
    const report = buildAcceptanceReport(input());
    const a = report.viewers.find((v) => v.userId === '123')!;
    expect(a.userLogin).toBe('viewer_a');
    expect(a.balance).toBe(3500);
    expect(a.checklist).toHaveLength(13);
    expect(a.checklist.every((item) => item.ok)).toBe(true);

    const value = (key: string): string | null => a.checklist.find((i) => i.key === key)!.value;
    expect(value('redemptionId')).toBe('red-1');
    expect(value('rewardId')).toBe(EXCHANGE);
    expect(value('ethCost')).toBe('500 ETH');
    expect(value('credited')).toBe('+GTA$ 5 000 · Twitch: FULFILLED');
    expect(value('walletBefore')).toBe('GTA$ 0');
    expect(value('walletAfter')).toBe('GTA$ 5 000');
    expect(value('walletUpdated')).toContain('1');
    expect(value('waypointCost')).toBe('GTA$ 1 500');
    expect(value('debited')).toContain('GTA$ 5 000 → GTA$ 3 500');
    expect(value('waypointActive')).toContain('ACTIVE');
  });

  it('keeps another viewer separate and ignores rewards that are not the exchange', () => {
    const report = buildAcceptanceReport(input());
    const b = report.viewers.find((v) => v.userId === '456')!;
    expect(b.balance).toBeNull();
    const ok = Object.fromEntries(b.checklist.map((i) => [i.key, i.ok]));
    expect(ok.identity).toBe(true);
    expect(ok.redemption).toBe(false);
    expect(ok.credited).toBe(false);
    expect(ok.debited).toBe(false);
    expect(report.timeline.find((t) => t.userId === '456' && t.step === 'other redemption')).toBeTruthy();
  });

  it('shows a waiting checklist before anything happened', () => {
    const report = buildAcceptanceReport(
      input({ redemptions: [], ledger: [], quotes: [], waypoints: [], balances: {}, notes: [
        { kind: 'identity_linked', channelId: 'c', userId: '789', via: 'socket', ts: T0 },
      ] }),
    );
    const v = report.viewers[0]!;
    expect(v.userId).toBe('789');
    expect(v.checklist.filter((i) => i.ok).map((i) => i.key)).toEqual(['identity']);
  });

  it('never carries anything token-shaped', () => {
    const text = JSON.stringify(buildAcceptanceReport(input()));
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/);
    expect(text.toLowerCase()).not.toContain('token');
  });
});
