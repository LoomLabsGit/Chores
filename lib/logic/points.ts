import type { PricingType } from "@/lib/types";

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

// ---------------------------------------------------------------------------
// Pricing models. A chore is either time-based (the formula above) or a fixed bounty: the points are the bounty,
// whatever the time. For a bounty the logged minutes still count, but only for the hours in Stats. The split
// applies to the bounty exactly as it does to time-based points (owner rounded, the other gets the remainder).
// Mirrored by public.chore_total_points() in migration 0012; keep the two in step.
// ---------------------------------------------------------------------------

export const MIN_BOUNTY = 1;
export const MAX_BOUNTY = 500;
export const DEFAULT_BOUNTY = 15;
export const BOUNTY_STEP = 5;

export const clampBounty = (n: number) =>
  Number.isFinite(n) ? Math.min(MAX_BOUNTY, Math.max(MIN_BOUNTY, Math.round(n))) : DEFAULT_BOUNTY;

/** What decides a chore's points: the model, its bounty and its tax. */
export type Pricing = { pricing_type: PricingType; fixed_bounty_points: number; chore_tax: number };

/** Total points for a chore with `minutes` logged (or estimated). */
export function choreTotal(minutes: number, pricing: Pricing): number {
  return pricing.pricing_type === "fixed_bounty" ? pricing.fixed_bounty_points : calculatePoints(minutes, pricing.chore_tax);
}

/** Estimated reward for a scheduled chore (its "bounty pill"). Time-based: from the estimate. Fixed: the bounty. */
export const estimatePoints = (chore: Pricing & { estimated_duration: number }) => choreTotal(chore.estimated_duration, chore);

/** A library chore's usual reward. */
export const libraryPoints = (chore: Pricing & { default_duration: number }) => choreTotal(chore.default_duration, chore);

/** "Est. Reward: 15 mins (3 pts) + Tax (5 pts) = 8 pts" */
export function describeReward(minutes: number, tax: number): string {
  return `Est. Reward: ${minutes} mins (${calculateBasePoints(minutes)} pts) + Tax (${tax} pts) = ${calculatePoints(minutes, tax)} pts`;
}
