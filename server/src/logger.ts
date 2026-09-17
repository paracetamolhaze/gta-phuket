import pino, { type LoggerOptions } from 'pino';
import { env } from './env.js';

/**
 * Shared pino configuration.
 *
 * Fastify builds its own logger from these options (so its instance type stays
 * the default `FastifyBaseLogger`), while everything outside a request uses the
 * standalone instance below. Same level, same redaction, same formatting.
 */
export const loggerOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  transport: env.isProduction
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
  redact: {
    paths: [
      'req.headers.authorization',
      'access_token',
      'refresh_token',
      'client_secret',
      '*.access_token',
      '*.refresh_token',
    ],
    censor: '[redacted]',
  },
};

export const logger = pino(loggerOptions);

export type Logger = typeof logger;
