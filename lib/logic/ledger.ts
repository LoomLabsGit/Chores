import type { ChoreCompletion } from "@/lib/types";
import { calculatePoints, calculateSplit } from "./points";

// The dynamic ledger. Changing a finished chore re-prices it: the total is recalculated from the logged
// time and the tax, split again, and each person's balance moves by the DIFFERENCE between their new
// and old share. This mirrors public.reprice_completion() (migration 0009); keep the two in step.

/** What a finished chore is worth, for each person involved, as recorded when it was completed. */
export function completionShares(c: Pick<ChoreCompletion, "user_a_id" | "user_a_points" | "user_b_id" | "user_b_points">) {
  const shares: Record<string, number> = {};
  shares[c.user_a_id] = (shares[c.user_a_id] ?? 0) + c.user_a_points;
  shares[c.user_b_id] = (shares[c.user_b_id] ?? 0) + c.user_b_points;
  return shares;
}

export type Repricing = {
  /** Minutes actually logged. */
  minutes: number;
  tax: number;
  /** The owner's share of the effort, 0-100 in steps of 10. */
  ownerPercent: number;
  /** Whose chore it is: they hold the first share. */
  ownerId: string;
  /** The other person (equal to ownerId in a household of one). */
  otherId: string;
};

/** The shares a finished chore would have with these values. */
export function repricedShares(r: Repricing) {
  const total = calculatePoints(r.minutes, r.tax);
  const split = calculateSplit(r.minutes, total, r.ownerPercent);
  const shares: Record<string, number> = {};
  shares[r.ownerId] = (shares[r.ownerId] ?? 0) + split.a.points;
  shares[r.otherId] = (shares[r.otherId] ?? 0) + split.b.points;
  return { total, shares };
}

export type LedgerRow = { userId: string; before: number; after: number; delta: number };

/** Per person: what they had, what they will have, and the difference that hits their balance. */
export function ledgerRows(before: Record<string, number>, after: Record<string, number>): LedgerRow[] {
  const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return ids.map((userId) => {
    const b = before[userId] ?? 0;
    const a = after[userId] ?? 0;
    return { userId, before: b, after: a, delta: a - b };
  });
}

/** "+3", "−2" (a true minus sign) or "0". */
export const formatDelta = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0");
