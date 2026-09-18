import { z } from 'zod';

/**
 * The service area. Declared ahead of `build()`, which runs at import time
 * and checks the review demo point against it.
 */
export const PHUKET_BOUNDS = {
  minLng: 98.18,
  minLat: 7.65,
  maxLng: 98.52,
  maxLat: 8.25,
} as const;

/**
 * A coordinate with a default. An empty `REVIEW_DEMO_LAT=` line in .env means
 * "use the default", not 0 (which `z.coerce` would make of it).
 */
const coordinate = (fallback: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.coerce.number().finite().default(fallback),
  );

/**
 * All configuration lives here. Nothing else in the server reads process.env.
 *
 * Secrets that must never reach a browser: TWITCH_CLIENT_SECRET,
 * TWITCH_EXT_SECRET, TWITCH_EVENTSUB_SECRET, MAPBOX_SERVER_TOKEN,
 * STREAMER_DEVICE_SECRET, ADMIN_SESSION_SECRET.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),

  /** Public origin of this API, used to build OAuth + EventSub callback URLs. */
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  /** Public origin of the web bundle, used for OAuth redirects back to admin. */
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),

  DATABASE_URL: z.string().default('postgres://gta:gta@localhost:5432/gta_phuket'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // --- Twitch ---------------------------------------------------------------
  TWITCH_CLIENT_ID: z.string().default(''),
  TWITCH_CLIENT_SECRET: z.string().default(''),
  /** Extension secret from the Twitch dev console, base64 encoded. */
  TWITCH_EXT_SECRET: z.string().default(''),
  TWITCH_EXT_CLIENT_ID: z.string().default(''),
  /** Shared secret used to sign EventSub webhooks. 10-100 chars per Twitch. */
  TWITCH_EVENTSUB_SECRET: z.string().default('dev-eventsub-secret-change-me'),
  /** The channel this deployment serves. Numeric Twitch user id. */
  TWITCH_CHANNEL_ID: z.string().default(''),

  // --- Mapbox ---------------------------------------------------------------
  /** Public token (pk.*). Shipped to browsers for tiles; restrict by URL. */
  MAPBOX_PUBLIC_TOKEN: z.string().default(''),
  /** Server token used for Directions/Geocoding. Never sent to a browser. */
  MAPBOX_SERVER_TOKEN: z.string().default(''),
  MAPBOX_STYLE_URL: z.string().default('mapbox://styles/mapbox/dark-v11'),

  // --- Auth -----------------------------------------------------------------
  /** HMAC key for streamer-device and admin session tokens. */
  ADMIN_SESSION_SECRET: z.string().default('dev-admin-secret-change-me'),
  /** Pairing code the streamer phone types once to get a device token. */
  STREAMER_DEVICE_SECRET: z.string().default('dev-streamer-pair-code'),

  // --- Dev mode -------------------------------------------------------------
  /** Enables /api/dev/*: fake ext JWTs, GPS simulator, simulated redemptions. */
  DEV_MODE: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  /** Retention for raw GPS samples. */
  GPS_RETENTION_HOURS: z.coerce.number().int().positive().default(24),

  /**
   * Fastify `trustProxy`. `false` (the default) means req.ip is the real socket
   * address; behind a reverse proxy set it to that proxy's IP/CIDR, or to a hop
   * count. Never `true` in production: it would let any client spoof its own IP
   * through X-Forwarded-For and walk past the login rate limits.
   */
  TRUST_PROXY: z.string().default('false'),

  /**
   * TCP port for the extension request log: newline-delimited access-log JSON
   * from the ingress Caddy and the Vite dev server. Private Docker network
   * only — compose must never publish it. 0 switches it off.
   */
  EXT_LOG_INGEST_PORT: z.coerce.number().int().min(0).max(65535).default(5140),

  /**
   * Switches the whole Twitch side from the local stub to the real thing.
   *
   * DEV_MODE stays what it is — the simulator, the fake extension tokens, the
   * GPS walker — but with REAL_TWITCH on, none of it may touch Channel Points:
   * rewards, redemptions and EventSub all go to Twitch for real, and the
   * dev endpoints are switched off so a simulated redemption can never be
   * mistaken for a paid one.
   */
  REAL_TWITCH: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  /**
   * How waypoints are paid for (docs/GTA_DOLLAR_ECONOMY.md).
   *
   * `gta_dollar` — the internal GTA$ wallet, topped up through the one
   * «Обмен ETH на GTA DOLLAR» reward. `channel_points_reward` — the legacy
   * per-quote slot rewards, kept so a rollback is a config change.
   */
  WAYPOINT_PAYMENT_MODE: z.enum(['gta_dollar', 'channel_points_reward']).default('gta_dollar'),

  /**
   * REVIEW DEMO GPS (server/src/domain/gps.ts). While on, every GPS read that
   * quotes and maps use answers with a fixed, always-fresh fix at
   * REVIEW_DEMO_LAT / REVIEW_DEMO_LNG, so the Twitch review team can price and
   * buy a waypoint while the streamer is offline.
   *
   * Channel-wide on purpose, and for the review window only: Twitch reviewers
   * cannot be identified by id, so every viewer of the channel sees the demo
   * position while this is on. Real GPS keeps being ingested and stored; it is
   * simply not used until the flag goes back off.
   */
  REVIEW_DEMO_MODE: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  /** Demo position. Defaults to Patong; must lie inside the Phuket service area. */
  REVIEW_DEMO_LAT: coordinate(7.8961),
  REVIEW_DEMO_LNG: coordinate(98.2958),
});

export type Env = z.infer<typeof schema> & {
  isProduction: boolean;
  isTest: boolean;
  devModeEnabled: boolean;
  /** True when the app must talk to the real Twitch API and nothing else. */
  realTwitch: boolean;
  waypointPaymentMode: 'gta_dollar' | 'channel_points_reward';
  /** REVIEW_DEMO_MODE and its position, in one place (see the schema above). */
  reviewDemo: { active: boolean; lat: number; lng: number };
};

/** Everything REAL_TWITCH cannot work without. */
const REAL_TWITCH_REQUIRED = [
  'TWITCH_EXT_SECRET',
  'TWITCH_CLIENT_ID',
  'TWITCH_CLIENT_SECRET',
  'TWITCH_CHANNEL_ID',
  'TWITCH_EVENTSUB_SECRET',
] as const;

/** Values that ship in .env.example and must never survive into production. */
const INSECURE_DEFAULTS: Record<string, string[]> = {
  ADMIN_SESSION_SECRET: ['dev-admin-secret-change-me', 'change-me-admin-secret'],
  STREAMER_DEVICE_SECRET: ['dev-streamer-pair-code', 'phuket-pair-1234'],
  TWITCH_EVENTSUB_SECRET: [
    'dev-eventsub-secret-change-me',
    'change-me-to-a-long-random-string',
  ],
};

function build(): Env {
  const parsed = schema.parse(process.env);
  const isProduction = parsed.NODE_ENV === 'production';

  if (isProduction) {
    // Failing to boot is the only honest response: these secrets are the whole
    // of the admin, device-pairing and webhook authentication.
    const bad = Object.entries(INSECURE_DEFAULTS)
      .filter(([key, values]) => values.includes(String(parsed[key as keyof typeof parsed] ?? '')))
      .map(([key]) => key);
    const short = (['ADMIN_SESSION_SECRET', 'STREAMER_DEVICE_SECRET', 'TWITCH_EVENTSUB_SECRET'] as const)
      .filter((key) => String(parsed[key] ?? '').length < 16);
    const problems = [...new Set([...bad, ...short])];
    if (problems.length) {
      throw new Error(
        `Refusing to start in production with placeholder or short secrets: ${problems.join(', ')}. ` +
          'Set each to a long random value in .env.',
      );
    }
  }

  const realTwitch = parsed.REAL_TWITCH;

  if (realTwitch) {
    // Half-configured real mode is worse than dev mode: the app would create
    // rewards it cannot manage, or accept webhooks it cannot verify.
    const missing = REAL_TWITCH_REQUIRED.filter((key) => !String(parsed[key] ?? '').trim());
    if (missing.length) {
      throw new Error(
        `REAL_TWITCH=true but these are empty: ${missing.join(', ')}. ` +
          'Fill them in .env, or set REAL_TWITCH=false to keep using the local stub.',
      );
    }
    if (!/^\d+$/.test(parsed.TWITCH_CHANNEL_ID)) {
      throw new Error(
        `REAL_TWITCH=true needs a numeric TWITCH_CHANNEL_ID (the id, not the login). ` +
          `Got "${parsed.TWITCH_CHANNEL_ID}".`,
      );
    }
    // Twitch will not deliver EventSub to http:// or to a name it cannot
    // resolve, and it would fail silently hours later rather than loudly now.
    if (!parsed.PUBLIC_API_URL.startsWith('https://')) {
      throw new Error(
        `REAL_TWITCH=true needs an https PUBLIC_API_URL for the EventSub callback. ` +
          `Got "${parsed.PUBLIC_API_URL}".`,
      );
    }
    if (/^https:\/\/(localhost|127\.|\[::1\])/.test(parsed.PUBLIC_API_URL)) {
      throw new Error(
        'REAL_TWITCH=true needs a PUBLIC_API_URL Twitch can reach. ' +
          `"${parsed.PUBLIC_API_URL}" is this machine only.`,
      );
    }
  }

  const reviewDemo = {
    active: parsed.REVIEW_DEMO_MODE,
    lat: parsed.REVIEW_DEMO_LAT,
    lng: parsed.REVIEW_DEMO_LNG,
  };
  if (reviewDemo.active) {
    // A demo point outside the service area would fail every quote with
    // out_of_bounds — the review would see a broken map instead of a demo.
    const b = PHUKET_BOUNDS;
    const inside =
      reviewDemo.lat >= b.minLat &&
      reviewDemo.lat <= b.maxLat &&
      reviewDemo.lng >= b.minLng &&
      reviewDemo.lng <= b.maxLng;
    if (!inside) {
      throw new Error(
        `REVIEW_DEMO_MODE=true needs REVIEW_DEMO_LAT/REVIEW_DEMO_LNG inside Phuket ` +
          `(${b.minLat}..${b.maxLat}, ${b.minLng}..${b.maxLng}). ` +
          `Got ${reviewDemo.lat}, ${reviewDemo.lng}.`,
      );
    }
  }

  return {
    ...parsed,
    isProduction,
    isTest: parsed.NODE_ENV === 'test',
    realTwitch,
    waypointPaymentMode: parsed.WAYPOINT_PAYMENT_MODE,
    reviewDemo,
    // Dev endpoints are hard-disabled in production, and in real Twitch mode:
    // a simulated redemption must never be able to stand in for a paid one.
    devModeEnabled: parsed.DEV_MODE && !isProduction && !realTwitch,
  };
}

export const env: Env = build();

/** Re-read process.env. Only used by tests that mutate configuration. */
export function reloadEnv(): Env {
  const next = build();
  Object.assign(env, next);
  return env;
}
