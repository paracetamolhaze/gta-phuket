import { describe, expect, it } from 'vitest';
import { calculatePrice, roundUpTo, TWITCH_MAX_COST } from '../src/domain/pricing.js';
import { DEFAULT_SETTINGS } from '../src/domain/types.js';

const base = {
  baseCost: 100,
  pointsPer100Meters: 100,
  minimumCost: 100,
  maximumCost: 100_000,
  roundTo: 50,
};

describe('price calculation', () => {
  it('follows the published formula', () => {
    // 1370 m -> ceil(13.7) = 14 units -> 100 + 1400 = 1500, already on the grid
    const result = calculatePrice(1370, base);
    expect(result.hundredMeterUnits).toBe(14);
    expect(result.distanceCost).toBe(1400);
    expect(result.rawCost).toBe(1500);
    expect(result.cost).toBe(1500);
    expect(result.clampedBy).toBeNull();
  });

  it('charges a partial 100 m block as a whole one', () => {
    expect(calculatePrice(101, base).hundredMeterUnits).toBe(2);
    expect(calculatePrice(100, base).hundredMeterUnits).toBe(1);
    expect(calculatePrice(0.5, base).hundredMeterUnits).toBe(1);
  });

  it('rounds up to the configured step', () => {
    const cfg = { ...base, baseCost: 10, pointsPer100Meters: 7, roundTo: 50, minimumCost: 1 };
    // 250 m -> 3 units * 7 = 21 + 10 = 31 -> rounds up to 50
    expect(calculatePrice(250, cfg).rawCost).toBe(31);
    expect(calculatePrice(250, cfg).cost).toBe(50);
  });

  it('never rounds down', () => {
    const cfg = { ...base, baseCost: 0, pointsPer100Meters: 100, roundTo: 300, minimumCost: 1 };
    // 400 m -> 400 raw -> next multiple of 300 is 600
    expect(calculatePrice(400, cfg).cost).toBe(600);
  });

  it('clamps to the minimum', () => {
    const cfg = { ...base, baseCost: 0, pointsPer100Meters: 1, minimumCost: 500, roundTo: 1 };
    const result = calculatePrice(50, cfg);
    expect(result.rawCost).toBe(1);
    expect(result.cost).toBe(500);
    expect(result.clampedBy).toBe('minimum');
  });

  it('clamps to the maximum after rounding', () => {
    const cfg = { ...base, maximumCost: 1234, roundTo: 500 };
    const result = calculatePrice(50_000, cfg);
    expect(result.cost).toBe(1234);
    expect(result.clampedBy).toBe('maximum');
  });

  it('stays inside the range Twitch accepts', () => {
    const silly = {
      baseCost: 10_000_000,
      pointsPer100Meters: 10_000_000,
      minimumCost: 0,
      maximumCost: 999_999_999,
      roundTo: 1,
    };
    const result = calculatePrice(5000, silly);
    expect(result.cost).toBeLessThanOrEqual(TWITCH_MAX_COST);
    expect(result.cost).toBeGreaterThanOrEqual(1);
  });

  it('is monotonic in distance', () => {
    let previous = 0;
    for (let d = 0; d <= 5000; d += 137) {
      const cost = calculatePrice(d, base).cost;
      expect(cost).toBeGreaterThanOrEqual(previous);
      previous = cost;
    }
  });

  it('produces an integer for every default-config distance', () => {
    for (let d = 0; d <= 5000; d += 61) {
      const cost = calculatePrice(d, DEFAULT_SETTINGS).cost;
      expect(Number.isInteger(cost)).toBe(true);
    }
  });

  it('treats a negative or non-finite distance as zero', () => {
    expect(calculatePrice(-500, base).cost).toBe(calculatePrice(0, base).cost);
    expect(calculatePrice(Number.NaN, base).cost).toBe(calculatePrice(0, base).cost);
  });

  it('rounds up to sane steps', () => {
    expect(roundUpTo(100, 50)).toBe(100);
    expect(roundUpTo(101, 50)).toBe(150);
    expect(roundUpTo(1, 1)).toBe(1);
    expect(roundUpTo(1.2, 0)).toBe(2);
  });
});
