/**
 * Twitch extension boot script.
 *
 * The second script on every Twitch page, straight after Twitch's own helper
 * and ahead of anything of ours that can fail — React, Mapbox, the API. The
 * Vite plugin in web/vite.config.ts puts it there; the contract is
 * docs/EXTENSION_DIAGNOSTICS.md, sections 2 and 3.
 *
 * It exists so the owner never has to open DevTools inside a Twitch iframe.
 * Every page load reports to POST /api/diag/ext, on its own: the HTML ran, the
 * helper is there (and which version), onAuthorized fired or not, how big and
 * how visible the iframe is, where the map button ended up, and every runtime
 * error and CSP violation on the way.
 *
 * Ground rules:
 *   - ES2017, one IIFE, no dependencies, no module syntax: a classic script
 *     from our own origin is exactly what the extension CSP allows ('self').
 *   - It never throws into the page. Every hook is wrapped in try/catch.
 *   - It never sends a token, a secret, a cookie, a query string or a user id.
 *     The auth object Twitch hands over stays in memory, for the app only.
 *
 * It is also the ONLY place that registers the Twitch helper callbacks. The
 * helper keeps one listener per callback — onAuthorized, onContext,
 * onVisibilityChanged, onHighlightChanged and onError each drop the previous
 * listener before adding the new one — so a second registration would silently
 * unhook this one. The app subscribes through __GTAMAP_BOOT__.twitch.on()
 * instead (web/src/viewer/diag.ts).
 */
(function () {
  'use strict';

  // A duplicate tag must not wire the helper a second time, for the reason
  // above: the second copy would take the callbacks away from the first.
  try {
    if (window.__GTAMAP_BOOT__) return;
  } catch (e) {
    return;
  }

  const EVENT_NAMES = [
    'html_loaded', 'app_bundle_loaded', 'app_bundle_missing',
    'twitch_helper_present', 'onAuthorized_fired', 'onContext_first',
    'onVisibilityChanged', 'onHighlightChanged', 'document_visibility',
    'viewport_resize', 'trigger_rendered', 'trigger_check',
    'raw_button_upgraded', 'map_opened', 'runtime_error',
    'unhandled_rejection', 'resource_error', 'csp_violation',
    'twitch_ext_error', 'page_hide',
  ];

  // Events that can fire in bursts (dragging a window, hovering the extension
  // icon, a flapping tab). One per name per THROTTLE_MS, keeping the latest.
  const THROTTLED = [
    'onHighlightChanged', 'viewport_resize', 'document_visibility',
    'trigger_check', 'onVisibilityChanged',
  ];

  const THROTTLE_MS = 1500;
  const FLUSH_MS = 250;
  const MAX_BATCH_EVENTS = 25;
  // The server takes 32 KB per request. Well under it, and small enough that a
  // few keepalive requests in flight stay inside the browser's 64 KB quota.
  const MAX_BATCH_BYTES = 16000;
  const MAX_SESSION_EVENTS = 400;
  const APP_TIMEOUT_MS = 10000;
  // The same error or CSP violation repeated in a loop must not eat the
  // session budget: after this many identical reports the rest are dropped.
  const MAX_REPEATS = 3;

  const SURFACES = ['video_overlay', 'mobile', 'config', 'panel'];
  const PARAM_KEYS = ['anchor', 'platform', 'mode', 'state', 'language', 'locale', 'popout'];
  const CONTEXT_KEYS = [
    'mode', 'isFullScreen', 'isPaused', 'isTheatreMode', 'playbackMode',
    'arePlayerControlsVisible', 'theme',
  ];
  const VIEWER_KINDS = ['anonymous', 'logged_in', 'identified', 'unknown'];
  const SECRET_KEY = /token|jwt|secret|password|cookie|authorization|helix/i;
  const MAX_STRING = 300;

  const noop = function () {};

  function guard(fn) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (e) {
        return undefined;
      }
    };
  }

  // ---------------------------------------------------------------- scrubbing

  /**
   * At most `max` characters, never cutting a surrogate pair in half: a lone
   * half is written as a \udXXX escape that the server's jsonb would refuse.
   */
  function cut(s, max) {
    if (s.length <= max) return s;
    return s.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
  }

  /** origin + path: no query string, no fragment, whatever the scheme. */
  function stripUrl(url) {
    return String(url || '').replace(/[?#][\s\S]*$/, '');
  }

  function originOf(url) {
    try {
      if (!url) return null;
      return new URL(String(url), window.location.href).origin;
    } catch (e) {
      return null;
    }
  }

  /**
   * Every string that leaves the page goes through here. A message can quote a
   * URL with a token in its query, or a whole Authorization header; neither
   * survives. The server applies the same rules again.
   */
  function scrub(value) {
    let s = String(value);
    s = s.replace(/eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g, '[jwt]');
    s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
    s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]+/gi, stripUrl);
    s = s.replace(/(\/[^\s?#"'<>()]*)[?#][^\s"'<>()]*/g, '$1');
    return cut(s, MAX_STRING);
  }

  /**
   * Deep copy that keeps only small plain data: keys that look like secrets
   * are dropped, depth <= 4, <= 40 keys per object, <= 10 array items.
   * Returns undefined for anything that should not be sent at all.
   */
  function clean(value, depth) {
    if (value === null) return null;
    const type = typeof value;
    if (type === 'string') return scrub(value);
    if (type === 'number') return isFinite(value) ? value : null;
    if (type === 'boolean') return value;
    if (type !== 'object' || depth > 4) return undefined;
    if (Array.isArray(value)) {
      const list = [];
      for (let i = 0; i < value.length && list.length < 10; i++) {
        const item = clean(value[i], depth + 1);
        if (item !== undefined) list.push(item);
      }
      return list;
    }
    const out = {};
    let count = 0;
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length && count < 40; i++) {
      const key = keys[i];
      if (SECRET_KEY.test(key)) continue;
      const item = clean(value[key], depth + 1);
      if (item === undefined) continue;
      out[key] = item;
      count += 1;
    }
    return out;
  }

  function digitsOrNull(value) {
    return typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : null;
  }

  function shortString(value) {
    return typeof value === 'string' && value ? cut(scrub(value), 64) : null;
  }

  function errorInfo(err) {
    if (err && typeof err === 'object') {
      const name = typeof err.name === 'string' && err.name !== 'Error' ? err.name + ': ' : '';
      if (typeof err.message === 'string') return { message: scrub(name + err.message) };
    }
    return { message: scrub(err === undefined ? 'undefined' : String(err)) };
  }

  // ------------------------------------------------------------------ session

  function makeSession() {
    const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const length = 22;
    let out = '';
    try {
      const bytes = new Uint8Array(length);
      window.crypto.getRandomValues(bytes);
      for (let i = 0; i < length; i++) out += abc.charAt(bytes[i] & 63);
      return out;
    } catch (e) {
      out = '';
    }
    for (let i = 0; i < length; i++) out += abc.charAt(Math.floor(Math.random() * 64));
    return out;
  }

  // ------------------------------------------------------------ page facts

  const meta = document.querySelector('meta[name="gtamap-boot"]');

  function metaAttr(name) {
    return meta ? meta.getAttribute(name) || '' : '';
  }

  const session = makeSession();
  const surfaceAttr = metaAttr('data-surface');
  const surface = SURFACES.indexOf(surfaceAttr) >= 0 ? surfaceAttr : 'unknown';
  const apiBase = metaAttr('data-api-base').replace(/\/+$/, '');
  const smoke = metaAttr('data-smoke') === 'true';
  const dev = metaAttr('data-dev') === 'true';

  function isFramed() {
    try {
      return window.self !== window.top;
    } catch (e) {
      // Reading `top` across origins can throw in older engines: that is a frame.
      return true;
    }
  }

  function readAncestors() {
    const out = [];
    try {
      const list = window.location.ancestorOrigins;
      if (list) for (let i = 0; i < list.length && out.length < 5; i++) out.push(scrub(list[i]));
    } catch (e) {
      /* Firefox has no ancestorOrigins */
    }
    return out;
  }

  /** Only the parameters Twitch itself appends, and only plain values. */
  function readParams() {
    const out = {};
    try {
      const query = new URLSearchParams(window.location.search);
      for (let i = 0; i < PARAM_KEYS.length; i++) {
        const value = query.get(PARAM_KEYS[i]);
        if (value && /^[A-Za-z0-9_.-]{1,40}$/.test(value)) out[PARAM_KEYS[i]] = value;
      }
    } catch (e) {
      /* no URLSearchParams: send no params */
    }
    return out;
  }

  function helperExt() {
    try {
      const twitch = window.Twitch;
      return twitch && twitch.ext ? twitch.ext : null;
    } catch (e) {
      return null;
    }
  }

  function viewport() {
    return {
      w: Math.round(window.innerWidth || 0),
      h: Math.round(window.innerHeight || 0),
      dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
    };
  }

  const initialExt = helperExt();

  const snap = {
    stage: 'boot',
    viewport: viewport(),
    docVisibility: document.visibilityState || 'visible',
    twitchVisible: null,
    highlighted: null,
    helperPresent: !!initialExt,
    helperVersion: initialExt ? shortString(initialExt.version) : null,
    authorized: false,
    channelId: null,
    viewerKind: 'unknown',
    framed: isFramed(),
    pageOrigin: (function () {
      try {
        return String(window.location.origin);
      } catch (e) {
        return null;
      }
    })(),
    referrerOrigin: originOf(document.referrer),
    ancestorOrigins: readAncestors(),
    params: readParams(),
    smoke: smoke,
    dev: dev,
    triggerVisible: null,
  };

  /** The live snapshot: viewport and document visibility are read now. */
  function snapshot() {
    const out = Object.assign({}, snap);
    out.viewport = viewport();
    out.docVisibility = document.visibilityState || 'visible';
    out.ancestorOrigins = snap.ancestorOrigins.slice();
    out.params = Object.assign({}, snap.params);
    return out;
  }

  function isBoolOrNull(value) {
    return value === null || typeof value === 'boolean';
  }

  /**
   * Only the fields the app is meant to update, each type-checked, so a bad
   * call can never put a user id or a token into every later event.
   */
  function setSnap(partial) {
    if (!partial || typeof partial !== 'object') return;
    if (partial.stage === 'boot' || partial.stage === 'app') snap.stage = partial.stage;
    if (typeof partial.authorized === 'boolean') snap.authorized = partial.authorized;
    if ('channelId' in partial) snap.channelId = digitsOrNull(partial.channelId);
    if (VIEWER_KINDS.indexOf(partial.viewerKind) >= 0) snap.viewerKind = partial.viewerKind;
    if (isBoolOrNull(partial.twitchVisible)) snap.twitchVisible = partial.twitchVisible;
    if (isBoolOrNull(partial.highlighted)) snap.highlighted = partial.highlighted;
    if (isBoolOrNull(partial.triggerVisible)) snap.triggerVisible = partial.triggerVisible;
  }

  // ---------------------------------------------------------------- transport

  const queue = [];
  let seq = 0;
  let accepted = 0;
  let flushTimer = 0;
  const lastSentAt = {};
  const pendingEvent = {};
  const pendingTimer = {};
  const repeats = {};
  const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

  function byteLength(text) {
    return encoder ? encoder.encode(text).length : text.length * 3;
  }

  function post(body, beacon) {
    const url = apiBase + '/api/diag/ext';
    if (!beacon && typeof window.fetch === 'function') {
      // text/plain + no-cors is a CORS "simple request": no preflight, and it
      // works from any origin, including a sandboxed "null" one.
      const init = {
        method: 'POST',
        mode: 'no-cors',
        credentials: 'omit',
        keepalive: true,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: body,
      };
      try {
        window.fetch(url, init).catch(function () {
          // keepalive requests share a 64 KB in-flight quota; one retry
          // without it covers a burst that ran into that limit.
          init.keepalive = false;
          try {
            window.fetch(url, init).catch(noop);
          } catch (e) {
            /* best effort */
          }
        });
        return;
      } catch (e) {
        /* fall through to the beacon */
      }
    }
    try {
      if (navigator.sendBeacon) navigator.sendBeacon(url, body);
    } catch (e) {
      /* best effort */
    }
  }

  function takeBatch() {
    const events = [];
    let bytes = 96;
    while (queue.length && events.length < MAX_BATCH_EVENTS) {
      const size = byteLength(JSON.stringify(queue[0])) + 1;
      if (events.length && bytes + size > MAX_BATCH_BYTES) break;
      events.push(queue.shift());
      bytes += size;
    }
    return JSON.stringify({ v: 1, session: session, surface: surface, events: events });
  }

  function flush(beacon) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = 0;
    }
    while (queue.length) {
      try {
        post(takeBatch(), beacon);
      } catch (e) {
        queue.length = 0;
      }
    }
  }

  function enqueue(item) {
    if (accepted >= MAX_SESSION_EVENTS) return;
    accepted += 1;
    seq += 1;
    const ev = { event: item.event, t: item.t, seq: seq, snap: item.snap };
    if (item.data) ev.data = item.data;
    queue.push(ev);
    if (!flushTimer) flushTimer = setTimeout(guard(flush), FLUSH_MS);
  }

  function releasePending(name) {
    pendingTimer[name] = 0;
    const item = pendingEvent[name];
    pendingEvent[name] = null;
    if (!item) return;
    lastSentAt[name] = Date.now();
    enqueue(item);
  }

  function releaseAllPending() {
    for (let i = 0; i < THROTTLED.length; i++) {
      const name = THROTTLED[i];
      if (pendingTimer[name]) clearTimeout(pendingTimer[name]);
      releasePending(name);
    }
  }

  function send(name, data) {
    if (EVENT_NAMES.indexOf(name) < 0) return;
    if (accepted >= MAX_SESSION_EVENTS) return;
    const item = { event: name, t: Date.now(), snap: snapshot(), data: null };
    const cleaned = clean(data === undefined ? {} : data, 1);
    if (cleaned && typeof cleaned === 'object') item.data = cleaned;

    if (THROTTLED.indexOf(name) < 0) {
      enqueue(item);
      return;
    }
    // Leading edge goes out at once; anything inside the window waits, and
    // only the newest value survives to the trailing edge.
    const since = Date.now() - (lastSentAt[name] || 0);
    if (since >= THROTTLE_MS && !pendingTimer[name]) {
      lastSentAt[name] = Date.now();
      enqueue(item);
      return;
    }
    pendingEvent[name] = item;
    if (!pendingTimer[name]) {
      pendingTimer[name] = setTimeout(guard(function () {
        releasePending(name);
      }), Math.max(0, THROTTLE_MS - since));
    }
  }

  /** send(), but the same failure is reported at most MAX_REPEATS times. */
  function report(name, data, key) {
    const id = name + '|' + key;
    repeats[id] = (repeats[id] || 0) + 1;
    if (repeats[id] > MAX_REPEATS) return;
    send(name, data);
  }

  // ------------------------------------------------------------ trigger probe

  function effectiveOpacity(el) {
    // A transparent ancestor hides the button just as well as its own opacity.
    let opacity = 1;
    let node = el;
    for (let i = 0; node && node.nodeType === 1 && i < 64; i++) {
      const value = parseFloat(window.getComputedStyle(node).opacity);
      if (!isNaN(value)) opacity *= value;
      node = node.parentElement;
    }
    return Math.round(opacity * 100) / 100;
  }

  function measureTrigger(el, which) {
    const info = {
      which: which === 'raw' ? 'raw' : 'react',
      rendered: false,
      rect: { x: 0, y: 0, w: 0, h: 0 },
      display: '',
      visibility: '',
      opacity: 0,
      pointerEvents: '',
      zIndex: '',
      inViewport: false,
      hitTest: 'n/a',
      visible: false,
    };
    try {
      if (!el || !el.isConnected) return info;
      info.rendered = true;
      const r = el.getBoundingClientRect();
      info.rect = {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
      const style = window.getComputedStyle(el);
      info.display = style.display;
      info.visibility = style.visibility;
      info.pointerEvents = style.pointerEvents;
      info.zIndex = style.zIndex;
      info.opacity = effectiveOpacity(el);

      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      info.inViewport = r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
      if (!info.inViewport) {
        info.hitTest = 'outside';
      } else {
        // Centre of the part that is actually on screen.
        const cx = (Math.max(r.left, 0) + Math.min(r.right, vw)) / 2;
        const cy = (Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2;
        const hit = document.elementFromPoint(cx, cy);
        info.hitTest = !hit ? 'n/a' : hit === el || el.contains(hit) ? 'self' : 'covered';
      }
      info.visible =
        info.rect.w > 0 &&
        info.rect.h > 0 &&
        info.display !== 'none' &&
        info.visibility !== 'hidden' &&
        info.opacity > 0.05 &&
        info.inViewport;
    } catch (e) {
      /* whatever was measured so far */
    }
    return info;
  }

  // ------------------------------------------------------------ Twitch bridge

  const KINDS = ['authorized', 'context', 'visibility', 'highlight', 'error'];
  const subscribers = {};
  const latest = {};
  for (let i = 0; i < KINDS.length; i++) {
    subscribers[KINDS[i]] = [];
    latest[KINDS[i]] = null;
  }

  function reportSubscriberError(kind, err) {
    try {
      // eslint-disable-next-line no-console
      console.error('[GTAMAP] twitch.on(' + kind + ') subscriber threw', err);
    } catch (e) {
      /* no console */
    }
    const info = errorInfo(err);
    info.source = 'twitch.on(' + kind + ')';
    report('runtime_error', { error: info }, 'sub|' + kind + '|' + info.message);
  }

  function call(kind, cb, args) {
    try {
      cb.apply(null, args);
    } catch (err) {
      reportSubscriberError(kind, err);
    }
  }

  /** Hands `args` to every subscriber and keeps `replay` for late ones. */
  function fanOut(kind, args, replay) {
    latest[kind] = replay || args;
    const list = subscribers[kind].slice();
    for (let i = 0; i < list.length; i++) call(kind, list[i], args);
  }

  function on(kind, cb) {
    if (!subscribers[kind] || typeof cb !== 'function') return noop;
    subscribers[kind].push(cb);
    if (latest[kind]) call(kind, cb, latest[kind]);
    return function () {
      const list = subscribers[kind];
      const index = list.indexOf(cb);
      if (index >= 0) list.splice(index, 1);
    };
  }

  /**
   * identified = a numeric Twitch id is known (identity shared); otherwise the
   * opaque id says anonymous (A…) or logged in without sharing (U…). The id
   * itself never leaves this function.
   */
  function viewerKindOf(userId, ext) {
    try {
      const viewer = ext && ext.viewer;
      if (viewer && typeof viewer.id === 'string' && /^\d+$/.test(viewer.id)) return 'identified';
    } catch (e) {
      /* viewer getter unavailable */
    }
    if (typeof userId !== 'string' || !userId) return 'unknown';
    if (/^\d+$/.test(userId)) return 'identified';
    if (userId.charAt(0) === 'A') return 'anonymous';
    if (userId.charAt(0) === 'U') return 'logged_in';
    return 'unknown';
  }

  function pickContext(ctx) {
    const out = {};
    for (let i = 0; i < CONTEXT_KEYS.length; i++) {
      const value = ctx[CONTEXT_KEYS[i]];
      const type = typeof value;
      if (type === 'string' || type === 'boolean' || type === 'number') out[CONTEXT_KEYS[i]] = value;
    }
    return out;
  }

  let contextSent = false;
  let mergedContext = {};

  function register(ext, method, handler) {
    try {
      if (typeof ext[method] !== 'function') return false;
      ext[method](guard(handler));
      return true;
    } catch (e) {
      return false;
    }
  }

  function wireHelper(ext) {
    const authorized = register(ext, 'onAuthorized', function (auth) {
      const a = auth && typeof auth === 'object' ? auth : {};
      const channelId = digitsOrNull(a.channelId);
      const kind = viewerKindOf(a.userId, ext);
      // A fresh authorization supersedes an earlier error: late subscribers
      // must not be told about a failure that has since been fixed.
      latest.error = null;
      setSnap({ authorized: true, channelId: channelId, viewerKind: kind });
      send('onAuthorized_fired', { channelId: channelId, clientId: shortString(a.clientId), viewerKind: kind });
      fanOut('authorized', [auth]);
    });

    register(ext, 'onContext', function (ctx, changed) {
      const c = ctx && typeof ctx === 'object' ? ctx : {};
      mergedContext = Object.assign({}, mergedContext, c);
      if (!contextSent) {
        contextSent = true;
        send('onContext_first', pickContext(c));
      }
      fanOut(
        'context',
        [c, Array.isArray(changed) ? changed : []],
        [mergedContext, Object.keys(mergedContext)],
      );
    });

    register(ext, 'onVisibilityChanged', function (visible, ctx) {
      const isVisible = !!visible;
      setSnap({ twitchVisible: isVisible });
      send('onVisibilityChanged', { visible: isVisible });
      fanOut('visibility', [isVisible, ctx && typeof ctx === 'object' ? ctx : null]);
    });

    register(ext, 'onHighlightChanged', function (highlighted) {
      const isHighlighted = !!highlighted;
      setSnap({ highlighted: isHighlighted });
      send('onHighlightChanged', { highlighted: isHighlighted });
      fanOut('highlight', [isHighlighted]);
    });

    register(ext, 'onError', function (err) {
      const info = errorInfo(err);
      report('twitch_ext_error', { error: info }, info.message);
      fanOut('error', [err]);
    });

    return authorized;
  }

  // ------------------------------------------------------------------ public

  let appLoaded = false;

  const boot = {
    version: 1,
    session: session,
    surface: surface,
    apiBase: apiBase,
    smoke: smoke,
    dev: dev,
    send: guard(send),
    setSnap: guard(setSnap),
    snapshot: function () {
      try {
        return snapshot();
      } catch (e) {
        return Object.assign({}, snap);
      }
    },
    markAppLoaded: guard(function () {
      appLoaded = true;
      snap.stage = 'app';
    }),
    measureTrigger: measureTrigger,
    wired: false,
    twitch: {
      on: function (kind, cb) {
        try {
          return on(kind, cb);
        } catch (e) {
          return noop;
        }
      },
    },
  };

  try {
    window.__GTAMAP_BOOT__ = boot;
  } catch (e) {
    return;
  }

  // ---------------------------------------------------------- 2. page hooks

  const hook = guard(function (target, type, handler, capture) {
    target.addEventListener(type, guard(handler), !!capture);
  });

  hook(window, 'securitypolicyviolation', function (ev) {
    const blocked = ev.blockedURI ? stripUrl(ev.blockedURI) : '';
    const csp = {
      directive: ev.effectiveDirective || ev.violatedDirective || '',
      blockedURI: blocked,
      sourceFile: ev.sourceFile ? stripUrl(ev.sourceFile) : '',
      disposition: ev.disposition || '',
    };
    if (ev.lineNumber) csp.line = ev.lineNumber;
    report('csp_violation', { csp: csp }, csp.directive + '|' + blocked + '|' + csp.sourceFile + '|' + (csp.line || 0));
  });

  // Capture phase: load failures of <script>, <link> and <img> do not bubble,
  // but they do pass through window on the way down.
  hook(window, 'error', function (ev) {
    const target = ev.target;
    if (target && target !== window && target.nodeType === 1) {
      const tag = String(target.tagName || 'element').toLowerCase();
      const src =
        (typeof target.currentSrc === 'string' && target.currentSrc) ||
        (typeof target.src === 'string' && target.src) ||
        (typeof target.href === 'string' && target.href) ||
        '';
      const source = stripUrl(src);
      report('resource_error', { error: { message: 'failed to load <' + tag + '>', source: source } }, tag + '|' + source);
      return;
    }
    const error = { message: scrub(ev.message || 'error') };
    if (ev.filename) error.source = stripUrl(ev.filename);
    if (ev.lineno) error.line = ev.lineno;
    if (ev.colno) error.col = ev.colno;
    report('runtime_error', { error: error }, error.message + '|' + (error.source || '') + '|' + (error.line || 0));
  }, true);

  hook(window, 'unhandledrejection', function (ev) {
    const info = errorInfo(ev.reason);
    report('unhandled_rejection', { error: info }, info.message);
  });

  hook(document, 'visibilitychange', function () {
    send('document_visibility', { state: document.visibilityState || 'visible' });
  });

  let reportedSize = viewport();
  hook(window, 'resize', function () {
    const now = viewport();
    if (Math.abs(now.w - reportedSize.w) < 20 && Math.abs(now.h - reportedSize.h) < 20) return;
    reportedSize = now;
    send('viewport_resize', { w: now.w, h: now.h });
  });

  hook(window, 'pagehide', function () {
    send('page_hide', {});
    releaseAllPending();
    flush(true);
  });

  // ------------------------------------------------------------ 3. + 4. helper

  guard(function () {
    send('twitch_helper_present', { present: !!initialExt, version: snap.helperVersion });
    if (initialExt) boot.wired = wireHelper(initialExt);
  })();

  // ---------------------------------------------------- 5. + 6. DOM and bundle

  function checkApp() {
    if (appLoaded) return;
    const scripts = document.querySelectorAll('script[type="module"]');
    const list = [];
    for (let i = 0; i < scripts.length && list.length < 10; i++) {
      if (scripts[i].src) list.push(stripUrl(scripts[i].src));
    }
    send('app_bundle_missing', { moduleScripts: list });
  }

  /**
   * gtamap-raw.css is the raw button's one dependency. When it did not apply
   * (a failed or refused fetch), the bundle's own CSS can still arrive and
   * strip the button to bare text that clicks fall through — so the
   * essentials are set here instead, through CSSOM, which the extension CSP
   * allows. By DOMContentLoaded the stylesheet has either applied or failed:
   * the module script after it waits for it. Returns whether it applied.
   */
  function ensureRawStyle(raw) {
    if (window.getComputedStyle(raw).position === 'fixed') return true;
    const s = raw.style;
    s.position = 'fixed';
    s.left = '10%';
    s.top = '25%';
    s.zIndex = '2147483000';
    s.minWidth = '240px';
    s.minHeight = '72px';
    s.padding = '0 28px';
    s.pointerEvents = 'auto';
    s.visibility = 'visible';
    s.opacity = '1';
    s.font = '800 22px/1.1 system-ui, sans-serif';
    s.color = '#ffd400';
    s.background = '#000';
    s.border = '4px solid #ffd400';
    s.borderRadius = '12px';
    s.cursor = 'pointer';
    return false;
  }

  function domReady() {
    const raw = document.getElementById('gtamap-raw-trigger');
    const data = {};
    if (raw) {
      data.rawCss = guard(ensureRawStyle)(raw) !== false;
      // Not setSnap({triggerVisible}): "EXTENSION LOADED" proves the iframe is
      // on screen, not that the map button is. Only the app measures that.
      data.trigger = measureTrigger(raw, 'raw');
    }
    send('html_loaded', data);
    setTimeout(guard(checkApp), APP_TIMEOUT_MS);
  }

  if (document.readyState === 'loading') {
    hook(document, 'DOMContentLoaded', domReady);
  } else {
    guard(domReady)();
  }
})();
