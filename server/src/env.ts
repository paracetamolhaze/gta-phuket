import { z } from 'zod';

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
});

export type Env = z.infer<typeof schema> & {
  isProduction: boolean;
  isTest: boolean;
  devModeEnabled: boolean;
};

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

  return {
    ...parsed,
    isProduction,
    isTest: parsed.NODE_ENV === 'test',
    // Dev endpoints are hard-disabled in production regardless of the flag.
    devModeEnabled: parsed.DEV_MODE && !isProduction,
  };
}

export const env: Env = build();

/** Re-read process.env. Only used by tests that mutate configuration. */
export function reloadEnv(): Env {
  const next = build();
  Object.assign(env, next);
  return env;
}

export const PHUKET_BOUNDS = {
  minLng: 98.18,
  minLat: 7.65,
  maxLng: 98.52,
  maxLat: 8.25,
} as const;
