// Points are earned from TIME plus a flat "chore tax":
//
//   base points  = round(minutes / 5)          12 points per hour, 1 per 5 minutes
//   total points = base points + chore tax     the tax is a flat bonus for nasty jobs
//   split        = A gets round(total * share), B gets total - A   (always sums exactly)
//
// This is mirrored by public.chore_points() and public.complete_chore() in
// supabase/migrations/0006_time_based_points.sql; keep the two in step.

export const MINUTES_PER_POINT = 5;
export const MIN_MINUTES = 5;
export const MAX_MINUTES = 1440;
export const MAX_TAX = 50;

/** Quick-pad steps for the duration fields (all multiples of 5). */
export const COMPLETION_STEPS = [5, 10, 30] as const;
export const ESTIMATE_STEPS = [5, 15, 30] as const;
/** One-tap chips for the chore tax. Any value from 0 to MAX_TAX can also be typed. */
export const TAX_CHIPS = [0, 2, 5, 10] as const;

/** Snaps any number to a valid duration: a multiple of 5, from 5 to 1440 minutes. */
export function snapMinutes(n: number): number {
  if (!Number.isFinite(n)) return MIN_MINUTES;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(n / MINUTES_PER_POINT) * MINUTES_PER_POINT));
}

export const clampTax = (n: number) =>
  Number.isFinite(n) ? Math.min(MAX_TAX, Math.max(0, Math.round(n))) : 0;

export const calculateBasePoints = (durationMinutes: number) => Math.round(durationMinutes / MINUTES_PER_POINT);

export function calculatePoints(durationMinutes: number, choreTax: number): number {
  return calculateBasePoints(durationMinutes) + choreTax;
}

export type SplitPart = { pct: number; minutes: number; points: number };
export type Split = { a: SplitPart; b: SplitPart };

/**
 * Splits minutes and points between two people. `percentA` (0-100, steps of 10) is A's share.
 * A gets the rounded share; B gets the remainder, so the parts always add up to the totals.
 * `total * percent` is an exact integer, so `/ 100` is correctly rounded and ties round up,
 * matching Postgres `round(total * pct / 100.0)`.
 */
export function calculateSplit(totalDuration: number, totalPoints: number, percentA: number): Split {
  const aMinutes = Math.round((totalDuration * percentA) / 100);
  const aPoints = Math.round((totalPoints * percentA) / 100);
  return {
    a: { pct: percentA, minutes: aMinutes, points: aPoints },
    b: { pct: 100 - percentA, minutes: totalDuration - aMinutes, points: totalPoints - aPoints },
  };
}

/** Estimated reward for a scheduled chore (its "bounty"). */
export const estimatePoints = (chore: { estimated_duration: number; chore_tax: number }) =>
  calculatePoints(chore.estimated_duration, chore.chore_tax);

/** "Est. Reward: 15 mins (3 pts) + Tax (5 pts) = 8 pts" */
export function describeReward(minutes: number, tax: number): string {
  return `Est. Reward: ${minutes} mins (${calculateBasePoints(minutes)} pts) + Tax (${tax} pts) = ${calculatePoints(minutes, tax)} pts`;
}
