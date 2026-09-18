#!/usr/bin/env node
/**
 * Real-state screenshots of the IRL Waypoint extension (dev-only harness).
 *
 *   node tools/ui-shots/shoot.mjs --out before
 *   node tools/ui-shots/shoot.mjs --out after --no-build --only overlay,panel
 *   node tools/ui-shots/shoot.mjs --out after-day --bg day --only overlay
 *
 *   --out <name>    folder under tools/ui-shots/out/ (default "latest")
 *   --no-build      reuse tools/ui-shots/out/build if it exists
 *   --only <list>   overlay,poor,mobile,panel (default: all four)
 *   --keep-api      leave gta-ui-api running afterwards (default: stop it)
 *   --search <q>    what to search for (default "Jungceylon"; first result is picked)
 *   --bg night|day  backdrop behind the minimap (default night)
 *
 * One command does everything, in this order:
 *
 *   1. api.mjs    create gta_phuket_ui if missing, start the isolated demo API
 *                 gta-ui-api on 127.0.0.1:4100 when it is not running, seed it
 *                 (viewer 123 at GTA$ 5 000, viewer 456 at 0, no job running)
 *   2. build.mjs  vite build into tools/ui-shots/out/build with the fake
 *                 Twitch helper swapped in (skipped with --no-build when a
 *                 build is already there)
 *   3. this file  a static server for that build on 127.0.0.1, a headless
 *                 Chrome with a fresh profile, driven over CDP through the real
 *                 UI; PNGs + shots.json land in tools/ui-shots/out/<out>/
 *   4. clean up   Chrome closed, profile deleted, the job cleared, gta-ui-api
 *                 stopped (unless --keep-api)
 *
 * Groups (--only): overlay (viewer 123 on the player page: collapsed at
 * 1280x720 and 1920x1080 over the real OBS minimap, map open, quote card,
 * top-up dialog, purchase, collapsed with the task pill), poor (viewer 456:
 * insufficient funds), mobile (375x812), panel (318x496, offline).
 *
 * Nothing reaches Twitch: Chrome resolves *.twitch.tv to nothing, the helper
 * is a local fake, and the panel's Get Streams call is answered here through
 * CDP Fetch with {"data":[]}.
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as api from './api.mjs';
import { BUILD_DIR, build } from './build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/** Map tiles and fly-to animations get this long before a shot. */
const TILE_WAIT_MS = 6000;
const SETTLE_MS = 3500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GROUPS = ['overlay', 'poor', 'mobile', 'panel'];

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { out: 'latest', build: true, keepApi: false, only: null, search: 'Jungceylon', bg: 'night' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--no-build') opts.build = false;
    else if (a === '--keep-api') opts.keepApi = true;
    else if (a === '--only') opts.only = new Set(argv[++i].split(','));
    else if (a === '--search') opts.search = argv[++i];
    else if (a === '--bg') opts.bg = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!['night', 'day'].includes(opts.bg)) throw new Error(`--bg must be night or day, got "${opts.bg}"`);
  if (!/^[\w.-]+$/.test(opts.out)) throw new Error(`--out must be a plain folder name, got "${opts.out}"`);
  for (const g of opts.only ?? []) {
    if (!GROUPS.includes(g)) throw new Error(`--only: unknown group "${g}" (${GROUPS.join(', ')})`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// static server for the scratch build
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function serve(root) {
  const base = resolve(root);
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = normalize(join(base, path === '/' ? 'harness-player.html' : path));
    if (!file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => resolveServer({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

// ---------------------------------------------------------------------------
// Chrome + CDP
// ---------------------------------------------------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (event) => this.receive(JSON.parse(String(event.data))));
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId, timeoutMs = 60_000) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`${method}: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolveSend(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          rejectSend(e);
        },
        method,
      });
      this.ws.send(JSON.stringify(msg));
    });
  }

  receive(msg) {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    for (const fn of this.listeners) fn(msg);
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

async function launchChrome() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME_PATH)`);
  const profile = mkdtempSync(join(tmpdir(), 'ui-shots-chrome-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--no-pings',
    '--mute-audio',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
    // Belt and braces: nothing in this harness may reach Twitch.
    '--host-resolver-rules=MAP *.twitch.tv ~NOTFOUND, MAP twitch.tv ~NOTFOUND',
    '--window-size=1280,720',
    'about:blank',
  ];
  const proc = spawn(CHROME, args, { stdio: 'ignore', windowsHide: true });
  const portFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 20_000;
  while (!existsSync(portFile) || readFileSync(portFile, 'utf8').split('\n').length < 2) {
    if (Date.now() > deadline) throw new Error('Chrome did not open its DevTools port');
    if (proc.exitCode !== null) throw new Error(`Chrome exited (${proc.exitCode})`);
    await sleep(100);
  }
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const cdp = await Cdp.connect(`ws://127.0.0.1:${port.trim()}${path.trim()}`);
  const close = async () => {
    try {
      await cdp.send('Browser.close', {}, undefined, 5000);
    } catch {
      /* already gone */
    }
    const until = Date.now() + 8000;
    while (proc.exitCode === null && Date.now() < until) await sleep(100);
    if (proc.exitCode === null) proc.kill();
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await sleep(300);
      }
    }
  };
  return { cdp, close };
}

/** One tab, driven through a flattened CDP session. */
class Page {
  constructor(cdp, targetId, sessionId, name) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.name = name;
    this.errors = [];
    this.helixAnswers = 0;
    this.blocked = [];
    this.off = cdp.on((msg) => this.event(msg));
  }

  static async open(cdp, name, { width, height, dpr = 1, mobile = false }) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(cdp, targetId, sessionId, name);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    // Every *.twitch.tv request stops here: Get Streams is answered, the rest refused.
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*://*.twitch.tv/*', requestStage: 'Request' }] });
    await page.size({ width, height, dpr, mobile });
    return page;
  }

  send(method, params = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }

  event(msg) {
    if (msg.sessionId !== this.sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      this.errors.push(`exception: ${d.exception?.description ?? d.text}`.slice(0, 300));
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      this.errors.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 300));
    } else if (msg.method === 'Fetch.requestPaused') {
      void this.answerTwitch(msg.params);
    }
  }

  async answerTwitch({ requestId, request }) {
    const cors = [
      { name: 'Access-Control-Allow-Origin', value: '*' },
      { name: 'Access-Control-Allow-Headers', value: 'Client-Id, Authorization' },
      { name: 'Access-Control-Allow-Methods', value: 'GET, OPTIONS' },
    ];
    try {
      if (/^https:\/\/api\.twitch\.tv\/helix\/streams(\?|$)/.test(request.url)) {
        if (request.method === 'OPTIONS') {
          await this.send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: cors });
        } else {
          this.helixAnswers += 1;
          await this.send('Fetch.fulfillRequest', {
            requestId,
            responseCode: 200,
            responseHeaders: [...cors, { name: 'Content-Type', value: 'application/json' }],
            body: Buffer.from('{"data":[]}').toString('base64'),
          });
        }
      } else {
        this.blocked.push(request.url.replace(/[?#].*$/, ''));
        await this.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      }
    } catch {
      /* the page went away */
    }
  }

  async size({ width, height, dpr = 1, mobile = false }) {
    this.viewport = { width, height, dpr, mobile };
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
  }

  async goto(url) {
    const loaded = new Promise((res) => {
      const off = this.cdp.on((msg) => {
        if (msg.sessionId === this.sessionId && msg.method === 'Page.loadEventFired') {
          off();
          res();
        }
      });
    });
    await this.send('Page.navigate', { url });
    await Promise.race([loaded, sleep(30_000)]);
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(`${this.name}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result.value;
  }

  async waitFor(expression, what, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const v = await this.eval(`(() => { try { return ${expression}; } catch (e) { return false; } })()`);
        if (v) return v;
      } catch {
        /* navigation in progress */
      }
      if (Date.now() > deadline) throw new Error(`${this.name}: timed out waiting for ${what}`);
      await sleep(250);
    }
  }

  async shot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(data, 'base64'));
  }

  async close() {
    this.off();
    try {
      await this.cdp.send('Target.closeTarget', { targetId: this.targetId });
    } catch {
      /* gone */
    }
  }
}

// ---------------------------------------------------------------------------
// In-page helpers (evaluated in the tab; DOC is the extension document)
// ---------------------------------------------------------------------------

/** The overlay document inside the player page, or the page itself. */
const DOC = "(document.getElementById('ext') ? document.getElementById('ext').contentDocument : document)";

const q = (sel) => `${DOC}.querySelector(${JSON.stringify(sel)})`;
const click = (sel) => `(() => { const el = ${q(sel)}; if (!el) throw new Error('missing ${sel.replace(/'/g, '')}'); el.click(); return true; })()`;

/** Types into the React-controlled search box the way a keyboard would. */
function typeSearch(text) {
  return `(() => {
    const d = ${DOC};
    const input = d.querySelector('.searchInput');
    if (!input || input.disabled) return false;
    const w = d.defaultView;
    input.focus();
    Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    return true;
  })()`;
}

/** Boxes in viewport px: what the redesign has to line up. */
const GEOMETRY = `(() => {
  const box = (el) => {
    if (!el) return null;
    // Mounted but faded out (the closed map stays in the DOM) is not on screen.
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true })) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const obs = document.getElementById('obs') ? document.getElementById('obs').contentDocument : null;
  const d = ${DOC};
  return {
    viewport: { w: innerWidth, h: innerHeight },
    minimap: box(obs && obs.querySelector('.obs-minimap')),
    trigger: box(d.querySelector('.mapTrigger')),
    taskPill: box(d.querySelector('.taskPill')),
    mobileBar: box(d.querySelector('.mobileBar')),
    topBar: box(d.querySelector('.topBar')),
    card: box(d.querySelector('.sheet > *')),
    topUp: box(d.querySelector('.topUp')),
  };
})()`;

/** Scroll overflow of the extension document and of anything scrollable in it. */
const OVERFLOW = `(() => {
  const d = ${DOC};
  const w = d.defaultView;
  const root = d.scrollingElement || d.documentElement;
  const out = { docScrollW: root.scrollWidth, docScrollH: root.scrollHeight, innerW: w.innerWidth, innerH: w.innerHeight, scrollers: [] };
  for (const el of d.querySelectorAll('body *')) {
    const s = w.getComputedStyle(el);
    const y = /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
    const x = /(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1;
    if (x || y) out.scrollers.push({ el: el.className && String(el.className).slice(0, 60), x, y, scrollH: el.scrollHeight, clientH: el.clientHeight, scrollW: el.scrollWidth, clientW: el.clientWidth });
  }
  out.horizontalScroll = root.scrollWidth > w.innerWidth + 1;
  out.verticalScroll = root.scrollHeight > w.innerHeight + 1;
  return out;
})()`;

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

/**
 * How the collapsed button and the task pill sit relative to the OBS minimap:
 * the numbers the redesign is judged by (px, viewport coordinates).
 */
function relation(g) {
  if (!g || !g.minimap) return null;
  const mm = g.minimap;
  const rel = (el) =>
    el && {
      leftDelta: el.x - mm.x,
      rightDelta: el.x + el.w - (mm.x + mm.w),
      widthRatio: Math.round((el.w / mm.w) * 100) / 100,
      gapAboveMinimap: mm.y - (el.y + el.h),
      overlapsMinimap: el.y + el.h > mm.y && el.y < mm.y + mm.h && el.x < mm.x + mm.w && el.x + el.w > mm.x,
    };
  return { minimapTopPct: Math.round((mm.y / g.viewport.h) * 1000) / 10, trigger: rel(g.trigger), taskPill: rel(g.taskPill) };
}

function makeRecorder(outDir) {
  const shots = [];
  const record = async (page, file, state, extra = {}) => {
    await page.shot(join(outDir, file));
    const geometry = await page.eval(GEOMETRY).catch(() => null);
    shots.push({ file, state, viewport: page.viewport, geometry, relation: relation(geometry), ...extra });
    console.log(`[ui-shots] ${file}  ${state}`);
  };
  return { shots, record };
}

async function openMap(page) {
  await page.waitFor(`!!${q('.mapTrigger')} || !!${q('.mobileBtn')}`, 'the map button');
  await page.eval(`(() => { const el = ${q('.mapTrigger')} || ${q('.mobileBtn')}; el.click(); return true; })()`);
  await page.waitFor(`!!${q('.overlay.is-open .mapboxgl-canvas')}`, 'the opened map');
}

async function searchAndPick(page, text, cardSelector) {
  await page.waitFor(typeSearch(text), 'an enabled search box');
  await page.waitFor(`!!${q('.searchRow')}`, `search results for "${text}"`, 20_000);
  await page.eval(click('.searchRow'));
  await page.waitFor(`!!${q(cardSelector)}`, `the card ${cardSelector}`, 25_000);
}

async function overlayGroup(ctx) {
  const { cdp, origin, record, search } = ctx;
  const page = await Page.open(cdp, 'overlay', { width: 1280, height: 720 });
  try {
    await page.goto(`${origin}/harness-player.html?harnessViewer=linked&bg=${ctx.bg}`);
    await page.waitFor(`!!${q('.mapTrigger')}`, 'the collapsed map button');
    await page.waitFor(`!!document.getElementById('obs').contentDocument.querySelector('.obs-minimap .mapboxgl-canvas')`, 'the OBS minimap');
    await sleep(TILE_WAIT_MS);
    await record(page, '01-overlay-collapsed-1280x720.png', 'overlay collapsed over the OBS minimap, no job (viewer 123)');

    await page.size({ width: 1920, height: 1080 });
    await sleep(SETTLE_MS);
    await record(page, '02-overlay-collapsed-1920x1080.png', 'overlay collapsed over the OBS minimap, no job (viewer 123)');

    await page.size({ width: 1280, height: 720 });
    await sleep(1000);
    await openMap(page);
    await page.waitFor(`/\\d/.test((${q('.walletBalance')} || {}).textContent || '')`, 'the GTA$ balance');
    await sleep(TILE_WAIT_MS);
    await record(page, '03-map-open-idle-1280x720.png', 'map open, idle, wallet chip GTA$ 5 000');

    await page.size({ width: 1920, height: 1080 });
    await sleep(TILE_WAIT_MS);
    await record(page, '04-map-open-idle-1920x1080.png', 'map open, idle, wallet chip GTA$ 5 000');
    await page.size({ width: 1280, height: 720 });
    await sleep(SETTLE_MS);

    await searchAndPick(page, search, '.card--quote .gtaPriceValue');
    await page.waitFor(`!!${q('.gtaBuy:not([disabled])')}`, 'an enabled buy button');
    await sleep(SETTLE_MS);
    await record(page, '05-quote-card-1280x720.png', `quote card for the first "${search}" result, route on the map`);

    await page.eval(click('.walletChip .walletBtn--accent'));
    await page.waitFor(`!!${q('.topUp')}`, 'the top-up dialog');
    await sleep(800);
    await record(page, '06-topup-dialog-1280x720.png', 'top-up dialog open over the map');
    await page.eval(click('.topUpClose'));
    await page.waitFor(`!${q('.topUp')}`, 'the top-up dialog to close');

    await page.waitFor(`!!${q('.gtaBuy:not([disabled])')}`, 'an enabled buy button');
    await page.eval(click('.gtaBuy'));
    await page.waitFor(`!!${q('.card--ok')}`, 'the purchase result', 25_000);
    await sleep(SETTLE_MS);
    await record(page, '07-purchase-success-1280x720.png', 'after ОТПРАВИТЬ СТРИМЕРА: point accepted, balance left');

    await page.eval(click('.topBarClose'));
    await page.waitFor(`!!${q('.taskPill')}`, 'the task pill');
    await sleep(SETTLE_MS);
    await record(page, '08-overlay-task-collapsed-1280x720.png', 'overlay collapsed with the "Задание" pill, OBS minimap showing the route');
    await page.size({ width: 1920, height: 1080 });
    await sleep(SETTLE_MS);
    await record(page, '09-overlay-task-collapsed-1920x1080.png', 'overlay collapsed with the "Задание" pill, OBS minimap showing the route');
  } finally {
    ctx.pages.push(summary(page));
    await page.close();
  }
}

async function poorGroup(ctx) {
  const { cdp, origin, record, search } = ctx;
  const page = await Page.open(cdp, 'poor', { width: 1280, height: 720 });
  try {
    await page.goto(`${origin}/harness-player.html?harnessViewer=poor&bg=${ctx.bg}`);
    await openMap(page);
    await page.waitFor(`/\\d/.test((${q('.walletBalance')} || {}).textContent || '')`, 'the GTA$ balance');
    await sleep(TILE_WAIT_MS);
    await searchAndPick(page, search, '.card--quote .cardAlert');
    await sleep(SETTLE_MS);
    await record(page, '10-insufficient-funds-1280x720.png', `viewer 456 (GTA$ 0): quote for "${search}" with the shortfall and top-up`);
  } finally {
    ctx.pages.push(summary(page));
    await page.close();
  }
}

async function mobileGroup(ctx) {
  const { cdp, origin, record, search } = ctx;
  const page = await Page.open(cdp, 'mobile', { width: 375, height: 812, dpr: 2, mobile: true });
  try {
    await page.goto(`${origin}/mobile.html?anchor=component&language=ru&mode=viewer&platform=mobile&harnessViewer=linked`);
    await page.waitFor(`!!${q('.mobileBar')}`, 'the mobile bar');
    await sleep(1500);
    await record(page, '11-mobile-collapsed-375x812.png', 'mobile, collapsed bar', { overflow: await page.eval(OVERFLOW) });
    await openMap(page);
    await page.waitFor(`/\\d/.test((${q('.walletBalance')} || {}).textContent || '')`, 'the GTA$ balance');
    await sleep(TILE_WAIT_MS);
    await record(page, '12-mobile-map-375x812.png', 'mobile, map open, idle', { overflow: await page.eval(OVERFLOW) });
    await searchAndPick(page, search, '.card--quote .gtaPriceValue');
    await sleep(SETTLE_MS);
    await record(page, '13-mobile-quote-375x812.png', `mobile, quote card for "${search}"`, { overflow: await page.eval(OVERFLOW) });
  } finally {
    ctx.pages.push(summary(page));
    await page.close();
  }
}

async function panelGroup(ctx) {
  const { cdp, origin, record, search } = ctx;
  const page = await Page.open(cdp, 'panel', { width: 318, height: 496, dpr: 2 });
  try {
    await page.goto(`${origin}/panel.html?anchor=panel&language=ru&mode=viewer&platform=web&harnessViewer=linked`);
    await page.waitFor(`!!${q('.pnLive.is-offline')}`, 'the panel to read the channel as offline');
    await page.waitFor(`!!${q('.pnMap .mapboxgl-canvas')}`, 'the panel map');
    await page.waitFor(`/\\d/.test((${q('.walletBalance')} || {}).textContent || '')`, 'the GTA$ balance');
    await sleep(TILE_WAIT_MS);
    await record(page, '14-panel-offline-idle-318x496.png', 'panel, channel offline, idle', { overflow: await page.eval(OVERFLOW) });
    await searchAndPick(page, search, '.pnQuote');
    await sleep(SETTLE_MS);
    await record(page, '15-panel-offline-quote-318x496.png', `panel, channel offline, quote for "${search}"`, { overflow: await page.eval(OVERFLOW) });
  } finally {
    ctx.pages.push(summary(page));
    await page.close();
  }
}

function summary(page) {
  return { page: page.name, errors: page.errors, helixAnswers: page.helixAnswers, blockedTwitch: page.blocked };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = join(HERE, 'out', opts.out);
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) if (f.endsWith('.png') || f === 'shots.json') rmSync(join(outDir, f));

  const want = (group) => !opts.only || opts.only.has(group);
  const started = Date.now();
  let chrome = null;
  let server = null;
  let stopGps = null;
  const failures = [];

  try {
    await api.ensureRunning();
    await api.seed();
    stopGps = await api.startGpsHeartbeat();

    if (opts.build || !existsSync(join(BUILD_DIR, 'video_overlay.html'))) build();
    const served = await serve(BUILD_DIR);
    server = served.server;
    console.log(`[ui-shots] serving the scratch build on ${served.origin}`);

    chrome = await launchChrome();
    const { shots, record } = makeRecorder(outDir);
    const ctx = { cdp: chrome.cdp, origin: served.origin, record, search: opts.search, bg: opts.bg, pages: [] };

    const groups = [
      ['overlay', overlayGroup],
      ['poor', poorGroup],
      ['mobile', mobileGroup],
      ['panel', panelGroup],
    ];
    for (const [name, run] of groups) {
      if (!want(name)) continue;
      // Every group starts from the seeded state: no job running, no quote held.
      await api.clearWaypoint();
      try {
        await run(ctx);
      } catch (err) {
        failures.push(`${name}: ${err instanceof Error ? err.message : err}`);
        console.error(`[ui-shots] ${name} FAILED: ${err instanceof Error ? err.message : err}`);
      }
    }

    writeFileSync(
      join(outDir, 'shots.json'),
      JSON.stringify({ takenAt: new Date().toISOString(), search: opts.search, bg: opts.bg, shots, pages: ctx.pages, failures }, null, 2),
    );
    console.log(`[ui-shots] ${shots.length} screenshots in ${outDir} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  } finally {
    if (stopGps) stopGps();
    if (chrome) await chrome.close();
    if (server) server.close();
    try {
      if (api.isRunning()) await api.clearWaypoint();
    } catch {
      /* best effort */
    }
    if (!opts.keepApi) api.stop();
  }
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(`[ui-shots] ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
