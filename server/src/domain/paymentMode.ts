import { env } from '../env.js';
import type { PaymentMode } from './types.js';

let override: PaymentMode | null = null;

/**
 * The payment mode in force. Everything reads it through here rather than from
 * `env` directly: the mode is fixed at boot in production, but a test file
 * that exercises the legacy slot rewards has to be able to pin it, and
 * `reloadEnv()` (which other suites call) must not silently undo that.
 */
export function paymentMode(): PaymentMode {
  return override ?? env.waypointPaymentMode;
}

/** Tests only: pin the mode for this module instance; null returns to `env`. */
export function setPaymentModeOverride(mode: PaymentMode | null): void {
  override = mode;
}
