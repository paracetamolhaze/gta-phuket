import type { PriceBreakdown, PricingConfig } from './types.js';

/** Twitch rejects Custom Reward costs outside this range. */
export const TWITCH_MIN_COST = 1;
export const TWITCH_MAX_COST = 1_000_000;

export function roundUpTo(value: number, step: number): number {
  if (!Number.isFinite(step) || step <= 1) return Math.ceil(value);
  return Math.ceil(value / step) * step;
}

/**
 * The one place a price is ever produced.
 *
 *   raw  = baseCost + ceil(distanceMeters / 100) * pointsPer100Meters
 *   cost = clamp(roundUpTo(raw, roundTo), minimumCost, maximumCost)
 *
 * Clamping happens after rounding so `maximumCost` is a hard ceiling even when
 * it is not a multiple of `roundTo`.
 */
export function calculatePrice(distanceMeters: number, config: PricingConfig): PriceBreakdown {
  const distance = Number.isFinite(distanceMeters) ? Math.max(0, distanceMeters) : 0;

  const baseCost = Math.max(0, Math.trunc(config.baseCost));
  const perUnit = Math.max(0, Math.trunc(config.pointsPer100Meters));
  const roundTo = Math.max(1, Math.trunc(config.roundTo));

  // A hard floor of 1 keeps us inside Twitch's own limits even if an admin
  // sets minimumCost to 0.
  const minimum = Math.max(TWITCH_MIN_COST, Math.trunc(config.minimumCost));
  const maximum = Math.min(TWITCH_MAX_COST, Math.max(minimum, Math.trunc(config.maximumCost)));

  const hundredMeterUnits = Math.ceil(distance / 100);
  const distanceCost = hundredMeterUnits * perUnit;
  const rawCost = baseCost + distanceCost;

  const rounded = roundUpTo(rawCost, roundTo);

  let cost = rounded;
  let clampedBy: PriceBreakdown['clampedBy'] = null;
  if (cost < minimum) {
    cost = minimum;
    clampedBy = 'minimum';
  } else if (cost > maximum) {
    cost = maximum;
    clampedBy = 'maximum';
  }

  return {
    baseCost,
    distanceMeters: distance,
    hundredMeterUnits,
    distanceCost,
    rawCost,
    cost,
    clampedBy,
  };
}
