/**
 * Stand-in for Twitch's extension helper (twitch-ext.min.js), for the local
 * screenshot harness only. build.mjs swaps it in for the real helper tag in the
 * scratch build; it never goes near web/dist or the release zip.
 *
 * It implements exactly what web/public/gtamap-boot.js and
 * web/src/viewer/twitch.ts use: onAuthorized, onContext, onError,
 * onVisibilityChanged, onHighlightChanged (one listener each, like the real
 * helper), actions.requestIdShare, viewer and version.
 *
 * The extension JWT is signed here, with WebCrypto, using the TEST extension
 * secret of the compose `test` service (channel 900000001). Which viewer it
 * is comes from the page URL:
 *
 *   ?harnessViewer=linked    user 123, identity shared (default; has GTA$)
 *   ?harnessViewer=poor      user 456, identity shared, no GTA$
 *   ?harnessViewer=unlinked  logged in, identity not shared
 *   ?harnessViewer=anon      logged out
 */
(function () {
  'use strict';

  var SECRET_B64 = 'dGVzdC1leHRlbnNpb24tc2VjcmV0LTEyMzQ1';
  var CHANNEL_ID = '900000001';

  var VIEWERS = {
    linked: { opaque: 'U123', userId: '123' },
    poor: { opaque: 'U456', userId: '456' },
    unlinked: { opaque: 'UHARNESS789', userId: null },
    anon: { opaque: 'AHARNESS000', userId: null },
  };

  var params = new URLSearchParams(window.location.search);
  var who = VIEWERS[params.get('harnessViewer') || 'linked'] || VIEWERS.linked;
  var anchor = params.get('anchor') || 'video_overlay';

  var listeners = {};
  var fired = {};

  function slot(name) {
    return function (cb) {
      listeners[name] = typeof cb === 'function' ? cb : null;
      if (listeners[name] && fired[name]) listeners[name].apply(null, fired[name]);
    };
  }

  function fire(name, args) {
    fired[name] = args;
    var cb = listeners[name];
    if (cb) {
      try {
        cb.apply(null, args);
      } catch (e) {
        setTimeout(function () {
          throw e;
        });
      }
    }
  }

  function b64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function utf8(text) {
    return new TextEncoder().encode(text);
  }

  function signJwt(claims) {
    var raw = atob(SECRET_B64);
    var key = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) key[i] = raw.charCodeAt(i);
    var body = b64url(utf8(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))) + '.' + b64url(utf8(JSON.stringify(claims)));
    return crypto.subtle
      .importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      .then(function (k) {
        return crypto.subtle.sign('HMAC', k, utf8(body));
      })
      .then(function (sig) {
        return body + '.' + b64url(new Uint8Array(sig));
      });
  }

  var claims = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    channel_id: CHANNEL_ID,
    opaque_user_id: who.opaque,
    role: 'viewer',
    is_unlinked: !who.userId,
    pubsub_perms: { listen: ['broadcast'], send: [] },
  };
  if (who.userId) claims.user_id = who.userId;

  var context = {
    mode: 'viewer',
    theme: 'dark',
    language: 'ru',
    isFullScreen: false,
    isPaused: false,
    isMuted: false,
    isTheatreMode: false,
    playbackMode: 'video',
    arePlayerControlsVisible: false,
    bitrate: 6000,
    bufferSize: 1.5,
    displayResolution: window.innerWidth + 'x' + window.innerHeight,
    videoResolution: '1920x1080',
    hlsLatencyBroadcaster: 2,
  };

  window.Twitch = {
    ext: {
      version: '1.28.0-harness',
      environment: 'production',
      onAuthorized: slot('authorized'),
      onContext: slot('context'),
      onError: slot('error'),
      onVisibilityChanged: slot('visibility'),
      onHighlightChanged: slot('highlight'),
      actions: {
        requestIdShare: function () {
          console.info('[harness] requestIdShare()');
        },
        followChannel: function () {},
        onFollow: function () {},
      },
      viewer: {
        id: who.userId,
        opaqueId: who.opaque,
        isLinked: !!who.userId,
        role: 'viewer',
        sessionToken: null,
        subscriptionStatus: null,
      },
      rig: { log: function () {} },
    },
  };

  signJwt(claims).then(
    function (token) {
      fire('authorized', [
        {
          token: token,
          userId: who.opaque,
          channelId: CHANNEL_ID,
          clientId: 'harness-client-id',
          // Only the panel uses it, for Get Streams; the harness answers that
          // request itself (CDP Fetch), so nothing reaches Twitch.
          helixToken: 'harness-helix-token',
        },
      ]);
      fire('context', [context, Object.keys(context)]);
      fire('visibility', [true, context]);
      fire('highlight', [false]);
      console.info('[harness] fake Twitch helper authorised ' + (who.userId ? 'user ' + who.userId : who.opaque) + ' on ' + anchor);
    },
    function (err) {
      fire('error', [err]);
    },
  );
})();
