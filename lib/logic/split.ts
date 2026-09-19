export const DURATION_STEPS = [1, 5, 10, 30, 60] as const;
export const MAX_MINUTES = 1440;

export const clampMinutes = (n: number) =>
  Number.isFinite(n) ? Math.min(MAX_MINUTES, Math.max(0, Math.round(n))) : 0;

/**
 * The spec's rounding rule: nearest integer of total * share.
 * `total * pct` is an exact integer, so `/ 100` is correctly rounded and
 * x.5 ties are exact. Matches Postgres `round(total * pct / 100.0)`.
 */
export const share = (total: number, pct: number) => Math.round((total * pct) / 100);

export type SplitPart = { pct: number; minutes: number; points: number };
export type Split = { me: SplitPart; partner: SplitPart };

/** myPct is the current user's share, 0-100 in steps of 10. */
export function computeSplit(totalMinutes: number, totalPoints: number, myPct: number): Split {
  const partnerPct = 100 - myPct;
  return {
    me: { pct: myPct, minutes: share(totalMinutes, myPct), points: share(totalPoints, myPct) },
    partner: {
      pct: partnerPct,
      minutes: share(totalMinutes, partnerPct),
      points: share(totalPoints, partnerPct),
    },
  };
}

/** 75 -> "1h 15m", 60 -> "1h", 45 -> "45m", 0 -> "0m" */
export function formatMinutes(total: number): string {
  const m = Math.max(0, Math.round(total));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}
