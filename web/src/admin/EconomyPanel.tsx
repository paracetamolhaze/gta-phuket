import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { ApiClient } from '../shared/api';
import { ApiFailure } from '../shared/api';
import { formatGta, formatInteger } from '../shared/format';
import type { ChannelSettings } from '../shared/types';

import type { ToastKind } from './App';

const POLL_MS = 5000;
/**
 * After a save, the saved values stand in for the server copy until the polled
 * settings catch up (normally one 2 s admin poll), so the form does not flash
 * "changed" in between. Capped, so a server that never echoes them cannot pin
 * a stale value on screen.
 */
const SAVED_HOLD_MS = 8000;

/** Keeps "1 ETH" / "500 ETH" / "10 GTA$" from wrapping between number and unit. */
const NBSP = String.fromCharCode(0xa0);

/** Local copy so this module never imports a value from App (no import cycle). */
function errorText(err: unknown): string {
  if (err instanceof ApiFailure) return err.code === 'internal' ? err.message : `${err.message} · ${err.code}`;
  if (err instanceof Error) return err.message;
  return 'Неизвестная ошибка';
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError' : false;
}

// ---------------------------------------------------------------------------
// GET /api/admin/economy — docs/GTA_DOLLAR_ECONOMY.md §6.
// Parsed field by field, like the diagnostics panel: the endpoint is new, and
// one unexpected shape must not blank the console the owner runs the stream from.
// ---------------------------------------------------------------------------

interface ExchangeRewardView {
  id: string | null;
  title: string | null;
  cost: number | null;
  /** null when the server could not ask Twitch. */
  enabledOnTwitch: boolean | null;
}

interface EconomyTotals {
  issued: number | null;
  spent: number | null;
  refunded: number | null;
  adjusted: number | null;
  circulating: number | null;
  wallets: number | null;
}

interface LedgerRow {
  key: string;
  createdAt: number | null;
  /** A LedgerType; kept open so a type from a newer server still shows up. */
  type: string;
  amount: number | null;
  twitchUserId: string | null;
  balanceAfter: number | null;
}

interface EconomyView {
  paymentMode: string | null;
  exchangeRate: number | null;
  reward: ExchangeRewardView | null;
  /** Why Twitch could not be asked whether the reward is enabled; null when it answered. */
  rewardCheckError: string | null;
  gtaPerRedemption: number | null;
  /** Not in the contract; read from `settings` when the server sends it alongside. */
  exchangeRewardCost: number | null;
  totals: EconomyTotals;
  ledgerConsistent: boolean | null;
  pendingFulfillments: number;
  failedFulfillments: number;
  canceledExternally: number;
  recent: LedgerRow[];
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // BIGINT sums arrive as strings from any query that bypasses the pool's int8 parser.
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function objects(v: unknown): Json[] {
  return Array.isArray(v) ? v.map(obj).filter((row): row is Json => row !== null) : [];
}

/** Timestamps may be ISO strings (TIMESTAMPTZ) or epoch ms, depending on the query. */
function toMs(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function parseReward(r: Json): ExchangeRewardView {
  return {
    id: str(r.id),
    title: str(r.title),
    cost: num(r.cost),
    enabledOnTwitch: bool(r.enabledOnTwitch),
  };
}

function parseLedgerRow(r: Json, index: number): LedgerRow {
  const createdAt = toMs(r.createdAt);
  return {
    key: str(r.id) ?? `${createdAt ?? 'x'}-${index}`,
    createdAt,
    type: str(r.type) ?? '?',
    amount: num(r.amount),
    twitchUserId: str(r.twitchUserId),
    balanceAfter: num(r.balanceAfter),
  };
}

function parseEconomy(raw: unknown): EconomyView {
  const root = obj(raw) ?? {};
  const totals = obj(root.totals) ?? {};
  const settings = obj(root.settings) ?? {};
  const rewardCheckError = str(root.rewardCheckError);
  const rewardRaw = obj(root.reward);
  const reward = rewardRaw ? parseReward(rewardRaw) : null;
  // A failed check arrives as enabledOnTwitch: null plus the reason. It is not
  // known to be off, and telling the owner "выключена" would send them to fix a
  // non-issue; the error alone is enough to say so, whatever the flag says.
  if (reward && rewardCheckError) reward.enabledOnTwitch = null;
  return {
    paymentMode: str(root.paymentMode),
    exchangeRate: num(root.exchangeRate) ?? num(settings.gtaDollarsPerChannelPoint),
    reward,
    rewardCheckError,
    gtaPerRedemption: num(root.gtaPerRedemption),
    exchangeRewardCost: num(settings.exchangeRewardCost) ?? num(root.exchangeRewardCost),
    totals: {
      issued: num(totals.issued),
      spent: num(totals.spent),
      refunded: num(totals.refunded),
      adjusted: num(totals.adjusted),
      circulating: num(totals.circulating),
      wallets: num(totals.wallets),
    },
    ledgerConsistent: bool(root.ledgerConsistent),
    pendingFulfillments: num(root.pendingFulfillments) ?? 0,
    failedFulfillments: num(root.failedFulfillments) ?? 0,
    canceledExternally: num(root.canceledExternally) ?? 0,
    recent: objects(root.recent).map(parseLedgerRow),
  };
}

/** A 422 names the offending fields; a Twitch refusal carries Twitch's own text. */
function describeError(err: unknown): string {
  // provider_error is Helix saying no (TwitchApiError): name who refused.
  if (err instanceof ApiFailure && err.code === 'provider_error') return `Twitch отказал: ${err.message}`;
  let message = errorText(err);
  if (!(err instanceof ApiFailure)) return message;
  if (Array.isArray(err.details)) {
    const fields = err.details
      .map(obj)
      .filter((d): d is Json => d !== null)
      .map((d) => {
        const path = str(d.path);
        const text = str(d.message) ?? '';
        return path ? `${path}: ${text}`.trim() : text;
      })
      .filter(Boolean);
    if (fields.length) message = `${message} — ${fields.join('; ')}`;
  } else {
    const details = obj(err.details);
    const extra = details ? (str(details.twitch) ?? str(details.message) ?? str(details.error)) : null;
    if (extra && !message.includes(extra)) message = `${message} — ${extra}`;
  }
  return message;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

type Tone = 'ok' | 'warn' | 'bad';

const TYPE_LABEL: Record<string, string> = {
  EXCHANGE_CREDIT: 'обмен ETH',
  WAYPOINT_DEBIT: 'покупка точки',
  MISSION_REFUND: 'возврат',
  ADMIN_ADJUSTMENT: 'корректировка',
};

/** What ensureExchangeReward did (EnsureExchangeRewardResult.action). */
const SYNC_ACTION_LABEL: Record<string, string> = {
  created: 'создана',
  adopted: 'найдена и привязана',
  updated: 'обновлена',
  unchanged: 'без изменений',
};

/** A ledger amount in a column already headed "GTA$": `+5 000`, `−1 500`. */
function formatSigned(n: number | null): string {
  if (n == null) return '—';
  return `${n > 0 ? '+' : ''}${formatInteger(n)}`;
}

function modeLabel(mode: string | null): { text: string; pill: string } {
  if (mode === 'gta_dollar') return { text: 'ОПЛАТА В GTA$', pill: 'is-ok' };
  if (mode === 'channel_points_reward') return { text: 'ОПЛАТА НАГРАДАМИ · LEGACY', pill: 'is-accent' };
  return { text: mode ?? 'РЕЖИМ —', pill: 'is-dim' };
}

function clock(ms: number | null): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function clockShort(ms: number | null): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function toneClass(tone: Tone | null | undefined): string {
  return tone ? ` is-${tone}` : '';
}

// ---------------------------------------------------------------------------
// Settings form: gtaDollarsPerChannelPoint and exchangeRewardCost (§1).
// ---------------------------------------------------------------------------

type FieldKey = 'gtaDollarsPerChannelPoint' | 'exchangeRewardCost';

interface FieldSpec {
  key: FieldKey;
  label: string;
  min: number;
  max: number;
  hint: string;
}

// Bounds mirror settingsPatchSchema (docs/GTA_DOLLAR_ECONOMY.md §1).
const FIELDS: FieldSpec[] = [
  { key: 'gtaDollarsPerChannelPoint', label: 'GTA$ за 1 ETH', min: 1, max: 1000, hint: 'курс' },
  { key: 'exchangeRewardCost', label: 'Цена награды, ETH', min: 1, max: 1_000_000, hint: 'меняется и на Twitch' },
];

type Values = Record<FieldKey, number | null>;
type Draft = Record<FieldKey, string>;

const EMPTY_DRAFT: Draft = { gtaDollarsPerChannelPoint: '', exchangeRewardCost: '' };

interface FieldState {
  value: number | null;
  error: string | null;
  dirty: boolean;
}

function textOf(value: number | null): string {
  return value == null ? '' : String(value);
}

function validate(field: FieldSpec, raw: string, server: number | null): { value: number | null; error: string | null } {
  // "1 000" pasted from the panel itself must still parse; s covers U+00A0.
  const text = raw.replace(/[\s ]/g, '');
  // Nothing known and nothing typed is "not set yet", not an error.
  if (!text) return { value: null, error: server == null ? null : 'пусто' };
  if (!/^-?\d+$/.test(text)) return { value: null, error: /^-?\d+[.,]\d+$/.test(text) ? 'только целое' : 'не число' };
  const value = Number(text);
  if (value < field.min) return { value: null, error: `не меньше ${formatInteger(field.min)}` };
  if (value > field.max) return { value: null, error: `не больше ${formatInteger(field.max)}` };
  return { value, error: null };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Cell({
  label,
  tone,
  big,
  mono,
  wide,
  title,
  children,
}: {
  label: string;
  tone?: Tone | null;
  big?: boolean;
  mono?: boolean;
  wide?: boolean;
  title?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={`ad-cell${wide ? ' is-wide' : ''}`} title={title}>
      <div className="label">{label}</div>
      <div className={`ad-cell-v num${mono ? ' mono' : ''}${big ? ' is-big' : ''}${toneClass(tone)}`}>{children}</div>
    </div>
  );
}

function LedgerTable({ rows }: { rows: LedgerRow[] }): JSX.Element {
  if (rows.length === 0) {
    return <div className="ad-empty">Операций пока нет: ещё никто не обменял ETH на GTA$.</div>;
  }
  return (
    <div className="ad-table-wrap scroll-thin">
      <table className="ad-table ad-econ-table">
        <thead>
          <tr>
            <th>время</th>
            <th>операция</th>
            <th>зритель</th>
            <th className="is-right">сумма, GTA$</th>
            <th className="is-right">баланс после</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const tone: Tone | null = row.amount == null ? null : row.amount > 0 ? 'ok' : null;
            return (
              <tr key={row.key}>
                <td className="num">{clock(row.createdAt)}</td>
                <td title={row.type}>{TYPE_LABEL[row.type] ?? row.type}</td>
                <td className="mono">{row.twitchUserId ?? '—'}</td>
                <td className={`is-right num${toneClass(tone)}`}>{formatSigned(row.amount)}</td>
                <td className="is-right num">{formatInteger(row.balanceAfter)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface EconomyPanelProps {
  api: ApiClient;
  /** Settings from the admin state poll; the two economy keys are read defensively. */
  settings: ChannelSettings | null;
  onToast: (kind: ToastKind, text: string) => void;
  onAuthError: (err: unknown) => boolean;
  /** Saved settings also live in /api/admin/state; ask the console to re-read it. */
  onChanged: () => void;
}

/**
 * The GTA$ side of the channel: what one exchange redemption is worth, whether
 * the one real Twitch reward exists, where every GTA$ went, and whether Twitch
 * has been told about each exchange.
 */
export function EconomyPanel({ api, settings, onToast, onAuthError, onChanged }: EconomyPanelProps): JSX.Element {
  const [data, setData] = useState<EconomyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);

  const [busy, setBusy] = useState<'save' | 'sync' | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Partial<Values> | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  /** The server text the draft was last reset to; "edited" is measured against it. */
  const [adopted, setAdopted] = useState<Draft>(EMPTY_DRAFT);

  const refreshRef = useRef<((queue: boolean) => void) | null>(null);

  // --- poll ----------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let again = false;
    const controller = new AbortController();

    // `queue`: an explicit refresh after an action must not be swallowed by a
    // poll that left before the action landed; it runs once more afterwards.
    const tick = (queue: boolean): void => {
      if (!alive) return;
      if (inFlight) {
        if (queue) again = true;
        return;
      }
      inFlight = true;
      void (async () => {
        try {
          const raw = await api.get<unknown>('/api/admin/economy', controller.signal);
          if (!alive) return;
          setData(parseEconomy(raw));
          setError(null);
          setSyncedAt(Date.now());
        } catch (err) {
          if (!alive || isAbort(err)) return;
          if (onAuthError(err)) return;
          // The last good snapshot stays on screen; only this line says it is old.
          setError(errorText(err));
        } finally {
          inFlight = false;
          if (again && alive) {
            again = false;
            tick(false);
          }
        }
      })();
    };

    refreshRef.current = tick;
    tick(false);
    const id = window.setInterval(() => tick(false), POLL_MS);
    return () => {
      alive = false;
      refreshRef.current = null;
      window.clearInterval(id);
      controller.abort();
    };
  }, [api, onAuthError]);

  // --- server copy of the two settings ----------------------------------------
  // The saved settings are the truth for the inputs; the economy view is only a
  // fallback for a server whose /api/admin/state does not carry the keys yet.
  const s = obj(settings);
  const settingCost = num(s?.exchangeRewardCost) ?? data?.exchangeRewardCost ?? null;
  const polledRate = num(s?.gtaDollarsPerChannelPoint) ?? data?.exchangeRate ?? null;
  const polledCost = settingCost ?? data?.reward?.cost ?? null;
  const serverRate = saved?.gtaDollarsPerChannelPoint ?? polledRate;
  const serverCost = saved?.exchangeRewardCost ?? polledCost;

  const caughtUp =
    saved != null &&
    (saved.gtaDollarsPerChannelPoint == null || saved.gtaDollarsPerChannelPoint === polledRate) &&
    (saved.exchangeRewardCost == null || saved.exchangeRewardCost === polledCost);

  useEffect(() => {
    if (caughtUp) setSaved(null);
  }, [caughtUp]);

  useEffect(() => {
    if (!saved) return;
    const id = window.setTimeout(() => setSaved(null), SAVED_HOLD_MS);
    return () => window.clearTimeout(id);
  }, [saved]);

  const adopt = useCallback((rate: number | null, cost: number | null) => {
    const next: Draft = { gtaDollarsPerChannelPoint: textOf(rate), exchangeRewardCost: textOf(cost) };
    setAdopted(next);
    setDraft(next);
  }, []);

  const server: Values = { gtaDollarsPerChannelPoint: serverRate, exchangeRewardCost: serverCost };

  const fieldStates = {} as Record<FieldKey, FieldState>;
  for (const field of FIELDS) {
    const { value, error: fieldError } = validate(field, draft[field.key], server[field.key]);
    fieldStates[field.key] = {
      value,
      error: fieldError,
      dirty: fieldError === null && value !== null && value !== server[field.key],
    };
  }
  const dirtyKeys = FIELDS.filter((field) => fieldStates[field.key].dirty).map((field) => field.key);
  const hasErrors = FIELDS.some((field) => fieldStates[field.key].error !== null);
  // "Edited" is about the text, not the value: half-typed input is kept too.
  const edited = FIELDS.some((field) => draft[field.key] !== adopted[field.key]);
  const adoptedRate = adopted.gtaDollarsPerChannelPoint;
  const adoptedCost = adopted.exchangeRewardCost;

  // Follow the server copy only while the owner is not in the middle of an edit.
  useEffect(() => {
    if (edited) return;
    if (adoptedRate === textOf(serverRate) && adoptedCost === textOf(serverCost)) return;
    adopt(serverRate, serverCost);
  }, [edited, adoptedRate, adoptedCost, serverRate, serverCost, adopt]);

  // --- actions ---------------------------------------------------------------

  const save = (): void => {
    if (busy || dirtyKeys.length === 0 || hasErrors) return;
    const patch: Partial<Values> = {};
    for (const key of dirtyKeys) patch[key] = fieldStates[key].value;

    setBusy('save');
    setSaveError(null);
    void (async () => {
      try {
        await api.put<unknown>('/api/admin/economy', patch);
        const nextRate = patch.gtaDollarsPerChannelPoint ?? serverRate;
        const nextCost = patch.exchangeRewardCost ?? serverCost;
        setSaved(patch);
        adopt(nextRate, nextCost);
        const parts: string[] = [];
        if (patch.gtaDollarsPerChannelPoint != null) parts.push(`1 ETH = ${formatInteger(nextRate)} GTA$`);
        if (patch.exchangeRewardCost != null) parts.push(`награда ${formatInteger(nextCost)} ETH`);
        onToast('ok', `Экономика сохранена: ${parts.join(' · ')}`);
        onChanged();
      } catch (err) {
        if (onAuthError(err)) return;
        // A refused cost change is rolled back by the server; say why, keep the edit.
        const message = describeError(err);
        setSaveError(message);
        onToast('err', `Не сохранено: ${message}`);
      } finally {
        setBusy(null);
        refreshRef.current?.(true);
      }
    })();
  };

  const sync = (): void => {
    if (busy) return;
    setBusy('sync');
    setSyncError(null);
    void (async () => {
      try {
        const raw = await api.post<unknown>('/api/admin/economy/exchange-reward/sync');
        // The result shape is not part of the contract; show whatever is recognisable.
        const root = obj(raw);
        const reward = obj(root?.reward) ?? root;
        const title = str(reward?.title);
        const cost = num(reward?.cost);
        const action = str(root?.action) ?? str(root?.result);
        const actionText = action ? (SYNC_ACTION_LABEL[action] ?? action) : null;
        onToast(
          'ok',
          `Награда обмена синхронизирована${title ? `: «${title}»` : ''}${
            cost != null ? ` · ${formatInteger(cost)}${NBSP}ETH` : ''
          }${actionText ? ` · ${actionText}` : ''}`,
        );
      } catch (err) {
        if (onAuthError(err)) return;
        const message = describeError(err);
        setSyncError(message);
        onToast('err', `Синхронизация награды: ${message}`);
      } finally {
        setBusy(null);
        refreshRef.current?.(true);
      }
    })();
  };

  const setField = (key: FieldKey, value: string): void => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  // --- render ------------------------------------------------------------------

  const note = syncedAt == null ? (error ? 'нет данных' : 'загрузка…') : `обновлено ${clockShort(syncedAt)}`;
  const mode = modeLabel(data?.paymentMode ?? null);
  const reward = data?.reward ?? null;
  const rate = data?.exchangeRate ?? serverRate;

  // Preview only: the server computes every credit from what Twitch charged.
  const previewRate = fieldStates.gtaDollarsPerChannelPoint.value ?? serverRate;
  const previewCost = fieldStates.exchangeRewardCost.value ?? serverCost;
  const previewGta = previewRate != null && previewCost != null ? previewRate * previewCost : null;

  // Only against a known setting: without one, polledCost is the reward's own cost.
  const costMismatch = reward?.cost != null && settingCost != null && reward.cost !== settingCost;

  return (
    <section className="panel ad-panel ad-econ">
      <div className="ad-panel-head">
        <div className="ad-panel-title">GTA DOLLAR ECONOMY</div>
        <div className="ad-panel-note num">{note}</div>
      </div>

      {error ? <div className="ad-econ-err">Экономика не обновилась: {error}</div> : null}

      <div className="ad-econ-hero">
        <div className="ad-econ-rate num">
          1{NBSP}ETH = {rate == null ? '—' : `${formatInteger(rate)}${NBSP}GTA$`}
        </div>
        {data ? <span className={`ad-pill ${mode.pill}`}>{mode.text}</span> : null}
      </div>

      {data ? (
        <>
          {data.ledgerConsistent === false ? (
            <div className="ad-warn">
              Журнал не сходится с балансами кошельков: у части кошельков сумма операций не равна балансу.
            </div>
          ) : null}
          {data.canceledExternally > 0 ? (
            <div className="ad-warn">
              Отменено на Twitch после зачисления: {formatInteger(data.canceledExternally)}. GTA$ за эти обмены
              уже на кошельках и автоматически не списываются.
            </div>
          ) : null}
          {data.failedFulfillments > 0 ? (
            <div className="ad-warn">
              Сбой FULFILLED: {formatInteger(data.failedFulfillments)}. Twitch не принял статус за 10 попыток — GTA$
              зачислены, а обмен висит в очереди наград Twitch; закройте его там вручную.
            </div>
          ) : null}

          <div className="ad-group">
            <div className="label ad-group-title">Награда обмена на Twitch</div>
            <div className="ad-grid">
              <Cell label="Название" wide tone={reward ? null : 'bad'}>
                {reward ? `«${reward.title ?? '—'}»` : 'награда не создана'}
              </Cell>
              <Cell label="Цена">
                {reward?.cost == null ? '—' : `${formatInteger(reward.cost)}${NBSP}ETH`}
              </Cell>
              <Cell label="За обмен">{formatGta(data.gtaPerRedemption)}</Cell>
              <Cell
                label="На Twitch"
                tone={!reward ? 'bad' : reward.enabledOnTwitch == null ? 'warn' : reward.enabledOnTwitch ? 'ok' : 'bad'}
              >
                {!reward
                  ? 'нет награды'
                  : reward.enabledOnTwitch == null
                    ? 'неизвестно'
                    : reward.enabledOnTwitch
                      ? 'включена'
                      : 'выключена'}
              </Cell>
              {reward ? (
                <Cell label="ID награды" mono wide title={reward.id ?? undefined}>
                  <span className="ad-cut is-l">{reward.id ?? '—'}</span>
                </Cell>
              ) : null}
            </div>
            {!reward ? (
              <div className="ad-warn">
                Зрители не могут купить GTA$, пока награды «Обмен ETH на GTA DOLLAR» нет на Twitch. Нажмите
                «СИНХР. НАГРАДУ ОБМЕНА» (Twitch стримера должен быть подключён).
              </div>
            ) : null}
            {reward && data.rewardCheckError ? (
              <div className="ad-warn is-soft">
                Twitch не ответил, включена ли награда: {data.rewardCheckError}
              </div>
            ) : null}
            {reward && reward.enabledOnTwitch === false ? (
              <div className="ad-warn is-soft">
                Награда выключена на Twitch: зрители её не видят. «СИНХР. НАГРАДУ ОБМЕНА» включит её снова.
              </div>
            ) : null}
            {costMismatch && reward?.cost != null ? (
              <div className="ad-warn is-soft">
                Цена на Twitch ({formatInteger(reward.cost)} ETH) не совпадает с настройкой ({formatInteger(polledCost)}{' '}
                ETH). «СИНХР. НАГРАДУ ОБМЕНА» выровняет её.
              </div>
            ) : null}
            {syncError ? <div className="ad-err ad-err-block">{syncError}</div> : null}
            <div className="ad-econ-row">
              <button className="btn" type="button" onClick={sync} disabled={busy !== null}>
                {busy === 'sync' ? 'СИНХРОНИЗИРУЮ…' : 'СИНХР. НАГРАДУ ОБМЕНА'}
              </button>
            </div>
          </div>

          <div className="ad-group">
            <div className="label ad-group-title">Оборот GTA$</div>
            <div className="ad-grid">
              <Cell label="В обращении" big>
                {formatGta(data.totals.circulating)}
              </Cell>
              <Cell label="Кошельков" big>
                {formatInteger(data.totals.wallets)}
              </Cell>
              <Cell
                label="Журнал"
                tone={data.ledgerConsistent == null ? 'warn' : data.ledgerConsistent ? 'ok' : 'bad'}
              >
                {data.ledgerConsistent == null ? 'нет данных' : data.ledgerConsistent ? 'сходится' : 'РАСХОЖДЕНИЕ'}
              </Cell>
              <Cell label="Выпущено" title="Σ EXCHANGE_CREDIT">
                {formatGta(data.totals.issued)}
              </Cell>
              <Cell label="Потрачено" title="−Σ WAYPOINT_DEBIT">
                {formatGta(data.totals.spent)}
              </Cell>
              <Cell label="Возвращено" title="Σ MISSION_REFUND">
                {formatGta(data.totals.refunded)}
              </Cell>
              <Cell label="Корректировки" title="Σ ADMIN_ADJUSTMENT">
                {formatGta(data.totals.adjusted)}
              </Cell>
            </div>
          </div>

          <div className="ad-group">
            <div className="label ad-group-title">Подтверждение обменов на Twitch</div>
            <div className="ad-grid">
              <Cell label="Ждут FULFILLED" tone={data.pendingFulfillments > 0 ? 'warn' : null}>
                {formatInteger(data.pendingFulfillments)}
              </Cell>
              <Cell label="Сбой FULFILLED" tone={data.failedFulfillments > 0 ? 'bad' : null}>
                {formatInteger(data.failedFulfillments)}
              </Cell>
              <Cell label="Отменены на Twitch" tone={data.canceledExternally > 0 ? 'bad' : null}>
                {formatInteger(data.canceledExternally)}
              </Cell>
            </div>
            <div className="ad-hint">
              GTA$ зачисляются сразу; FULFILLED на Twitch повторяется каждые 60 с, после 10 неудач — сбой.
            </div>
          </div>
        </>
      ) : error ? null : (
        <div className="ad-empty">Загружаю экономику…</div>
      )}

      <div className="ad-group">
        <div className="label ad-group-title">Курс и цена обмена</div>
        <div className="ad-fields">
          {FIELDS.map((field) => {
            const state = fieldStates[field.key];
            return (
              <label className="ad-field" key={field.key}>
                <span className="label">
                  {field.label}
                  <span className="ad-sub"> · {field.hint}</span>
                </span>
                <input
                  className={`ad-input num${state.error ? ' is-err' : ''}${state.dirty ? ' is-dirty' : ''}`}
                  type="text"
                  inputMode="numeric"
                  value={draft[field.key]}
                  placeholder={server[field.key] == null ? 'нет данных' : undefined}
                  onChange={(e) => setField(field.key, e.target.value)}
                  disabled={busy === 'save'}
                />
                {state.error ? <span className="ad-err">{state.error}</span> : null}
              </label>
            );
          })}
        </div>
        <div className="ad-hint num">
          {previewGta == null
            ? 'Курс и цена ещё не загружены.'
            : `Один обмен: ${formatInteger(previewCost)}${NBSP}ETH → ${formatGta(previewGta)}. `}
          Курс применяется к обменам, обработанным после сохранения. Новая цена сначала уходит на Twitch;
          если Twitch откажет, настройка не сохранится.
        </div>
        {saveError ? <div className="ad-err ad-err-block">Не сохранено: {saveError}</div> : null}
        <div className="ad-save-row">
          <button
            className="btn btn-primary"
            type="button"
            onClick={save}
            disabled={busy !== null || dirtyKeys.length === 0 || hasErrors}
          >
            {busy === 'save' ? 'СОХРАНЯЮ…' : `СОХРАНИТЬ${dirtyKeys.length > 0 ? ` · ${dirtyKeys.length}` : ''}`}
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => {
              setSaveError(null);
              adopt(serverRate, serverCost);
            }}
            disabled={busy !== null || !edited}
          >
            ОТМЕНИТЬ ПРАВКИ
          </button>
        </div>
      </div>

      {data ? (
        <div className="ad-group">
          <div className="label ad-group-title">
            Журнал GTA$ <span className="ad-sub num">· последние {data.recent.length}</span>
          </div>
          <LedgerTable rows={data.recent} />
        </div>
      ) : null}
    </section>
  );
}
