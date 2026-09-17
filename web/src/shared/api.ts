import type { ApiError, ApiErrorCode } from './types';

/**
 * Same-origin by default: the Vite dev server and the production reverse proxy
 * both forward /api. VITE_API_BASE is only set for the Twitch extension bundle,
 * which is served from Twitch's CDN and must call the backend cross-origin.
 */
export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';

export class ApiFailure extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}

export type TokenProvider = () => string | null | Promise<string | null>;

export interface ApiClientOptions {
  /** Returns the bearer token for this surface (ext JWT, device or admin token). */
  getToken?: TokenProvider;
  basePath?: string;
}

export class ApiClient {
  constructor(private readonly opts: ApiClientOptions = {}) {}

  private async headers(body: boolean): Promise<Record<string, string>> {
    const h: Record<string, string> = {};
    if (body) h['Content-Type'] = 'application/json';
    const token = await this.opts.getToken?.();
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${API_BASE}${this.opts.basePath ?? ''}${path}`, {
      method,
      headers: await this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: 'internal', message: text.slice(0, 200) };
      }
    }

    if (!res.ok) {
      const err = (parsed ?? {}) as Partial<ApiError>;
      throw new ApiFailure(
        (err.error as ApiErrorCode) ?? 'internal',
        err.message ?? `Request failed (${res.status})`,
        res.status,
        err.details,
      );
    }
    return parsed as T;
  }

  get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>('GET', path, undefined, signal);
  }
  post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>('POST', path, body ?? {}, signal);
  }
  put<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>('PUT', path, body ?? {}, signal);
  }
}

/** Russian copy for every error the viewer can actually hit. */
const VIEWER_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  needs_id_share: 'Нужно поделиться Twitch-аккаунтом, чтобы засчитать оплату',
  rate_limited: 'Слишком часто. Подожди пару секунд',
  gps_unavailable: 'GPS временно недоступен',
  waypoints_closed: 'Приём точек сейчас закрыт',
  waypoint_active: 'Сейчас выполняется задание. Следующую точку можно будет выбрать после завершения',
  no_walking_route: 'Сюда нельзя построить пеший маршрут',
  too_far_from_walkable: 'Сюда нельзя построить пеший маршрут',
  out_of_bounds: 'Эта точка вне Пхукета',
  restricted_zone: 'Эта зона закрыта стримером',
  too_far: 'Слишком далеко для пешего задания',
  no_free_slots: 'Сейчас слишком много запросов. Попробуй через несколько секунд',
  quote_expired: 'Расчёт устарел. Выбери точку заново',
  quote_not_found: 'Расчёт не найден. Выбери точку заново',
  provider_error: 'Картографический сервис не ответил. Попробуй ещё раз',
  unauthorized: 'Twitch не подтвердил сессию. Перезагрузи страницу',
};

export function viewerMessage(err: unknown): string {
  if (err instanceof ApiFailure) return VIEWER_MESSAGES[err.code] ?? err.message;
  if (err instanceof Error) return err.message;
  return 'Что-то пошло не так';
}
