import type { Reward } from "@/lib/types";

// A new reward has to be signed off by the other person before it reaches the shop (migration 0015).
// The database enforces this; these helpers just sort rewards into the places the screen shows them.

const live = (rewards: Reward[]) => rewards.filter((r) => r.is_active);

/** What can be redeemed: approved, not retired, cheapest first. */
export const inShop = (rewards: Reward[]) =>
  live(rewards)
    .filter((r) => r.status === "approved")
    .sort((a, b) => a.cost - b.cost);

/** Suggested by the other person and waiting for MY answer. */
export const awaitingMySignoff = (rewards: Reward[], meId: string) =>
  live(rewards).filter((r) => r.status === "pending" && r.created_by !== meId);

/** Suggested by me and waiting for the other person. */
export const awaitingPartner = (rewards: Reward[], meId: string) =>
  live(rewards).filter((r) => r.status === "pending" && r.created_by === meId);

/** Mine, and turned down. Shown to me so I can remove it. */
export const declinedMine = (rewards: Reward[], meId: string) =>
  live(rewards).filter((r) => r.status === "declined" && r.created_by === meId);
