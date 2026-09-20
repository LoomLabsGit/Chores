import type { Challenge } from "@/lib/types";

/** 0-100 (not rounded) so the ring fills smoothly. */
export const progressPct = (c: Pick<Challenge, "current_count" | "target_count">) =>
  c.target_count <= 0 ? 0 : Math.min(100, (c.current_count / c.target_count) * 100);

// ---------------------------------------------------------------------------
// Forfeit and joint challenges
// ---------------------------------------------------------------------------

/** Each partner's half of a joint reward: round(reward / 2). Mirrors public.challenge_half(). */
export const jointHalf = (reward: number) => Math.round(reward / 2);

/** What a finished challenge paid the person it is for, or each partner when it is joint. */
export const payoutEach = (c: Pick<Challenge, "reward_points" | "is_joint">) =>
  c.is_joint ? jointHalf(c.reward_points) : c.reward_points;

/** Ran out of time: either without a penalty ("expired") or with one ("expired_penalized"). */
export const hasEnded = (c: Pick<Challenge, "status">) => c.status === "expired" || c.status === "expired_penalized";

/** Days from `today` to `deadline` (both YYYY-MM-DD, local). Negative once it has passed. */
export function daysUntil(deadline: string, today: string): number {
  const ms = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(deadline) - ms(today)) / 86_400_000);
}

/** "Due today", "Due tomorrow", "5 days left" or "Overdue". */
export function describeDeadline(deadline: string, today: string): string {
  const n = daysUntil(deadline, today);
  if (n < 0) return "Overdue";
  if (n === 0) return "Due today";
  if (n === 1) return "Due tomorrow";
  return `${n} days left`;
}

/**
 * The line under a joint challenge: each person's contribution, e.g. "You: 3 | Blake: 2".
 * `meIsA` says whether the viewer is the household creator ("a").
 */
export function contributionLine(
  c: Pick<Challenge, "completed_by_a_count" | "completed_by_b_count">,
  meIsA: boolean,
  partnerName: string,
): string {
  const mine = meIsA ? c.completed_by_a_count : c.completed_by_b_count;
  const theirs = meIsA ? c.completed_by_b_count : c.completed_by_a_count;
  return `You: ${mine} | ${partnerName}: ${theirs}`;
}
