import type { AppNotification, Challenge } from "@/lib/types";

/** Challenges a partner has proposed to `meId` that still need Accept / Decline. */
export const pendingProposals = (challenges: Challenge[], meId: string) =>
  challenges.filter((c) => c.status === "pending" && c.assigned_to === meId);

/**
 * Bell badge = unread alerts + proposals awaiting a decision whose alert has
 * already been read (opening the drawer marks alerts read, but a pending
 * proposal is still an outstanding approval).
 */
export function badgeCount(
  notifications: AppNotification[],
  challenges: Challenge[],
  meId: string,
): number {
  const unread = notifications.filter((n) => !n.is_read).length;
  const unreadProposalIds = new Set(
    notifications.filter((n) => !n.is_read && n.type === "challenge_proposed").map((n) => n.reference_id),
  );
  const stillPending = pendingProposals(challenges, meId).filter((c) => !unreadProposalIds.has(c.id)).length;
  return unread + stillPending;
}
