import type { ApiError, ApiErrorCode } from './types';

/**
 * Same-origin by default: the Vite dev server and the production reverse proxy
 * both forward /api. VITE_API_BASE is only set for the Twitch extension bundle,
 * which is served from Twitch's CDN and must call the backend cross-origin.
 */
export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';

/** Failures whose response did not come from our API (no JSON body). */
const FOREIGN_FAILURES = new WeakSet<ApiFailure>();

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
  /**
   * Give up on a request that has had no complete answer after this long and
   * reject with a `TimeoutError`, which reads as a network failure. Without it
   * a stalled connection keeps a caller waiting until the browser or a proxy
   * drops it, which can take minutes. Unset: no limit of our own (admin
   * actions that talk to Twitch may legitimately take a while).
   */
  timeoutMs?: number;
}

/** A `TimeoutError` like the one `AbortSignal.timeout` produces. */
function timeoutError(): Error {
  return typeof DOMException === 'function'
    ? new DOMException('The request timed out', 'TimeoutError')
    : Object.assign(new Error('The request timed out'), { name: 'TimeoutError' });
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
    const timeoutMs = this.opts.timeoutMs;
    if (!timeoutMs) return this.send<T>(method, path, body, signal);

    // One controller for both reasons to stop: the caller's own abort (passed
    // on as is, so callers still recognise it) and our deadline. Built by hand
    // rather than with AbortSignal.any/timeout, which older engines lack.
    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError());
    }, timeoutMs);
    try {
      return await this.send<T>(method, path, body, controller.signal);
    } catch (err) {
      // Engines that ignore the abort reason reject with a plain AbortError;
      // a deadline is still reported as a timeout, never as a caller's abort.
      if (timedOut) throw timeoutError();
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  private async send<T>(method: string, path: string, body: unknown, signal: AbortSignal | undefined): Promise<T> {
    const res = await fetch(`${API_BASE}${this.opts.basePath ?? ''}${path}`, {
      method,
      headers: await this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });

    if (res.status === 204) return undefined as T;

    // Still under the same signal: a body that stops arriving times out too.
    const text = await res.text();
    let parsed: unknown = null;
    // Our API always answers with a JSON body; anything else was said by
    // something in front of it (a proxy, a CDN, a captive portal).
    let foreign = !text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        foreign = true;
        parsed = { error: 'internal', message: text.slice(0, 200) };
      }
    }

    if (!res.ok) {
      const err = (parsed ?? {}) as Partial<ApiError>;
      const failure = new ApiFailure(
        (err.error as ApiErrorCode) ?? 'internal',
        err.message ?? `Request failed (${res.status})`,
        res.status,
        err.details,
      );
      if (foreign) FOREIGN_FAILURES.add(failure);
      throw failure;
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

// ---------------------------------------------------------------------------
// What a viewer is told when something fails
//
// A viewer never sees what actually went wrong — no "Failed to fetch", no HTTP
// status, no "JWT invalid", no English server text, no stack. Every failure is
// one of a fixed set of Russian sentences; the technical detail belongs in the
// diagnostics beacon, never on screen.
// ---------------------------------------------------------------------------

/** No verdict from our API: offline, blocked, timed out, or a proxy answering instead. */
export const NETWORK_MESSAGE = 'Нет связи с сервером. Попробуйте ещё раз.';
/** Anything this file has no sentence for. */
export const GENERIC_MESSAGE = 'Что-то пошло не так. Попробуйте ещё раз.';
/** A purchase refused because Twitch has not told the server who is buying. */
export const PURCHASE_IDENTITY_MESSAGE = 'Подключите Twitch для покупки.';

/** Russian copy for every error the viewer can actually hit. */
const VIEWER_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  needs_id_share: 'Нужно поделиться Twitch-аккаунтом, чтобы засчитать оплату.',
  needs_login: 'Войдите в Twitch, чтобы использовать GTA$',
  insufficient_funds: 'Недостаточно GTA$.',
  price_changed: 'Цена изменилась. Выберите точку заново.',
  payment_mode: 'Способ оплаты изменился. Выберите точку заново.',
  rate_limited: 'Слишком часто. Подождите пару секунд.',
  gps_unavailable: 'GPS стримера временно недоступен.',
  waypoints_closed: 'Приём точек сейчас закрыт.',
  waypoint_active: 'Сейчас выполняется задание. Следующую точку можно будет выбрать после завершения.',
  no_walking_route: 'Сюда нельзя построить пеший маршрут.',
  too_far_from_walkable: 'Сюда нельзя построить пеший маршрут.',
  out_of_bounds: 'Эта точка вне Пхукета.',
  restricted_zone: 'Эта зона закрыта стримером.',
  too_far: 'Точка слишком далеко.',
  no_free_slots: 'Сейчас слишком много запросов. Попробуйте через несколько секунд.',
  quote_expired: 'Расчёт устарел. Выберите точку заново.',
  quote_not_found: 'Расчёт не найден. Выберите точку заново.',
  quote_conflict: 'Этот расчёт уже использован. Выберите точку заново.',
  provider_error: 'Картографический сервис не ответил. Попробуйте ещё раз.',
  unauthorized: 'Twitch не подтвердил сессию. Обновите страницу.',
};

/** Every code the server can send; anything else is not ours to interpret. */
const KNOWN_CODES: ReadonlySet<string> = new Set<ApiErrorCode>([
  'unauthorized',
  'forbidden',
  'needs_id_share',
  'needs_login',
  'insufficient_funds',
  'price_changed',
  'payment_mode',
  'rate_limited',
  'gps_unavailable',
  'waypoints_closed',
  'waypoint_active',
  'no_walking_route',
  'too_far_from_walkable',
  'out_of_bounds',
  'restricted_zone',
  'too_far',
  'no_free_slots',
  'quote_not_found',
  'quote_expired',
  'quote_conflict',
  'invalid_request',
  'provider_error',
  'not_found',
  'internal',
]);

/** On a purchase, every "who are you?" refusal is one and the same fix. */
const PURCHASE_IDENTITY_CODES: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  'needs_id_share',
  'needs_login',
  'unauthorized',
  'forbidden',
]);

/** What the reverse proxy answers with when the API itself is not reachable. */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** Where the request was made from, when that changes the sentence. */
export type ViewerAction = 'purchase';

/**
 * The request never got an answer from the API: `fetch` rejected (offline,
 * DNS, CORS, a blocked host), it was aborted or timed out, or something in
 * front of the API answered a server error instead of our JSON.
 */
export function isNetworkFailure(err: unknown): boolean {
  if (err instanceof ApiFailure) {
    if (err.code !== 'internal') return false;
    return GATEWAY_STATUSES.has(err.status) || (FOREIGN_FAILURES.has(err) && err.status >= 500);
  }
  if (err instanceof TypeError) return true;
  const name = err instanceof Error || err instanceof DOMException ? err.name : '';
  return name === 'AbortError' || name === 'TimeoutError' || name === 'NetworkError';
}

/**
 * The server's own sentence for a code this file has no copy for, when it is
 * Russian prose — never when it carries English (a library message, a token
 * error) or anything that looks like a stack or a status line.
 */
function serverSentence(message: string): string | null {
  const text = message.trim();
  if (!text || text.length > 160 || !/[А-Яа-яЁё]/.test(text)) return null;
  // Names the viewer knows are fine; any other Latin word means English, and
  // braces or angle brackets mean markup or a serialised object.
  const rest = text.replace(/GTA\$|GTA|GPS|Twitch|ETH/g, '');
  return /[A-Za-z{}<>\\]/.test(rest) ? null : text;
}

/** True when the viewer is shown the catch-all sentence: worth a diagnostics line. */
export function isUnexplainedError(err: unknown): boolean {
  if (isNetworkFailure(err)) return false;
  if (!(err instanceof ApiFailure) || !KNOWN_CODES.has(err.code)) return true;
  return VIEWER_MESSAGES[err.code] === undefined && serverSentence(err.message) === null;
}

/**
 * The one sentence a viewer sees for a failure. `action` picks the wording
 * where the same code means different things in different places.
 */
export function viewerMessage(err: unknown, action?: ViewerAction): string {
  if (isNetworkFailure(err)) return NETWORK_MESSAGE;
  if (!(err instanceof ApiFailure) || !KNOWN_CODES.has(err.code)) return GENERIC_MESSAGE;
  if (action === 'purchase' && PURCHASE_IDENTITY_CODES.has(err.code)) return PURCHASE_IDENTITY_MESSAGE;
  return VIEWER_MESSAGES[err.code] ?? serverSentence(err.message) ?? GENERIC_MESSAGE;
}
