import type { AppNotification, Challenge, Reward } from "@/lib/types";
import { awaitingMySignoff } from "./rewards";

/** Challenges a partner has proposed to `meId` that still need Accept / Decline. */
export const pendingProposals = (challenges: Challenge[], meId: string) =>
  challenges.filter((c) => c.status === "pending" && c.assigned_to === meId);

/**
 * Bell badge = unread alerts + proposals and reward sign-offs awaiting a
 * decision whose alert has already been read (opening the drawer marks alerts
 * read, but a pending proposal is still an outstanding approval).
 */
export function badgeCount(
  notifications: AppNotification[],
  challenges: Challenge[],
  meId: string,
  rewards: Reward[] = [],
): number {
  const unread = notifications.filter((n) => !n.is_read).length;
  const unreadIds = (type: string) =>
    new Set(notifications.filter((n) => !n.is_read && n.type === type).map((n) => n.reference_id));
  const unreadProposalIds = unreadIds("challenge_proposed");
  const stillPending = pendingProposals(challenges, meId).filter((c) => !unreadProposalIds.has(c.id)).length;
  const unreadSignoffIds = unreadIds("reward_proposed");
  const stillAwaiting = awaitingMySignoff(rewards, meId).filter((r) => !unreadSignoffIds.has(r.id)).length;
  return unread + stillPending + stillAwaiting;
}
