import type {
  Challenge,
  ChoreCompletion,
  ChoreInstance,
  ChoreLibraryItem,
  RewardRedemption,
} from "@/lib/types";
import { addDays, isoOfTimestamp } from "./dates";

export type Timeframe = "day" | "week" | "month" | "3m" | "6m" | "1y";

export const TIMEFRAMES: { id: Timeframe; label: string; days: number; caption: string }[] = [
  { id: "day", label: "Day", days: 1, caption: "Today" },
  { id: "week", label: "Week", days: 7, caption: "Last 7 days" },
  { id: "month", label: "Month", days: 30, caption: "Last 30 days" },
  { id: "3m", label: "3 Months", days: 90, caption: "Last 3 months" },
  { id: "6m", label: "6 Months", days: 180, caption: "Last 6 months" },
  { id: "1y", label: "1 Year", days: 365, caption: "Last year" },
];

export const DEFAULT_TIMEFRAME: Timeframe = "month";

/** First local date (inclusive) of a rolling window that ends today. */
export function timeframeStart(tf: Timeframe, today: string): string {
  const days = TIMEFRAMES.find((t) => t.id === tf)!.days;
  return addDays(today, -(days - 1));
}

export type StatsInstance = Pick<ChoreInstance, "id" | "chore_id" | "scheduled_date" | "completed_at">;

export type StatsInput = {
  memberIds: string[];
  completions: ChoreCompletion[];
  instances: StatsInstance[];
  library: Pick<ChoreLibraryItem, "id" | "category">[];
  challenges: Challenge[];
  redemptions: RewardRedemption[];
  /** Inclusive local start date (YYYY-MM-DD). The window ends "now". */
  start: string;
};

export type UserStats = {
  minutes: number;
  chorePoints: number;
  challengePoints: number;
  earned: number;
  spent: number;
};

export type StatsResult = {
  perUser: Record<string, UserStats>;
  totalMinutes: number;
  /** Whole-number percentage of logged minutes per member; null when nothing is logged. */
  split: Record<string, number> | null;
  categories: { category: string; minutes: number }[];
  consistency: { onTime: number; delayed: number; onTimePct: number | null };
  completionCount: number;
};

const inWindow = (ts: string | null | undefined, start: string) => !!ts && isoOfTimestamp(ts) >= start;

export function computeStats(input: StatsInput): StatsResult {
  const { memberIds, start } = input;
  const perUser: Record<string, UserStats> = Object.fromEntries(
    memberIds.map((id) => [id, { minutes: 0, chorePoints: 0, challengePoints: 0, earned: 0, spent: 0 }]),
  );
  const instanceById = new Map(input.instances.map((i) => [i.id, i]));
  const categoryByChore = new Map(input.library.map((c) => [c.id, c.category || "General"]));
  const categoryMinutes = new Map<string, number>();
  let onTime = 0;
  let delayed = 0;
  let completionCount = 0;

  for (const c of input.completions) {
    if (!inWindow(c.created_at, start)) continue;
    completionCount += 1;

    const a = perUser[c.user_a_id];
    if (a) {
      a.minutes += c.user_a_duration;
      a.chorePoints += c.user_a_points;
    }
    // Solo households store the caller in both slots with a zero share; adding
    // the zero row twice is harmless.
    const b = perUser[c.user_b_id];
    if (b) {
      b.minutes += c.user_b_duration;
      b.chorePoints += c.user_b_points;
    }

    const inst = c.instance_id ? instanceById.get(c.instance_id) : undefined;
    const category = (inst?.chore_id && categoryByChore.get(inst.chore_id)) || "General";
    categoryMinutes.set(category, (categoryMinutes.get(category) ?? 0) + c.total_duration_minutes);

    if (inst?.completed_at) {
      if (isoOfTimestamp(inst.completed_at) <= inst.scheduled_date) onTime += 1;
      else delayed += 1;
    }
  }

  for (const ch of input.challenges) {
    if (ch.status === "completed" && inWindow(ch.completed_at, start)) {
      const u = perUser[ch.assigned_to];
      if (u) u.challengePoints += ch.reward_points;
    }
  }
  for (const r of input.redemptions) {
    if (!inWindow(r.created_at, start)) continue;
    const u = perUser[r.redeemed_by];
    if (u) u.spent += r.cost;
  }
  for (const u of Object.values(perUser)) u.earned = u.chorePoints + u.challengePoints;

  const totalMinutes = memberIds.reduce((sum, id) => sum + perUser[id].minutes, 0);
  let split: StatsResult["split"] = null;
  if (totalMinutes > 0) {
    split = {};
    let assigned = 0;
    memberIds.forEach((id, i) => {
      // Last member takes the remainder so the pair always sums to exactly 100.
      const pct = i === memberIds.length - 1 ? 100 - assigned : Math.round((perUser[id].minutes / totalMinutes) * 100);
      split![id] = pct;
      assigned += pct;
    });
  }

  const categories = [...categoryMinutes.entries()]
    .map(([category, minutes]) => ({ category, minutes }))
    .filter((c) => c.minutes > 0)
    .sort((x, y) => y.minutes - x.minutes || x.category.localeCompare(y.category));

  const judged = onTime + delayed;
  return {
    perUser,
    totalMinutes,
    split,
    categories,
    consistency: { onTime, delayed, onTimePct: judged ? Math.round((onTime / judged) * 100) : null },
    completionCount,
  };
}
