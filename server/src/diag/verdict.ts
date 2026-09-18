import { MIN_IFRAME_PX, type LastIframeRequest, type LastSessionSummary, type Verdict, type VerdictCode } from './schema.js';

/**
 * The one line /admin leads with: is the map button in front of viewers, and
 * if not, which layer failed. The rules are the table in
 * docs/EXTENSION_DIAGNOSTICS.md §5, checked in order, first match wins.
 */

/** How long Twitch's request may go unanswered before the page counts as silent. */
const SILENT_AFTER_MS = 20_000;
/** How long a fresh page load gets before a missing trigger or bundle counts. */
const LOADING_MS = 10_000;

const TEXT: Record<VerdictCode, { ok: boolean; text: string }> = {
  no_data: {
    ok: false,
    text: 'Twitch ещё не загружал расширение. Запустите стрим и откройте канал.',
  },
  request_only: {
    ok: false,
    text: 'Twitch запросил страницу, но она не отчиталась: скрипты в iframe не выполнились.',
  },
  pending: { ok: false, text: 'Расширение загружается…' },
  helper_missing: { ok: false, text: 'Twitch Helper не загрузился в iframe.' },
  bundle_missing: { ok: false, text: 'HTML загрузился, но приложение не запустилось.' },
  trigger_missing: { ok: false, text: 'Приложение запустилось, но кнопка карты не появилась: <trigger>.' },
  iframe_hidden: {
    ok: false,
    text: 'Twitch загрузил iframe, но скрыл его (видео на паузе, стрим офлайн или плеер свёрнут).',
  },
  trigger_hidden: { ok: false, text: 'Кнопка карты есть, но не видна: <trigger>.' },
  ok_unauthorized: {
    ok: true,
    text: 'Кнопка карты видна. onAuthorized ещё не пришёл — покупка точек пока недоступна.',
  },
  ok: { ok: true, text: 'Кнопка карты видна зрителю.' },
};

/**
 * iframe_hidden says which of its three causes it is: the owner acts on this
 * line, and "unpause the video" is the wrong advice for a background tab.
 */
const HIDDEN_TEXT = {
  twitch: TEXT.iframe_hidden.text,
  size: (viewport: string) => `Twitch загрузил iframe, но дал ему почти нулевой размер (${viewport}).`,
  doc: 'Страница расширения открыта в фоновой вкладке и ещё ни разу не была на экране.',
};

/** Said after an ok verdict whose page has since gone out of view. */
const NOW_HIDDEN_NOTE = ' Сейчас страница не на экране: вкладка в фоне или закрыта, либо видео на паузе.';

/** Said when the raw SMOKE_TEST button was seen while the map button was not. */
const RAW_VISIBLE_NOTE = ' Кнопка EXTENSION LOADED при этом видна: iframe показан, кнопку прячет приложение.';

function verdict(code: VerdictCode, detail?: string, suffix = ''): Verdict {
  const { ok, text } = TEXT[code];
  return { code, ok, text: (detail === undefined ? text : text.replace('<trigger>', detail)) + suffix };
}

function parseViewport(v: string | null): { w: number; h: number } | null {
  const m = v ? /^(\d+)×(\d+)$/.exec(v) : null;
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/** "скрыта: display none (react)" reads as "…не видна: display none (react)". */
function hiddenReason(trigger: string | null): string {
  return (trigger ? trigger.replace(/^скрыта:?\s*/, '') : '') || 'подробностей нет';
}

/** Why the page is not on screen right now, as iframe_hidden text; null when it is. */
function hiddenNow(s: LastSessionSummary): string | null {
  if (s.twitchVisible === false) return HIDDEN_TEXT.twitch;
  const viewport = parseViewport(s.viewport);
  if (viewport && (viewport.w < MIN_IFRAME_PX || viewport.h < MIN_IFRAME_PX)) return HIDDEN_TEXT.size(s.viewport ?? '');
  if (s.docVisibility !== null && s.docVisibility !== 'visible') return HIDDEN_TEXT.doc;
  return null;
}

export interface VerdictInput {
  /** The newest iframe request for a page of lastSession's surface. */
  lastIframeRequest: LastIframeRequest | null;
  lastSession: LastSessionSummary | null;
  /** Server time, epoch ms. */
  now: number;
}

export function computeVerdict({ lastIframeRequest, lastSession, now }: VerdictInput): Verdict {
  if (!lastIframeRequest && !lastSession) return verdict('no_data');

  if (lastIframeRequest) {
    const requestedAt = Date.parse(lastIframeRequest.ts);
    // A request with no session after it: Twitch asked, the page never spoke.
    const unanswered =
      !lastSession || requestedAt > Date.parse(lastSession.lastAt) + SILENT_AFTER_MS;
    if (unanswered && now - requestedAt >= SILENT_AFTER_MS) return verdict('request_only');
  }

  const s = lastSession;
  if (!s) return verdict('pending');

  const age = now - Date.parse(s.firstAt);
  if (age < LOADING_MS && s.triggerVisible === null && !s.appBundleMissing) {
    return verdict('pending');
  }

  if (s.helperPresent === false) return verdict('helper_missing');

  if (s.htmlLoaded && (s.appBundleMissing || (!s.appBundleLoaded && age >= LOADING_MS))) {
    return verdict('bundle_missing');
  }

  // The bundle ran, yet 10 s on the map button was never measured: React
  // failed to render it (an error in the first render unmounts everything),
  // whatever the raw SMOKE_TEST button still shows. The config page has no
  // map button to measure.
  if (s.surface !== 'config' && s.appBundleLoaded && s.triggerVisible === null && age >= LOADING_MS) {
    return verdict('trigger_missing', s.lastError ?? 'ошибок страница не прислала');
  }

  // A measurement taken while the page was on screen settles it. A tab
  // switched away from, a closed stream or a later pause is the viewer
  // leaving — not Twitch hiding the extension, and not a broken button.
  if (s.onScreenTriggerVisible === true) {
    return verdict(s.authorized ? 'ok' : 'ok_unauthorized', undefined, hiddenNow(s) ? NOW_HIDDEN_NOTE : '');
  }
  if (s.onScreenTriggerVisible === false) {
    return verdict('trigger_hidden', hiddenReason(s.onScreenTrigger), s.rawVisible ? RAW_VISIBLE_NOTE : '');
  }

  // Never on screen yet: say why, from the page's current state.
  const hidden = hiddenNow(s);
  if (hidden) return { code: 'iframe_hidden', ok: false, text: hidden };

  if (s.triggerVisible === false) {
    return verdict('trigger_hidden', hiddenReason(s.trigger), s.rawVisible ? RAW_VISIBLE_NOTE : '');
  }

  if (s.triggerVisible === true) return verdict(s.authorized ? 'ok' : 'ok_unauthorized');

  return verdict('pending');
}
