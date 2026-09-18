import { useEffect, useState } from 'react';

import type { ApiClient } from '../shared/api';
import { ApiFailure } from '../shared/api';

/** Fast on purpose: this screen is watched while a real redemption happens. */
const POLL_MS = 2000;
const WINDOW_MINUTES = 180;

function errorText(err: unknown): string {
  if (err instanceof ApiFailure) return err.code === 'internal' ? err.message : `${err.message} · ${err.code}`;
  if (err instanceof Error) return err.message;
  return 'Неизвестная ошибка';
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError' : false;
}

function clock(ms: number | null): string {
  if (ms == null) return '—';
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function gta(n: number | null): string {
  if (n == null) return '—';
  return `GTA$ ${String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`;
}

// ---------------------------------------------------------------------------
// GET /api/admin/acceptance — server/src/diag/acceptance.ts. Parsed defensively:
// one unexpected shape must not blank the console in the middle of a test.
// ---------------------------------------------------------------------------

interface ChecklistItem {
  key: string;
  label: string;
  ok: boolean;
  value: string | null;
  at: number | null;
}

interface ViewerAcceptance {
  userId: string;
  userLogin: string | null;
  balance: number | null;
  lastActivity: number;
  checklist: ChecklistItem[];
}

interface TimelineEntry {
  ts: number;
  userId: string | null;
  userLogin: string | null;
  step: string;
  text: string;
  ok: boolean;
}

interface AcceptanceReport {
  serverTime: number;
  exchangeRewardId: string | null;
  exchangeRewardCost: number | null;
  viewers: ViewerAcceptance[];
  timeline: TimelineEntry[];
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function parseReport(raw: unknown): AcceptanceReport {
  const r = obj(raw);
  return {
    serverTime: num(r.serverTime) ?? Date.now(),
    exchangeRewardId: str(r.exchangeRewardId),
    exchangeRewardCost: num(r.exchangeRewardCost),
    viewers: arr(r.viewers).map((v) => {
      const o = obj(v);
      return {
        userId: str(o.userId) ?? '?',
        userLogin: str(o.userLogin),
        balance: num(o.balance),
        lastActivity: num(o.lastActivity) ?? 0,
        checklist: arr(o.checklist).map((c) => {
          const i = obj(c);
          return {
            key: str(i.key) ?? '',
            label: str(i.label) ?? '',
            ok: i.ok === true,
            value: str(i.value),
            at: num(i.at),
          };
        }),
      };
    }),
    timeline: arr(r.timeline).map((t) => {
      const e = obj(t);
      return {
        ts: num(e.ts) ?? 0,
        userId: str(e.userId),
        userLogin: str(e.userLogin),
        step: str(e.step) ?? '',
        text: str(e.text) ?? '',
        ok: e.ok === true,
      };
    }),
  };
}

interface AcceptancePanelProps {
  api: ApiClient;
  onAuthError: (err: unknown) => boolean;
}

/**
 * GTA$ LIVE ACCEPTANCE: one screen for the real test — identity, exchange
 * redemption, credit with the wallet before and after, the realtime signal,
 * quote, debit and the ACTIVE waypoint, per viewer, refreshed every 2 s.
 * Read-only; no token ever reaches it.
 */
export function AcceptancePanel({ api, onAuthError }: AcceptancePanelProps): JSX.Element {
  const [data, setData] = useState<AcceptanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const controller = new AbortController();

    const tick = (): void => {
      if (!alive || inFlight) return;
      inFlight = true;
      void (async () => {
        try {
          const raw = await api.get<unknown>(`/api/admin/acceptance?minutes=${WINDOW_MINUTES}`, controller.signal);
          if (!alive) return;
          setData(parseReport(raw));
          setError(null);
          setSyncedAt(Date.now());
        } catch (err) {
          if (!alive || isAbort(err)) return;
          if (onAuthError(err)) return;
          setError(errorText(err));
        } finally {
          inFlight = false;
        }
      })();
    };

    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
      controller.abort();
    };
  }, [api, onAuthError]);

  // Follow the most recently active viewer unless the owner picked one.
  const viewer =
    data?.viewers.find((v) => v.userId === picked) ?? data?.viewers[0] ?? null;
  const done = viewer ? viewer.checklist.filter((c) => c.ok).length : 0;
  const total = viewer?.checklist.length ?? 13;

  return (
    <section className="panel ad-panel ad-acc">
      <div className="ad-panel-head">
        <div className="ad-panel-title">GTA$ LIVE ACCEPTANCE</div>
        <div className="ad-panel-note num">
          {syncedAt == null ? (error ? 'нет данных' : 'загрузка…') : `обновлено ${clock(syncedAt)} · каждые 2 с`}
        </div>
      </div>

      {error ? <div className="ad-diag-err">Монитор не обновился: {error}</div> : null}

      {data ? (
        <>
          <div className="ad-facts">
            награда обмена:{' '}
            <span className="mono">{data.exchangeRewardId ?? 'не создана'}</span>
            {data.exchangeRewardCost != null ? ` · ${data.exchangeRewardCost} ETH` : ''} · окно{' '}
            {WINDOW_MINUTES} мин
          </div>

          {data.viewers.length === 0 ? (
            <div className="ad-empty">
              Пока тихо. Откройте карту в Twitch-расширении и нажмите «ПОДКЛЮЧИТЬ» — зритель появится здесь.
            </div>
          ) : (
            <>
              <div className="ad-acc-chips">
                {data.viewers.map((v) => (
                  <button
                    key={v.userId}
                    type="button"
                    className={`ad-acc-chip${viewer?.userId === v.userId ? ' is-on' : ''}`}
                    onClick={() => setPicked(v.userId)}
                  >
                    <b>{v.userLogin ?? `user ${v.userId}`}</b>
                    <span className="num">{v.userId}</span>
                    <span className="num">{gta(v.balance ?? 0)}</span>
                  </button>
                ))}
              </div>

              {viewer ? (
                <div className="ad-diag-block">
                  <div className="label ad-group-title">
                    {viewer.userLogin ?? `user ${viewer.userId}`}{' '}
                    <span className="ad-sub num">
                      · {done}/{total} · баланс сейчас {gta(viewer.balance ?? 0)}
                    </span>
                  </div>
                  <div className="ad-table-wrap scroll-thin">
                    <table className="ad-table ad-acc-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>шаг</th>
                          <th />
                          <th>значение</th>
                          <th>время</th>
                        </tr>
                      </thead>
                      <tbody>
                        {viewer.checklist.map((item, i) => (
                          <tr key={item.key} className={item.ok ? '' : 'is-dim'}>
                            <td className="num">{i + 1}</td>
                            <td>{item.label}</td>
                            <td>
                              <span className={`ad-acc-mark ${item.ok ? 'is-ok' : 'is-wait'}`}>
                                {item.ok ? '✓' : '…'}
                              </span>
                            </td>
                            <td className="mono" title={item.value ?? undefined}>
                              {item.value ?? 'ждём'}
                            </td>
                            <td className="num">{clock(item.at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </>
          )}

          <div className="ad-diag-block">
            <div className="label ad-group-title">
              Таймлайн <span className="ad-sub num">· {data.timeline.length}</span>
            </div>
            {data.timeline.length === 0 ? (
              <div className="ad-empty">Событий в окне нет.</div>
            ) : (
              <div className="ad-table-wrap scroll-thin">
                <table className="ad-table ad-acc-table">
                  <thead>
                    <tr>
                      <th>время</th>
                      <th>зритель</th>
                      <th>событие</th>
                      <th>детали</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.timeline.map((t, i) => (
                      <tr key={`${t.ts}-${i}`} className={t.ok ? '' : 'is-dim'}>
                        <td className="num">{clock(t.ts)}</td>
                        <td>{t.userLogin ?? t.userId ?? '—'}</td>
                        <td className="mono">{t.step}</td>
                        <td title={t.text}>{t.text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : error ? null : (
        <div className="ad-empty">Загружаю монитор…</div>
      )}
    </section>
  );
}
