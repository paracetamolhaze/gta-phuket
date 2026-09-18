/**
 * The demo API the screenshot harness talks to — isolated from the live stack.
 *
 *   node tools/ui-shots/api.mjs start     create gta_phuket_ui if missing, start gta-ui-api
 *   node tools/ui-shots/api.mjs seed      exchange reward, viewer 123 at exactly GTA$ 5 000
 *   node tools/ui-shots/api.mjs stop      stop gta-ui-api (it was started with --rm)
 *   node tools/ui-shots/api.mjs status
 *
 * What it touches, and nothing else:
 *   - database gta_phuket_ui on the running postgres (CREATE DATABASE once)
 *   - Redis db 2
 *   - one one-off container, gta-ui-api, from the compose `test` service: that
 *     service blanks every Twitch credential (local Helix stub), uses channel
 *     900000001 and test-only secrets. `--no-deps` so compose never starts,
 *     restarts or recreates postgres / redis. Published on 127.0.0.1:4100 only.
 *
 * It never reads .env (compose passes it to the container itself), never
 * touches gta_phuket, never stops or restarts any other container, and never
 * calls Twitch.
 */
import { spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const API_BASE = 'http://127.0.0.1:4100';
export const CHANNEL_ID = '900000001';
/** Same values as the compose `test` service; test-only, never live. */
export const EXT_SECRET_B64 = 'dGVzdC1leHRlbnNpb24tc2VjcmV0LTEyMzQ1';
const EVENTSUB_SECRET = 'test-eventsub-secret-0123456789';
const ADMIN_SECRET = 'ui-harness-admin-secret-0123';

const CONTAINER = 'gta-ui-api';
const PG_CONTAINER = 'gta-phuket-postgres-1';
const DB_NAME = 'gta_phuket_ui';

/** Viewer 123 has this much GTA$ at the start of every run. */
export const RICH_VIEWER = '123';
export const RICH_BALANCE = 5000;
/** Viewer 456 has none. */
export const POOR_VIEWER = '456';

const EXCHANGE_REDEMPTION = 'channel.channel_points_custom_reward_redemption.add';

function log(line) {
  console.log(`[ui-api] ${line}`);
}

function docker(args, { allowFail = false } = {}) {
  const res = spawnSync('docker', args, { cwd: REPO, encoding: 'utf8', windowsHide: true });
  if (res.error) throw res.error;
  if (res.status !== 0 && !allowFail) {
    throw new Error(`docker ${args.slice(0, 3).join(' ')} … failed (${res.status}): ${(res.stderr || res.stdout).trim()}`);
  }
  return { code: res.status, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Database + container
// ---------------------------------------------------------------------------

export function ensureDatabase() {
  const psql = (sql) => docker(['exec', PG_CONTAINER, 'psql', '-U', 'gta', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
  const exists = psql(`SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'`).out === '1';
  if (exists) return false;
  psql(`CREATE DATABASE ${DB_NAME}`);
  log(`created database ${DB_NAME}`);
  return true;
}

export function isRunning() {
  const { out } = docker(['ps', '--filter', `name=^/${CONTAINER}$`, '--format', '{{.Names}}']);
  return out.split(/\r?\n/).includes(CONTAINER);
}

async function healthy() {
  try {
    const res = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Starts gta-ui-api unless it is already up. Returns true when this call started it. */
export async function ensureRunning() {
  ensureDatabase();
  if (isRunning()) {
    if (!(await waitHealthy(30_000))) throw new Error(`${CONTAINER} is running but not healthy`);
    return false;
  }
  // A stopped leftover of the same name would block `--name`.
  docker(['rm', '-f', CONTAINER], { allowFail: true });
  log(`starting ${CONTAINER} on ${API_BASE}`);
  docker([
    'compose', '--profile', 'test', 'run', '-d', '--rm', '--no-deps',
    '--name', CONTAINER,
    '-p', '127.0.0.1:4100:4000',
    '-e', `DATABASE_URL=postgres://gta:gta@postgres:5432/${DB_NAME}`,
    '-e', 'REDIS_URL=redis://redis:6379/2',
    '-e', 'REVIEW_DEMO_MODE=true',
    '-e', `ADMIN_SESSION_SECRET=${ADMIN_SECRET}`,
    '-e', 'STREAMER_DEVICE_SECRET=ui-harness-pair',
    '-e', `PUBLIC_WEB_URL=${API_BASE}`,
    // Optional: try another Mapbox style without touching .env (UI_MAP_STYLE=mapbox://styles/...).
    ...(process.env.UI_MAP_STYLE ? ['-e', `MAPBOX_STYLE_URL=${process.env.UI_MAP_STYLE}`] : []),
    'test', 'sh', '-c', 'npm run migrate -w server && npx tsx server/src/index.ts',
  ]);
  if (!(await waitHealthy(120_000))) {
    const logs = docker(['logs', '--tail', '40', CONTAINER], { allowFail: true });
    throw new Error(`${CONTAINER} did not become healthy:\n${logs.out}\n${logs.err}`);
  }
  log(`${CONTAINER} is up`);
  return true;
}

async function waitHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthy()) return true;
    if (!isRunning()) return false;
    await sleep(1000);
  }
  return false;
}

export function stop() {
  if (!isRunning()) return false;
  docker(['stop', '-t', '10', CONTAINER]);
  log(`stopped ${CONTAINER}`);
  return true;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** An extension JWT exactly like the ones Twitch signs, with the test secret. */
export function extJwt({ userId = null, opaque = null, role = 'viewer' } = {}) {
  const claims = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    channel_id: CHANNEL_ID,
    opaque_user_id: opaque ?? (userId ? `U${userId}` : 'AHARNESS000'),
    role,
    is_unlinked: !userId,
    pubsub_perms: { listen: ['broadcast'], send: [] },
  };
  if (userId) claims.user_id = userId;
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const body = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(claims)}`;
  const sig = createHmac('sha256', Buffer.from(EXT_SECRET_B64, 'base64')).update(body).digest('base64url');
  return `${body}.${sig}`;
}

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

let adminToken = null;

async function admin(method, path, body) {
  if (!adminToken) {
    const res = await call('POST', '/api/admin/login', { body: { password: ADMIN_SECRET } });
    if (res.status !== 200 || !res.json?.token) throw new Error(`admin login failed: ${res.status} ${res.text}`);
    adminToken = res.json.token;
  }
  return call(method, path, { token: adminToken, body });
}

export async function walletOf(userId) {
  const res = await call('GET', '/api/ext/wallet', { token: extJwt({ userId }) });
  if (res.status !== 200) throw new Error(`wallet ${userId}: ${res.status} ${res.text}`);
  return res.json;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/** POST a signed EventSub notification, exactly as server/test/gta-dollar.test.ts does. */
async function deliverRedemption({ userId, cost, rewardId, rewardTitle }) {
  const messageId = randomUUID();
  const timestamp = new Date().toISOString();
  const event = {
    id: randomUUID(),
    broadcaster_user_id: CHANNEL_ID,
    broadcaster_user_login: 'channel',
    broadcaster_user_name: 'Channel',
    user_id: userId,
    user_login: `viewer${userId}`,
    user_name: `Viewer ${userId}`,
    user_input: '',
    status: 'unfulfilled',
    redeemed_at: timestamp,
    reward: { id: rewardId, title: rewardTitle, cost, prompt: '' },
  };
  const body = JSON.stringify({
    subscription: {
      id: randomUUID(),
      type: EXCHANGE_REDEMPTION,
      version: '1',
      status: 'enabled',
      cost: 0,
      condition: { broadcaster_user_id: CHANNEL_ID },
      transport: { method: 'webhook', callback: 'https://localhost:8080/api/eventsub/twitch' },
      created_at: timestamp,
    },
    event,
  });
  const hmac = createHmac('sha256', EVENTSUB_SECRET);
  hmac.update(messageId);
  hmac.update(timestamp);
  hmac.update(body);
  const res = await fetch(`${API_BASE}/api/eventsub/twitch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'twitch-eventsub-message-id': messageId,
      'twitch-eventsub-message-type': 'notification',
      'twitch-eventsub-message-timestamp': timestamp,
      'twitch-eventsub-message-signature': `sha256=${hmac.digest('hex')}`,
      'twitch-eventsub-subscription-type': EXCHANGE_REDEMPTION,
    },
    body,
  });
  if (res.status !== 204) throw new Error(`EventSub delivery refused: ${res.status} ${await res.text()}`);
}

/**
 * Keeps the streamer's GPS fresh while shooting. The OBS HUD greys out and says
 * "НЕТ GPS" when no fix has arrived for gpsTimeoutSeconds, which is what it
 * should do live — but on stream the phone pushes a fix every few seconds, so
 * a quiet minimap would be the wrong backdrop. Posts the review demo position
 * (the one every quote uses) to the harness API's dev GPS endpoint; the demo
 * mode broadcasts it as a normal gps:update. Returns a stop function.
 */
export async function startGpsHeartbeat(everyMs = 4000) {
  const state = await call('GET', '/api/ext/state', { token: extJwt({ userId: RICH_VIEWER }) });
  const lat = state.json?.gps?.lat;
  const lng = state.json?.gps?.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number') throw new Error(`no demo GPS position: ${state.status} ${state.text}`);
  const beat = () =>
    call('POST', '/api/dev/gps', { body: { lat, lng, accuracy: 6, heading: 20, speed: 1.1, timestamp: Date.now() } }).then(
      (res) => {
        if (res.status !== 200) log(`gps heartbeat refused: ${res.status} ${res.text.slice(0, 120)}`);
      },
      () => undefined,
    );
  await beat();
  const timer = setInterval(beat, everyMs);
  return () => clearInterval(timer);
}

/** Drop any running job (GTA$ refunded) and any pending quote. */
export async function clearWaypoint() {
  const res = await admin('POST', '/api/admin/waypoint/clear', {});
  if (res.status !== 200) throw new Error(`waypoint clear: ${res.status} ${res.text}`);
  return res.json;
}

/**
 * Same starting point every run: waypoints open, no job running, the exchange
 * reward synced, viewer 123 at exactly GTA$ 5 000 and viewer 456 at zero.
 */
export async function seed() {
  await clearWaypoint();
  const open = await admin('POST', '/api/admin/waypoints/open', {});
  if (open.status !== 200) throw new Error(`waypoints open: ${open.status} ${open.text}`);

  const sync = await admin('POST', '/api/admin/economy/exchange-reward/sync', {});
  if (sync.status !== 200 || !sync.json?.reward?.id) throw new Error(`exchange reward sync: ${sync.status} ${sync.text}`);
  const reward = sync.json.reward;

  let rich = await walletOf(RICH_VIEWER);
  if (rich.balance < RICH_BALANCE) {
    // The only way GTA$ reach a wallet in the product: redeeming the exchange reward.
    const before = rich.balance;
    await deliverRedemption({ userId: RICH_VIEWER, cost: reward.cost, rewardId: reward.id, rewardTitle: reward.title });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await sleep(250);
      rich = await walletOf(RICH_VIEWER);
      if (rich.balance !== before) break;
    }
    if (rich.balance === before) throw new Error('the exchange redemption was not credited');
    log(`credited viewer ${RICH_VIEWER}: ${before} -> ${rich.balance} GTA$ (${reward.cost} ETH redemption)`);
  }
  if (rich.balance !== RICH_BALANCE) {
    const amount = RICH_BALANCE - rich.balance;
    const adj = await admin('POST', '/api/admin/economy/adjust', {
      twitchUserId: RICH_VIEWER,
      amount,
      reason: 'ui-shots harness: reset to the starting balance',
    });
    if (adj.status !== 200) throw new Error(`adjust ${RICH_VIEWER}: ${adj.status} ${adj.text}`);
  }

  const poor = await walletOf(POOR_VIEWER);
  if (poor.balance !== 0) {
    const adj = await admin('POST', '/api/admin/economy/adjust', {
      twitchUserId: POOR_VIEWER,
      amount: -poor.balance,
      reason: 'ui-shots harness: reset to zero',
    });
    if (adj.status !== 200) throw new Error(`adjust ${POOR_VIEWER}: ${adj.status} ${adj.text}`);
  }

  const final = await walletOf(RICH_VIEWER);
  log(`seeded: viewer ${RICH_VIEWER} = ${final.balance} GTA$, viewer ${POOR_VIEWER} = 0 GTA$, reward "${reward.title}" ${reward.cost} ETH`);
  return { reward, balance: final.balance };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] ?? 'status';
  try {
    if (cmd === 'start') await ensureRunning();
    else if (cmd === 'seed') {
      await ensureRunning();
      await seed();
    } else if (cmd === 'stop') stop();
    else if (cmd === 'status') log(isRunning() ? `${CONTAINER} running (${(await healthy()) ? 'healthy' : 'not healthy'})` : `${CONTAINER} not running`);
    else throw new Error(`unknown command "${cmd}" (start | seed | stop | status)`);
  } catch (err) {
    console.error(`[ui-api] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
