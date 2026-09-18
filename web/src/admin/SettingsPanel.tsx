import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ApiClient } from '../shared/api';
import { ApiFailure } from '../shared/api';
import { formatDistance, formatInteger, formatPoints } from '../shared/format';
import type { ChannelSettings, LngLat, PaymentMode, PricingConfig, RestrictedZone } from '../shared/types';

import type { ToastKind } from './App';

/** Local copy so this module never imports a value from App (no import cycle). */
function errorText(err: unknown): string {
  if (err instanceof ApiFailure) return err.code === 'internal' ? err.message : `${err.message} · ${err.code}`;
  if (err instanceof Error) return err.message;
  return 'Неизвестная ошибка';
}

// ---------------------------------------------------------------------------
// Field description
// ---------------------------------------------------------------------------

type NumericKey =
  | 'baseCost'
  | 'pointsPer100Meters'
  | 'minimumCost'
  | 'maximumCost'
  | 'roundTo'
  | 'maxWalkingDistanceMeters'
  | 'quoteTtlSeconds'
  | 'rewardSlotPoolSize'
  | 'gpsTimeoutSeconds'
  | 'maxGpsAccuracyMeters'
  | 'maxSnapDistanceMeters'
  | 'viewerLocationDelaySeconds'
  | 'viewerLocationPrecision'
  | 'quotesPerMinute'
  | 'searchesPerMinute';

interface FieldSpec {
  key: NumericKey;
  label: string;
  min: number;
  max?: number;
  integer: boolean;
  hint?: string;
}

interface FieldGroup {
  title: string;
  fields: FieldSpec[];
}

const GROUPS: FieldGroup[] = [
  {
    title: 'Цена',
    fields: [
      // The unit is added at render time: GTA$ or Channel Points, by payment mode.
      { key: 'baseCost', label: 'База', min: 0, integer: true },
      { key: 'pointsPer100Meters', label: 'За 100 м', min: 0, integer: true },
      { key: 'minimumCost', label: 'Минимум', min: 1, integer: true },
      { key: 'maximumCost', label: 'Максимум', min: 1, integer: true },
      { key: 'roundTo', label: 'Округлять до', min: 1, integer: true },
    ],
  },
  {
    title: 'Лимиты',
    fields: [
      // Bounds mirror settingsPatchSchema in server/src/domain/settings.ts.
      { key: 'maxWalkingDistanceMeters', label: 'Макс. дистанция, м', min: 100, max: 50000, integer: true },
      { key: 'quoteTtlSeconds', label: 'Жизнь расчёта, с', min: 15, max: 600, integer: true },
      { key: 'rewardSlotPoolSize', label: 'Слотов наград', min: 1, max: 40, integer: true },
      { key: 'gpsTimeoutSeconds', label: 'Таймаут GPS, с', min: 5, max: 300, integer: true },
      { key: 'maxGpsAccuracyMeters', label: 'Макс. погрешность, м', min: 5, max: 2000, integer: true },
      { key: 'maxSnapDistanceMeters', label: 'Макс. привязка, м', min: 10, max: 2000, integer: true },
    ],
  },
  {
    title: 'Приват',
    fields: [
      { key: 'viewerLocationDelaySeconds', label: 'Задержка зрителям, с', min: 0, integer: true },
      {
        key: 'viewerLocationPrecision',
        label: 'Знаков координат',
        min: 0,
        max: 6,
        integer: true,
        hint: '4 ≈ 11 м',
      },
    ],
  },
  {
    title: 'Лимиты запросов',
    fields: [
      { key: 'quotesPerMinute', label: 'Расчётов в минуту', min: 1, integer: true },
      { key: 'searchesPerMinute', label: 'Поисков в минуту', min: 1, integer: true },
    ],
  },
];

const FIELDS: FieldSpec[] = GROUPS.flatMap((group) => group.fields);
const PREVIEW_DISTANCES = [250, 500, 1000, 2000, 5000];

type Draft = Record<NumericKey, string>;

interface FieldState {
  value: number | null;
  error: string | null;
  dirty: boolean;
}

function toDraft(settings: ChannelSettings): Draft {
  const draft = {} as Draft;
  for (const field of FIELDS) draft[field.key] = String(settings[field.key]);
  return draft;
}

function validate(field: FieldSpec, raw: string): { value: number | null; error: string | null } {
  const text = raw.trim().replace(',', '.');
  if (!text) return { value: null, error: 'пусто' };
  const value = Number(text);
  if (!Number.isFinite(value)) return { value: null, error: 'не число' };
  if (field.integer && !Number.isInteger(value)) return { value: null, error: 'только целое' };
  if (value < field.min) return { value: null, error: `не меньше ${field.min}` };
  if (field.max != null && value > field.max) return { value: null, error: `не больше ${field.max}` };
  return { value, error: null };
}

/** The published formula, mirrored for preview only. The server always wins. */
function previewCost(distanceMeters: number, pricing: PricingConfig): number {
  const raw = pricing.baseCost + Math.ceil(distanceMeters / 100) * pricing.pointsPer100Meters;
  const step = pricing.roundTo > 0 ? pricing.roundTo : 0;
  const rounded = step > 0 ? Math.ceil(raw / step) * step : raw;
  return Math.min(Math.max(rounded, pricing.minimumCost), pricing.maximumCost);
}

// ---------------------------------------------------------------------------
// Restricted zones
// ---------------------------------------------------------------------------

function zonesToText(zones: RestrictedZone[] | null | undefined): string {
  return JSON.stringify(Array.isArray(zones) ? zones : [], null, 2);
}

function parseZones(text: string): { zones: RestrictedZone[] | null; error: string | null } {
  const trimmed = text.trim();
  if (!trimmed) return { zones: [], error: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { zones: null, error: `Невалидный JSON: ${err instanceof Error ? err.message : 'разбор не удался'}` };
  }
  if (!Array.isArray(parsed)) return { zones: null, error: 'Ожидается массив зон: [ … ]' };

  const items = parsed as unknown[];
  const out: RestrictedZone[] = [];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const at = `Зона #${i + 1}`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { zones: null, error: `${at}: ожидается объект { id, name, polygon }` };
    }
    const record = item as Record<string, unknown>;
    const id = record.id;
    const name = record.name;
    const polygon = record.polygon;
    if (typeof id !== 'string' || !id.trim()) return { zones: null, error: `${at}: нужно поле id (строка)` };
    if (typeof name !== 'string' || !name.trim()) {
      return { zones: null, error: `${at}: нужно поле name (строка)` };
    }
    if (!Array.isArray(polygon) || polygon.length < 3) {
      return { zones: null, error: `${at} «${name}»: polygon — минимум 3 точки [lng, lat]` };
    }

    const points = polygon as unknown[];
    const ring: LngLat[] = [];
    for (let j = 0; j < points.length; j += 1) {
      const point = points[j];
      const where = `${at} «${name}», точка #${j + 1}`;
      if (!Array.isArray(point) || point.length < 2) {
        return { zones: null, error: `${where}: ожидается пара [lng, lat]` };
      }
      const pair = point as unknown[];
      const lng = pair[0];
      const lat = pair[1];
      if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat)) {
        return { zones: null, error: `${where}: координаты должны быть числами` };
      }
      if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        return { zones: null, error: `${where}: координаты вне допустимого диапазона` };
      }
      ring.push([lng, lat]);
    }
    out.push({ id, name, polygon: ring });
  }

  return { zones: out, error: null };
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface SettingsPanelProps {
  api: ApiClient;
  /** Latest server copy seen by the poll/socket, used to refresh a clean form. */
  externalSettings: ChannelSettings | null;
  /**
   * What the pricing fields are denominated in (docs/GTA_DOLLAR_ECONOMY.md §1):
   * the same numbers are GTA$ in `gta_dollar` mode and Channel Points in the
   * legacy mode. Null until /api/admin/state has said; no unit is shown then.
   */
  paymentMode: PaymentMode | null;
  onToast: (kind: ToastKind, text: string) => void;
  onAuthError: (err: unknown) => boolean;
  onSaved: (settings: ChannelSettings) => void;
}

export function SettingsPanel({
  api,
  externalSettings,
  paymentMode,
  onToast,
  onAuthError,
  onSaved,
}: SettingsPanelProps): JSX.Element {
  const [server, setServer] = useState<ChannelSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [zonesText, setZonesText] = useState('[]');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const adoptedRef = useRef<string>('');
  const dirtyRef = useRef(false);

  const adopt = useCallback((next: ChannelSettings) => {
    adoptedRef.current = JSON.stringify(next);
    setServer(next);
    setDraft(toDraft(next));
    setZonesText(zonesToText(next.restrictedZones));
    setStale(false);
    setSaveError(null);
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const next = await api.get<ChannelSettings>('/api/admin/settings');
        if (!next || typeof next.baseCost !== 'number') throw new Error('Пустой ответ настроек');
        adopt(next);
      } catch (err) {
        if (!onAuthError(err)) setLoadError(errorText(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [api, adopt, onAuthError]);

  useEffect(() => {
    load();
  }, [load]);

  // --- derived state -------------------------------------------------------

  const fieldStates = useMemo<Record<NumericKey, FieldState>>(() => {
    const states = {} as Record<NumericKey, FieldState>;
    for (const field of FIELDS) {
      const raw = draft ? draft[field.key] : '';
      const { value, error } = validate(field, raw);
      const dirty = server != null && error === null && value !== null && value !== server[field.key];
      states[field.key] = { value, error, dirty };
    }
    return states;
  }, [draft, server]);

  const zonesParsed = useMemo(() => parseZones(zonesText), [zonesText]);
  const zonesDirty =
    server != null &&
    zonesParsed.zones != null &&
    JSON.stringify(zonesParsed.zones) !== JSON.stringify(server.restrictedZones ?? []);

  const dirtyKeys = FIELDS.filter((field) => fieldStates[field.key].dirty).map((field) => field.key);
  const hasErrors = FIELDS.some((field) => fieldStates[field.key].error !== null) || zonesParsed.error !== null;
  const dirtyCount = dirtyKeys.length + (zonesDirty ? 1 : 0);

  dirtyRef.current = dirtyCount > 0;

  // Adopt server-pushed settings only while the form is clean.
  const externalKey = externalSettings ? JSON.stringify(externalSettings) : '';
  useEffect(() => {
    if (!externalSettings || !externalKey) return;
    if (externalKey === adoptedRef.current) return;
    if (dirtyRef.current) {
      setStale(true);
      return;
    }
    adopt(externalSettings);
    // externalSettings gets a new identity on every poll; the string key is the gate.
  }, [externalKey, externalSettings, adopt]);

  const pricing: PricingConfig | null = server
    ? {
        baseCost: fieldStates.baseCost.value ?? server.baseCost,
        pointsPer100Meters: fieldStates.pointsPer100Meters.value ?? server.pointsPer100Meters,
        minimumCost: fieldStates.minimumCost.value ?? server.minimumCost,
        maximumCost: fieldStates.maximumCost.value ?? server.maximumCost,
        roundTo: fieldStates.roundTo.value ?? server.roundTo,
      }
    : null;

  const maxWalking = fieldStates.maxWalkingDistanceMeters.value ?? server?.maxWalkingDistanceMeters ?? null;

  // At the default rate a GTA$ is a tenth of an ETH: a price typed while
  // thinking in the wrong unit is off tenfold, so the unit is always named.
  const priceUnit =
    paymentMode === 'gta_dollar' ? 'GTA$' : paymentMode === 'channel_points_reward' ? 'баллы' : null;
  const labelOf = (field: FieldSpec): string =>
    field.key === 'baseCost' && priceUnit ? `${field.label}, ${priceUnit}` : field.label;
  const formatPrice = (cost: number): string =>
    paymentMode === 'gta_dollar' ? formatInteger(cost) : formatPoints(cost);
  const priceWarning =
    pricing && pricing.minimumCost > pricing.maximumCost
      ? 'Минимум больше максимума — сервер, скорее всего, это отклонит.'
      : null;

  // --- save ----------------------------------------------------------------

  const save = (): void => {
    if (!server || !draft || saving || dirtyCount === 0 || hasErrors) return;
    const patch: Partial<ChannelSettings> = {};
    for (const field of FIELDS) {
      const state = fieldStates[field.key];
      if (state.dirty && state.error === null && state.value !== null) patch[field.key] = state.value;
    }
    if (zonesDirty && zonesParsed.zones) patch.restrictedZones = zonesParsed.zones;

    setSaving(true);
    setSaveError(null);
    void (async () => {
      try {
        const next = await api.put<ChannelSettings>('/api/admin/settings', patch);
        if (next && typeof next.baseCost === 'number') {
          adopt(next);
          onSaved(next);
        } else {
          load();
        }
        onToast('ok', `Настройки сохранены: полей ${dirtyCount}`);
      } catch (err) {
        if (onAuthError(err)) return;
        let message = err instanceof ApiFailure ? err.message : errorText(err);
        // A 422 carries {path, message}[] naming the offending fields; without
        // them the user only sees "некорректные данные" and has to guess.
        if (err instanceof ApiFailure && Array.isArray(err.details)) {
          const fields = (err.details as { path?: string; message?: string }[])
            .map((d) => (d.path ? `${d.path}: ${d.message ?? ''}`.trim() : d.message))
            .filter(Boolean);
          if (fields.length) message = `${message} — ${fields.join('; ')}`;
        }
        setSaveError(message);
        onToast('err', message);
      } finally {
        setSaving(false);
      }
    })();
  };

  const setField = (key: NumericKey, value: string): void => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next: Draft = { ...prev };
      next[key] = value;
      return next;
    });
  };

  // --- render --------------------------------------------------------------

  if (!server || !draft) {
    return (
      <section className="panel ad-panel">
        <div className="ad-panel-head">
          <div className="ad-panel-title">Настройки канала</div>
        </div>
        {loadError ? (
          <>
            <div className="ad-err ad-err-block">{loadError}</div>
            <button className="btn btn-ghost ad-mt" type="button" onClick={load} disabled={loading}>
              ПОВТОРИТЬ
            </button>
          </>
        ) : (
          <div className="ad-empty">{loading ? 'Загружаю настройки…' : 'Настройки не загружены'}</div>
        )}
      </section>
    );
  }

  return (
    <>
      <section className="panel ad-panel">
        <div className="ad-panel-head">
          <div className="ad-panel-title">Настройки канала</div>
          <div className="ad-panel-note">
            {dirtyCount > 0 ? <b className="is-accent">изменено: {dirtyCount}</b> : 'синхронизировано'}
          </div>
        </div>

        {stale ? (
          <div className="ad-warn is-soft">
            Настройки изменились на сервере, а форма не сохранена.
            <button className="ad-link" type="button" onClick={load}>
              загрузить заново
            </button>
          </div>
        ) : null}

        {GROUPS.map((group) => (
          <div className="ad-group" key={group.title}>
            <div className="label ad-group-title">{group.title}</div>
            <div className="ad-fields">
              {group.fields.map((field) => {
                const state = fieldStates[field.key];
                return (
                  <label className="ad-field" key={field.key}>
                    <span className="label">
                      {labelOf(field)}
                      {field.hint ? <span className="ad-sub"> · {field.hint}</span> : null}
                    </span>
                    <input
                      className={`ad-input num${state.error ? ' is-err' : ''}${
                        state.dirty ? ' is-dirty' : ''
                      }`}
                      type="text"
                      inputMode="numeric"
                      value={draft[field.key]}
                      onChange={(e) => setField(field.key, e.target.value)}
                      disabled={saving}
                    />
                    {state.error ? <span className="ad-err">{state.error}</span> : null}
                  </label>
                );
              })}
            </div>
          </div>
        ))}

        <div className="ad-group">
          <div className="label ad-group-title">Закрытые зоны · JSON</div>
          <textarea
            className="ad-textarea scroll-thin"
            spellCheck={false}
            value={zonesText}
            onChange={(e) => setZonesText(e.target.value)}
            disabled={saving}
            placeholder='[{ "id": "zone-1", "name": "Дом", "polygon": [[98.30, 7.88], [98.31, 7.88], [98.31, 7.89]] }]'
          />
          {zonesParsed.error ? (
            <div className="ad-err ad-err-block">{zonesParsed.error}</div>
          ) : (
            <div className="ad-hint">
              Зон: {zonesParsed.zones?.length ?? 0}. Точки в порядке [lng, lat], минимум 3 на зону.
            </div>
          )}
        </div>

        {saveError ? <div className="ad-err ad-err-block">{saveError}</div> : null}
        {priceWarning ? <div className="ad-warn is-soft">{priceWarning}</div> : null}

        <div className="ad-save-row">
          <button
            className="btn btn-primary"
            type="button"
            onClick={save}
            disabled={saving || dirtyCount === 0 || hasErrors}
          >
            {saving ? 'СОХРАНЯЮ…' : `СОХРАНИТЬ${dirtyCount > 0 ? ` · ${dirtyCount}` : ''}`}
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => adopt(server)}
            disabled={saving || dirtyCount === 0}
          >
            ОТМЕНИТЬ ПРАВКИ
          </button>
          <button className="btn btn-ghost" type="button" onClick={load} disabled={saving || loading}>
            ПЕРЕЧИТАТЬ
          </button>
        </div>
      </section>

      <section className="panel ad-panel">
        <div className="ad-panel-head">
          <div className="ad-panel-title">Предпросмотр цены</div>
          <div className="ad-panel-note">по текущим правкам</div>
        </div>
        <table className="ad-table ad-preview">
          <thead>
            <tr>
              <th>Дистанция</th>
              <th className="is-right">
                {paymentMode === 'gta_dollar' ? 'GTA$' : paymentMode === 'channel_points_reward' ? 'Баллов' : 'Цена'}
              </th>
              <th className="is-right">Сотен метров</th>
            </tr>
          </thead>
          <tbody>
            {PREVIEW_DISTANCES.map((distance) => {
              const overLimit = maxWalking != null && distance > maxWalking;
              return (
                <tr key={distance} className={overLimit ? 'is-dim' : ''}>
                  <td className="num">{formatDistance(distance)}</td>
                  <td className="is-right num">
                    {pricing ? formatPrice(previewCost(distance, pricing)) : '—'}
                    {overLimit ? <span className="ad-sub"> · вне лимита</span> : null}
                  </td>
                  <td className="is-right num">{Math.ceil(distance / 100)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="ad-hint">предпросмотр — итоговую цену всегда считает сервер</div>
      </section>
    </>
  );
}
