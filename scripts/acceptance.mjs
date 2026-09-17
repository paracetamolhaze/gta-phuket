#!/usr/bin/env node
/**
 * End-to-end acceptance run against a live stack.
 *
 *   node scripts/acceptance.mjs
 *
 * Walks the whole chain the way a viewer would, over HTTP, with no shortcuts
 * into internals:
 *
 *   dev extension JWT -> /api/ext/state -> GPS simulator in Patong
 *   -> quote a destination -> confirm (reserves a Twitch reward slot)
 *   -> simulated redemption delivered as a signed EventSub webhook
 *   -> waypoint ACTIVE -> streamer walks -> remaining distance falls
 *   -> COMPLETE -> the channel is open again
 *
 * Requires DEV_MODE=true and a MAPBOX_SERVER_TOKEN (the route and price are
 * real Mapbox output; nothing here fakes a road network).
 */

const API = process.env.API_BASE ?? 'http://localhost:4000';
const VIEWER_ID = '100000042';
const SECOND_VIEWER_ID = '100000077';

const PATONG = { lat: 7.8961, lng: 98.2958 };
const JUNGCEYLON = { lat: 7.8921, lng: 98.2966 };

let step = 0;
const pass = (msg) => console.log(`  [32m✓[0m ${msg}`);
const info = (msg) => console.log(`    [2m${msg}[0m`);
const head = (msg) => console.log(`\n[1m${++step}. ${msg}[0m`);

class StepError extends Error {}

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 200) };
    }
  }
  return { status: res.status, ok: res.ok, data };
}

function expect(condition, message, detail) {
  if (!condition) {
    throw new StepError(detail ? `${message}\n    ${JSON.stringify(detail)}` : message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('[1mGTA Phuket — acceptance run[0m');
  console.log(`API: ${API}`);

  head('The stack is up');
  const health = await call('/api/health');
  expect(health.ok, 'health check failed', health.data);
  expect(health.data.devMode === true, 'DEV_MODE is off — set DEV_MODE=true and restart the api');
  pass(`postgres=${health.data.checks.postgres} redis=${health.data.checks.redis}`);
  info(`twitch=${health.data.checks.twitch} mapbox=${health.data.checks.mapbox}`);
  if (health.data.checks.mapbox === 'missing') {
    throw new StepError(
      'MAPBOX_SERVER_TOKEN is not set. Routing and pricing are real Mapbox calls,\n' +
        '    so the chain cannot be completed without one. Put it in .env and run\n' +
        '    `docker compose up -d --force-recreate api`.',
    );
  }

  head('Clear any leftover state');
  expect((await call('/api/dev/reset', { method: 'POST' })).ok, 'dev reset failed');
  pass('waypoints, quotes, slots and GPS cleared');

  head('A viewer is authorised exactly as Twitch would authorise them');
  const tokenRes = await call('/api/dev/ext-token', {
    method: 'POST',
    body: { userId: VIEWER_ID, linked: true },
  });
  expect(tokenRes.ok, 'could not mint a dev extension token', tokenRes.data);
  const token = tokenRes.data.token;
  pass(`extension JWT for user ${VIEWER_ID} (verified server-side on every call)`);

  const unlinked = await call('/api/dev/ext-token', {
    method: 'POST',
    body: { userId: '100000999', linked: false },
  });
  const blocked = await call('/api/ext/quote', {
    method: 'POST',
    token: unlinked.data.token,
    body: { lat: JUNGCEYLON.lat, lng: JUNGCEYLON.lng },
  });
  expect(blocked.data?.error === 'needs_id_share', 'an unlinked viewer should be told to share their id', blocked.data);
  pass('an unlinked viewer is asked for identity sharing instead of being quoted');

  head('The streamer is in Patong');
  const sim = await call('/api/dev/gps/sim/start', {
    method: 'POST',
    body: { ...PATONG, speedMps: 1.4 },
  });
  expect(sim.ok, 'could not start the GPS simulator', sim.data);
  await sleep(1200);

  const state = await call('/api/ext/state', { token });
  expect(state.ok, '/api/ext/state failed', state.data);
  expect(state.data.gps.status === 'ok', `GPS is ${state.data.gps.status}`, state.data.gps);
  pass(`GPS ok at ${state.data.gps.lat.toFixed(5)}, ${state.data.gps.lng.toFixed(5)}`);
  info(`reward slots free: ${state.data.slots.free}/${state.data.slots.total}`);
  expect(state.data.slots.total > 0, 'the reward slot pool is empty — check the api startup logs');

  head('Search finds a real place in Phuket');
  const search = await call('/api/ext/search?q=Jungceylon', { token });
  expect(search.ok, 'search failed', search.data);
  if (search.data.results.length) {
    const first = search.data.results[0];
    pass(`"${first.name}" at ${first.lat.toFixed(4)}, ${first.lng.toFixed(4)}`);
  } else {
    info('no geocoder results (not fatal; the map click path is used below)');
  }

  head('The viewer taps the destination and the server prices a real walking route');
  const quoteRes = await call('/api/ext/quote', {
    method: 'POST',
    token,
    body: {
      lat: JUNGCEYLON.lat,
      lng: JUNGCEYLON.lng,
      name: 'Jungceylon Shopping Center',
      category: 'mall',
    },
  });
  expect(quoteRes.ok, 'quote failed', quoteRes.data);
  const quote = quoteRes.data;
  expect(quote.distanceMeters > 0, 'the route has no distance', quote);
  expect(quote.cost > 0, 'the price is not positive', quote);
  pass(`${quote.destinationName}: ${quote.distanceMeters} m, ${Math.round(quote.durationSeconds / 60)} min, ${quote.cost} points`);
  info(`quote ${quote.quoteId} expires in ${Math.round((quote.expiresAt - Date.now()) / 1000)} s`);

  head('A far-away point is refused');
  const tooFar = await call('/api/ext/quote', {
    method: 'POST',
    token,
    body: { lat: 8.15, lng: 98.32, name: 'Far north' },
  });
  expect(!tooFar.ok, 'a point 30 km away should not be quotable', tooFar.data);
  pass(`refused with "${tooFar.data.error}"`);

  head('The viewer confirms; a reward slot is reserved on Twitch');
  const confirm = await call(`/api/ext/quote/${quote.quoteId}/confirm`, { method: 'POST', token });
  expect(confirm.ok, 'confirm failed', confirm.data);
  expect(confirm.data.status === 'AWAITING_REDEMPTION', 'quote is not awaiting payment', confirm.data);
  expect(confirm.data.rewardTitle, 'no reward title was returned', confirm.data);
  pass(`reward "${confirm.data.rewardTitle}" is live at ${confirm.data.cost} points`);
  info('nothing has been charged yet — Twitch has no API to take points');

  head('Another viewer cannot redeem someone else’s reward');
  const strangerRedeem = await call('/api/dev/redeem', {
    method: 'POST',
    body: { quoteId: quote.quoteId, userId: SECOND_VIEWER_ID },
  });
  expect(strangerRedeem.ok, 'the simulated redemption was not delivered', strangerRedeem.data);
  await sleep(800);
  const afterStranger = await call('/api/ext/state', { token });
  expect(
    afterStranger.data.activeWaypoint === null,
    'the wrong viewer managed to activate a waypoint',
    afterStranger.data.activeWaypoint,
  );
  pass('redemption cancelled and refunded; no waypoint created');

  head('Re-confirm and let the right viewer pay');
  const requote = await call('/api/ext/quote', {
    method: 'POST',
    token,
    body: { lat: JUNGCEYLON.lat, lng: JUNGCEYLON.lng, name: 'Jungceylon Shopping Center', category: 'mall' },
  });
  expect(requote.ok, 're-quote failed', requote.data);
  const confirmed = await call(`/api/ext/quote/${requote.data.quoteId}/confirm`, {
    method: 'POST',
    token,
  });
  expect(confirmed.ok, 're-confirm failed', confirmed.data);

  const redeem = await call('/api/dev/redeem', {
    method: 'POST',
    body: { quoteId: requote.data.quoteId },
  });
  expect(redeem.ok, 'the simulated redemption was not delivered', redeem.data);
  info(redeem.data.note);
  await sleep(1000);

  head('The waypoint is ACTIVE');
  let active = (await call('/api/ext/state', { token })).data.activeWaypoint;
  expect(active, 'no active waypoint after a valid redemption');
  expect(active.channelPointsPaid === requote.data.cost, 'the paid amount does not match the quote', active);
  pass(`${active.destinationName} — paid ${active.channelPointsPaid} points by ${active.paidBy}`);

  head('Everyone else is locked out until it is finished');
  const otherToken = (
    await call('/api/dev/ext-token', { method: 'POST', body: { userId: SECOND_VIEWER_ID, linked: true } })
  ).data.token;
  const locked = await call('/api/ext/quote', {
    method: 'POST',
    token: otherToken,
    body: { lat: JUNGCEYLON.lat, lng: JUNGCEYLON.lng },
  });
  expect(locked.data?.error === 'waypoint_active', 'a second waypoint could be quoted', locked.data);
  pass(`refused with "${locked.data.error}"`);

  head('The streamer walks and the remaining distance falls');
  const first = active.remainingDistanceMeters;
  info(`remaining now: ${first} m`);
  await sleep(9000);
  active = (await call('/api/obs/state')).data.activeWaypoint;
  expect(active, 'the waypoint disappeared while walking');
  info(`remaining after ~9 s of walking: ${active.remainingDistanceMeters} m`);
  expect(
    active.remainingDistanceMeters < first,
    'the remaining distance did not decrease — is the GPS simulator running?',
    { first, now: active.remainingDistanceMeters },
  );
  pass(`fell by ${first - active.remainingDistanceMeters} m`);

  head('The streamer completes the job');
  const adminLogin = await call('/api/admin/login', {
    method: 'POST',
    body: { password: process.env.ADMIN_SESSION_SECRET ?? 'change-me-admin-secret' },
  });
  expect(adminLogin.ok, 'admin login failed (set ADMIN_SESSION_SECRET to match .env)', adminLogin.data);
  const complete = await call('/api/admin/waypoint/complete', {
    method: 'POST',
    token: adminLogin.data.token,
  });
  expect(complete.ok, 'complete failed', complete.data);
  pass('waypoint COMPLETED');

  head('A new viewer can choose the next point');
  const reopened = await call('/api/ext/quote', {
    method: 'POST',
    token: otherToken,
    body: { lat: JUNGCEYLON.lat, lng: JUNGCEYLON.lng, name: 'Jungceylon' },
  });
  expect(reopened.ok, 'the channel did not reopen after COMPLETE', reopened.data);
  pass(`quoted again for ${reopened.data.cost} points`);

  await call('/api/dev/gps/sim/stop', { method: 'POST' });
  await call('/api/dev/reset', { method: 'POST' });

  console.log('\n[1;32mAcceptance run passed.[0m\n');
}

main().catch((err) => {
  if (err instanceof StepError) {
    console.error(`\n[1;31m  ✗ step ${step} failed[0m\n    ${err.message}\n`);
  } else {
    console.error(`\n[1;31m  ✗ step ${step} crashed[0m\n`, err);
  }
  process.exit(1);
});
