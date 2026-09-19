import type { Challenge } from "@/lib/types";

/** 0-100 (not rounded) so the ring fills smoothly. */
export const progressPct = (c: Pick<Challenge, "current_count" | "target_count">) =>
  c.target_count <= 0 ? 0 : Math.min(100, (c.current_count / c.target_count) * 100);
