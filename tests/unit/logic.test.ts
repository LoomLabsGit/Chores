import { describe, expect, it } from "vitest";
import { badgeCount } from "@/lib/logic/notifications";
import { progressPct } from "@/lib/logic/challenges";
import {
  addDays,
  formatWeekTitle,
  isoOfTimestamp,
  parseISODate,
  startOfWeek,
  toISODate,
  weekDays,
} from "@/lib/logic/dates";
import {
  allChoresAlphabetical,
  commonChores,
  describePush,
  describeUsage,
  categoryOptions,
  filterLibrary,
  libraryCategories,
  recentChores,
  resolveCategory,
  titleTaken,
} from "@/lib/logic/library";
import { describeRepeat, frequencyFromRule, ordinal } from "@/lib/logic/recurrence";
import { completionShares, formatDelta, ledgerRows, repricedShares } from "@/lib/logic/ledger";
import {
  calculateBasePoints,
  calculatePoints,
  calculateSplit,
  clampTax,
  describeReward,
  estimatePoints,
  snapMinutes,
} from "@/lib/logic/points";
import { formatMinutes } from "@/lib/logic/split";
import { computeStats, timeframeStart } from "@/lib/logic/stats";
import type {
  AppNotification,
  Challenge,
  ChoreCompletion,
  ChoreLibraryItem,
  RewardRedemption,
} from "@/lib/types";

describe("dates", () => {
  it("weeks run Monday to Sunday", () => {
    expect(startOfWeek("2026-09-18")).toBe("2026-09-14"); // Friday -> Monday
    expect(startOfWeek("2026-09-14")).toBe("2026-09-14"); // Monday stays
    expect(startOfWeek("2026-09-20")).toBe("2026-09-14"); // Sunday belongs to the week before
    expect(weekDays("2026-09-14")).toEqual([
      "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20",
    ]);
  });

  it("adds days across month and year boundaries and DST", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    // UK clocks change 2026-03-29 and 2026-10-25; date maths must not drift.
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(addDays("2026-10-24", 2)).toBe("2026-10-26");
  });

  it("round-trips local dates without a UTC shift", () => {
    expect(toISODate(parseISODate("2026-01-01"))).toBe("2026-01-01");
    // 23:30 local must still be the same local calendar day.
    expect(isoOfTimestamp(new Date(2026, 8, 18, 23, 30).toISOString())).toBe("2026-09-18");
    expect(isoOfTimestamp(new Date(2026, 8, 18, 0, 15).toISOString())).toBe("2026-09-18");
  });

  it("titles weeks that span months and years", () => {
    expect(formatWeekTitle("2026-09-14")).toBe("September 2026");
    expect(formatWeekTitle("2026-09-28")).toBe("Sep – Oct 2026");
    expect(formatWeekTitle("2026-12-28")).toBe("Dec 2026 – Jan 2027");
  });
});

describe("time-based points", () => {
  it("earns 12 points an hour: 1 base point per 5 minutes, minimum 1", () => {
    expect(calculateBasePoints(5)).toBe(1);
    expect(calculateBasePoints(15)).toBe(3);
    expect(calculateBasePoints(60)).toBe(12);
    expect(calculateBasePoints(90)).toBe(18);
  });

  it("adds the chore tax as a flat bonus, whatever the duration", () => {
    expect(calculatePoints(25, 4)).toBe(9); // 5 base + 4 tax (the spec's example)
    expect(calculatePoints(5, 6)).toBe(7);
    expect(calculatePoints(60, 6)).toBe(18);
    expect(calculatePoints(15, 0)).toBe(3);
  });

  it("estimates a scheduled chore's bounty from its estimate and tax", () => {
    expect(estimatePoints({ estimated_duration: 15, chore_tax: 5 })).toBe(8);
    expect(estimatePoints({ estimated_duration: 30, chore_tax: 0 })).toBe(6);
  });

  it("words the live reward preview as specified", () => {
    expect(describeReward(15, 5)).toBe("Est. Reward: 15 mins (3 pts) + Tax (5 pts) = 8 pts");
  });

  it("snaps durations to multiples of 5, from 5 to 1440", () => {
    expect(snapMinutes(0)).toBe(5);
    expect(snapMinutes(-20)).toBe(5);
    expect(snapMinutes(7)).toBe(5);
    expect(snapMinutes(8)).toBe(10);
    expect(snapMinutes(45)).toBe(45);
    expect(snapMinutes(99999)).toBe(1440);
    expect(snapMinutes(Number.NaN)).toBe(5);
  });

  it("keeps the tax between 0 and 50", () => {
    expect(clampTax(-3)).toBe(0);
    expect(clampTax(7.4)).toBe(7);
    expect(clampTax(500)).toBe(50);
    expect(clampTax(Number.NaN)).toBe(0);
  });
});

describe("split maths", () => {
  it("matches the spec's receipt: 25 min + tax 4 = 9 pts, split 60/40", () => {
    const s = calculateSplit(25, calculatePoints(25, 4), 60);
    expect(s.a).toEqual({ pct: 60, minutes: 15, points: 5 });
    expect(s.b).toEqual({ pct: 40, minutes: 10, points: 4 });
  });

  it("matches the earlier example: 60/40 of 30 min and 10 pts", () => {
    const s = calculateSplit(30, 10, 60);
    expect(s.a).toEqual({ pct: 60, minutes: 18, points: 6 });
    expect(s.b).toEqual({ pct: 40, minutes: 12, points: 4 });
  });

  it("rounds A's share (ties up) and gives B the remainder, so the parts always add up", () => {
    expect(calculateSplit(5, 5, 50).a).toMatchObject({ minutes: 3, points: 3 }); // 2.5 -> 3
    expect(calculateSplit(5, 5, 50).b).toMatchObject({ minutes: 2, points: 2 }); // remainder, not another 3
    expect(calculateSplit(15, 7, 30).a.points).toBe(2); // 2.1 -> 2
    expect(calculateSplit(15, 7, 30).b.points).toBe(5);
  });

  it("always sums exactly to the totals, with whole numbers, for every duration and split", () => {
    for (let minutes = 5; minutes <= 240; minutes += 5) {
      for (let pct = 0; pct <= 100; pct += 10) {
        const total = calculatePoints(minutes, 3);
        const s = calculateSplit(minutes, total, pct);
        expect(s.a.minutes + s.b.minutes).toBe(minutes);
        expect(s.a.points + s.b.points).toBe(total);
        for (const n of [s.a.minutes, s.a.points, s.b.minutes, s.b.points]) {
          expect(Number.isInteger(n)).toBe(true);
          expect(n).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("handles the extremes", () => {
    expect(calculateSplit(20, 8, 100).b).toEqual({ pct: 0, minutes: 0, points: 0 });
    expect(calculateSplit(20, 8, 0).a).toEqual({ pct: 0, minutes: 0, points: 0 });
    expect(calculateSplit(20, 8, 0).b).toEqual({ pct: 100, minutes: 20, points: 8 });
  });

  it("formats durations", () => {
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(60)).toBe("1h");
    expect(formatMinutes(75)).toBe("1h 15m");
  });
});

const lib = (over: Partial<ChoreLibraryItem>): ChoreLibraryItem => ({
  id: over.title ?? "x",
  household_id: "h",
  title: "x",
  category: "General",
  default_duration: 15,
  default_points: 5,
  chore_tax: 0,
  is_archived: false,
  last_used_at: null,
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("chore library groupings", () => {
  const items = [
    lib({ title: "Washing up", last_used_at: "2026-09-10T10:00:00Z" }),
    lib({ title: "Hoovering", last_used_at: "2026-09-12T10:00:00Z" }),
    lib({ title: "Bins", last_used_at: "2026-09-15T10:00:00Z" }),
    lib({ title: "Ironing", last_used_at: "2026-09-11T10:00:00Z" }),
    lib({ title: "Dusting", last_used_at: "2026-09-14T10:00:00Z" }),
    lib({ title: "Cooking dinner", last_used_at: "2026-09-13T10:00:00Z" }),
    lib({ title: "Old", last_used_at: "2026-09-16T10:00:00Z", is_archived: true }),
    lib({ title: "Hanging laundry" }), // never scheduled
    lib({ title: "apples" }),
  ];

  it("recent = the 5 most recently scheduled, newest first, no archived or never-used", () => {
    expect(recentChores(items).map((c) => c.title)).toEqual([
      "Bins", "Dusting", "Cooking dinner", "Hoovering", "Ironing",
    ]);
  });

  it("common = the six base chores that still exist, in spec order", () => {
    expect(commonChores(items).map((c) => c.title)).toEqual([
      "Washing up", "Hoovering", "Cooking dinner", "Hanging laundry",
    ]);
    expect(commonChores(items.map((c) => (c.title === "Washing up" ? { ...c, is_archived: true } : c))).map((c) => c.title))
      .not.toContain("Washing up");
  });

  it("all = alphabetical, case-insensitive, without archived", () => {
    expect(allChoresAlphabetical(items).map((c) => c.title)).toEqual([
      "apples", "Bins", "Cooking dinner", "Dusting", "Hanging laundry", "Hoovering", "Ironing", "Washing up",
    ]);
  });
});

const note = (over: Partial<AppNotification>): AppNotification => ({
  id: Math.random().toString(),
  recipient_id: "me",
  actor_id: "them",
  type: "chore_completed",
  reference_id: null,
  message: "m",
  is_read: false,
  created_at: "2026-09-18T10:00:00Z",
  ...over,
});
const challenge = (over: Partial<Challenge>): Challenge => ({
  id: "c1",
  household_id: "h",
  creator_id: "them",
  assigned_to: "me",
  title: "t",
  target_count: 4,
  current_count: 0,
  reward_points: 20,
  status: "pending",
  created_at: "2026-09-18T10:00:00Z",
  completed_at: null,
  ...over,
});

describe("bell badge", () => {
  it("counts unread alerts", () => {
    expect(badgeCount([note({}), note({}), note({ is_read: true })], [], "me")).toBe(2);
  });

  it("does not double count a proposal and its unread alert", () => {
    const n = [note({ type: "challenge_proposed", reference_id: "c1" })];
    expect(badgeCount(n, [challenge({})], "me")).toBe(1);
  });

  it("keeps counting a pending proposal after its alert was read", () => {
    const n = [note({ type: "challenge_proposed", reference_id: "c1", is_read: true })];
    expect(badgeCount(n, [challenge({})], "me")).toBe(1);
    expect(badgeCount(n, [challenge({ status: "active" })], "me")).toBe(0);
  });

  it("ignores proposals aimed at the partner", () => {
    expect(badgeCount([], [challenge({ assigned_to: "them", creator_id: "me" })], "me")).toBe(0);
  });
});

describe("challenge progress", () => {
  it("is proportional and capped", () => {
    expect(progressPct({ current_count: 3, target_count: 12 })).toBe(25);
    expect(progressPct({ current_count: 12, target_count: 12 })).toBe(100);
    expect(progressPct({ current_count: 20, target_count: 12 })).toBe(100);
    expect(progressPct({ current_count: 0, target_count: 0 })).toBe(0);
  });
});

describe("stats", () => {
  const A = "a";
  const B = "b";
  const at = (iso: string, h = 12) => {
    const d = parseISODate(iso);
    d.setHours(h);
    return d.toISOString();
  };

  const completion = (over: Partial<ChoreCompletion>): ChoreCompletion => ({
    id: Math.random().toString(),
    instance_id: "i1",
    total_duration_minutes: 30,
    user_a_id: A,
    user_a_duration: 30,
    user_a_points: 5,
    user_b_id: B,
    user_b_duration: 0,
    user_b_points: 0,
    owner_percent: 100,
    created_at: at("2026-09-18"),
    ...over,
  });

  const base = {
    memberIds: [A, B],
    library: [
      { id: "kitchen", category: "Kitchen" },
      { id: "garden", category: "Garden" },
    ],
    challenges: [] as Challenge[],
    redemptions: [] as RewardRedemption[],
    start: "2026-09-01",
  };

  it("computes the effort split, per-partner time and whole-number percentages", () => {
    const r = computeStats({
      ...base,
      instances: [{ id: "i1", chore_id: "kitchen", scheduled_date: "2026-09-18", completed_at: at("2026-09-18") }],
      completions: [
        completion({ user_a_duration: 18, user_a_points: 6, user_b_duration: 12, user_b_points: 4 }),
        completion({ instance_id: "i1", user_a_duration: 10, total_duration_minutes: 10, user_b_duration: 0 }),
      ],
    });
    expect(r.perUser[A].minutes).toBe(28);
    expect(r.perUser[B].minutes).toBe(12);
    expect(r.totalMinutes).toBe(40);
    expect(r.split).toEqual({ [A]: 70, [B]: 30 });
  });

  it("split always sums to 100 even when rounding would not", () => {
    const r = computeStats({
      ...base,
      instances: [],
      completions: [
        completion({ user_a_duration: 1, user_b_duration: 2, total_duration_minutes: 3 }), // 33.3 / 66.7
        completion({ user_a_duration: 1, user_b_duration: 1, total_duration_minutes: 2 }),
      ],
    });
    // 2 / 3 minutes -> 67% / 33%
    expect(r.split![A] + r.split![B]).toBe(100);
  });

  it("returns null split with nothing logged", () => {
    const r = computeStats({ ...base, instances: [], completions: [] });
    expect(r.split).toBeNull();
    expect(r.consistency.onTimePct).toBeNull();
  });

  it("filters by the window start", () => {
    const r = computeStats({
      ...base,
      start: "2026-09-18",
      instances: [],
      completions: [
        completion({ created_at: at("2026-09-17", 23) }),
        completion({ created_at: at("2026-09-18", 0) }),
      ],
    });
    expect(r.completionCount).toBe(1);
  });

  it("groups minutes by category (General fallback) sorted high to low", () => {
    const r = computeStats({
      ...base,
      instances: [
        { id: "i1", chore_id: "kitchen", scheduled_date: "2026-09-18", completed_at: at("2026-09-18") },
        { id: "i2", chore_id: "garden", scheduled_date: "2026-09-18", completed_at: at("2026-09-18") },
        { id: "i3", chore_id: null, scheduled_date: "2026-09-18", completed_at: at("2026-09-18") },
      ],
      completions: [
        completion({ instance_id: "i1", total_duration_minutes: 45 }),
        completion({ instance_id: "i2", total_duration_minutes: 10 }),
        completion({ instance_id: "i3", total_duration_minutes: 20 }),
        completion({ instance_id: "i1", total_duration_minutes: 15 }),
      ],
    });
    expect(r.categories).toEqual([
      { category: "Kitchen", minutes: 60 },
      { category: "General", minutes: 20 },
      { category: "Garden", minutes: 10 },
    ]);
  });

  it("scores consistency: done on or before the scheduled day is on time", () => {
    const r = computeStats({
      ...base,
      instances: [
        { id: "early", chore_id: null, scheduled_date: "2026-09-20", completed_at: at("2026-09-18") },
        { id: "same", chore_id: null, scheduled_date: "2026-09-18", completed_at: at("2026-09-18", 23) },
        { id: "late", chore_id: null, scheduled_date: "2026-09-10", completed_at: at("2026-09-18") },
      ],
      completions: [
        completion({ instance_id: "early" }),
        completion({ instance_id: "same" }),
        completion({ instance_id: "late" }),
      ],
    });
    expect(r.consistency).toEqual({ onTime: 2, delayed: 1, onTimePct: 67 });
  });

  it("tracks points earned (chores + completed challenges) versus spent", () => {
    const r = computeStats({
      ...base,
      instances: [],
      completions: [completion({ user_a_points: 6, user_b_points: 4 })],
      challenges: [
        challenge({ id: "done", assigned_to: B, status: "completed", reward_points: 20, completed_at: at("2026-09-18") }),
        challenge({ id: "old", assigned_to: B, status: "completed", reward_points: 99, completed_at: at("2026-08-01") }),
        challenge({ id: "open", assigned_to: B, status: "active", reward_points: 50 }),
      ],
      redemptions: [
        { id: "r1", reward_id: "x", redeemed_by: B, cost: 30, created_at: at("2026-09-18") },
        { id: "r0", reward_id: "x", redeemed_by: B, cost: 500, created_at: at("2026-08-01") },
      ],
    });
    expect(r.perUser[A]).toMatchObject({ chorePoints: 6, challengePoints: 0, earned: 6, spent: 0 });
    expect(r.perUser[B]).toMatchObject({ chorePoints: 4, challengePoints: 20, earned: 24, spent: 30 });
  });

  it("rolling windows end today and include it", () => {
    expect(timeframeStart("day", "2026-09-18")).toBe("2026-09-18");
    expect(timeframeStart("week", "2026-09-18")).toBe("2026-09-12");
    expect(timeframeStart("month", "2026-09-18")).toBe("2026-08-20");
    expect(timeframeStart("1y", "2026-09-18")).toBe("2025-09-19");
  });
});

describe("recurrence helpers", () => {
  it("reads the stored rule text", () => {
    expect(frequencyFromRule("FREQ=DAILY")).toBe("daily");
    expect(frequencyFromRule("FREQ=WEEKLY")).toBe("weekly");
    expect(frequencyFromRule("FREQ=WEEKLY;INTERVAL=2")).toBe("biweekly");
    expect(frequencyFromRule("FREQ=MONTHLY")).toBe("monthly");
    expect(frequencyFromRule(null)).toBe("none");
    expect(frequencyFromRule("FREQ=WEEKLY;BYDAY=SA")).toBe("none"); // unknown shapes are treated as not repeating
  });

  it("makes ordinals, including the teens", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 30, 31].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "30th", "31st",
    ]);
  });

  it("describes each option in plain English", () => {
    expect(describeRepeat("none", "2026-09-19")).toBe("Happens once");
    expect(describeRepeat("daily", "2026-09-19")).toBe("Repeats every day");
    expect(describeRepeat("weekly", "2026-09-19")).toBe("Repeats every Saturday");
    expect(describeRepeat("biweekly", "2026-09-19")).toBe("Repeats every other Saturday");
    expect(describeRepeat("monthly", "2026-09-19")).toBe("Repeats on the 19th of each month");
    expect(describeRepeat("monthly", "2026-01-31")).toContain("last day in shorter months");
  });
});

describe("manage chores helpers", () => {
  const items = [
    lib({ id: "1", title: "Washing up", category: "Kitchen" }),
    lib({ id: "2", title: "Hoovering", category: "Cleaning" }),
    lib({ id: "3", title: "Cooking dinner", category: "kitchen" }), // same category, different case
    lib({ id: "4", title: "Old chore", category: "Cleaning", is_archived: true }),
    lib({ id: "5", title: "Untidy", category: "" }),
  ];

  it("lists each live category once, ignoring case and blanks", () => {
    expect(libraryCategories(items)).toEqual(["Cleaning", "General", "Kitchen"]);
  });

  it("filters by search text (name or category) and category, never showing deleted chores", () => {
    expect(filterLibrary(items, "", null).map((c) => c.title)).toEqual(["Cooking dinner", "Hoovering", "Untidy", "Washing up"]);
    expect(filterLibrary(items, "  HOOV ", null).map((c) => c.id)).toEqual(["2"]);
    expect(filterLibrary(items, "", "kitchen").map((c) => c.id)).toEqual(["3", "1"]);
    expect(filterLibrary(items, "clean", null).map((c) => c.id)).toEqual(["2"]); // matches the category
    expect(filterLibrary(items, "", "General").map((c) => c.id)).toEqual(["5"]); // blank category reads as General
    expect(filterLibrary(items, "old", null)).toEqual([]);
  });

  it("spots a duplicate name, ignoring case, spaces, deleted chores and the chore being edited", () => {
    expect(titleTaken(items, "  WASHING UP ")).toBe(true);
    expect(titleTaken(items, "Washing up", "1")).toBe(false);
    expect(titleTaken(items, "Old chore")).toBe(false);
    expect(titleTaken(items, "   ")).toBe(false);
  });

  const before = { title: "Hoovering", minutes: 25, tax: 0 };
  const usage = { open: 3, done: 12, repeating: 1 };

  it("explains what a name change will touch", () => {
    expect(describePush(before, { ...before, title: "Vacuuming" }, usage)).toEqual([
      "The new name shows on 15 chores already on the calendar.",
    ]);
  });

  it("explains what a tax change will touch, including re-pricing finished chores", () => {
    expect(describePush(before, { ...before, tax: 5 }, usage)).toEqual([
      "The new tax applies to 3 unfinished chores and 1 repeating chore (every later day).",
      "12 finished chores will be re-priced (+5 pts each) and balances adjusted to match.",
    ]);
    expect(describePush({ ...before, tax: 8 }, { ...before, tax: 3 }, { open: 0, done: 1, repeating: 0 })).toEqual([
      "1 finished chore will be re-priced (\u22125 pts each) and balances adjusted to match.",
    ]);
  });

  it("leaves finished chores alone when re-pricing is switched off, or when only the time changes", () => {
    expect(describePush(before, { ...before, tax: 5 }, usage, false)[1]).toBe("Finished chores keep the points they earned.");
    expect(describePush(before, { ...before, minutes: 30 }, { open: 1, done: 4, repeating: 0 })).toEqual([
      "The new time applies to 1 unfinished chore.",
      "Finished chores keep the points they earned.",
    ]);
    expect(describePush(before, { ...before, minutes: 30, tax: 5 }, usage)[0]).toMatch(/^The new time and tax apply to /);
  });

  it("says nothing when nothing changes or nothing is planned", () => {
    expect(describePush(before, before, usage)).toEqual([]);
    expect(describePush(before, { ...before, title: "Hoover", tax: 3 }, { open: 0, done: 0, repeating: 0 })).toEqual([]);
    expect(describePush(before, { ...before, title: "  Hoovering " }, usage)).toEqual([]); // whitespace only
  });

  it("describes usage for a list row", () => {
    expect(describeUsage({ open: 3, done: 12, repeating: 1 })).toBe("3 on the calendar · 12 done · repeats");
    expect(describeUsage({ open: 0, done: 1, repeating: 0 })).toBe("1 done");
    expect(describeUsage({ open: 0, done: 0, repeating: 0 })).toBe("Not used yet");
  });
});

describe("dynamic ledger", () => {
  const A = "alex";
  const B = "blake";

  it("reads the shares a completion paid out", () => {
    expect(completionShares({ user_a_id: A, user_a_points: 6, user_b_id: B, user_b_points: 4 })).toEqual({ [A]: 6, [B]: 4 });
    // a household of one records the same person twice
    expect(completionShares({ user_a_id: A, user_a_points: 8, user_b_id: A, user_b_points: 0 })).toEqual({ [A]: 8 });
  });

  it("re-prices from logged time and tax, splitting exactly (owner rounded, other gets the remainder)", () => {
    // 45 min = 9 + tax 4 = 13; 60% -> 8 / 5
    const { total, shares } = repricedShares({ minutes: 45, tax: 4, ownerPercent: 60, ownerId: A, otherId: B });
    expect(total).toBe(13);
    expect(shares).toEqual({ [A]: 8, [B]: 5 });
    expect(shares[A] + shares[B]).toBe(total);
  });

  it("works out each person's difference, as the database does (30 -> 45 min at 60/40, tax 4)", () => {
    const before = completionShares({ user_a_id: A, user_a_points: 6, user_b_id: B, user_b_points: 4 });
    const rows = ledgerRows(before, repricedShares({ minutes: 45, tax: 4, ownerPercent: 60, ownerId: A, otherId: B }).shares);
    expect(rows).toEqual([
      { userId: A, before: 6, after: 8, delta: 2 },
      { userId: B, before: 4, after: 5, delta: 1 },
    ]);
  });

  it("handing the chore over swaps who holds the first share", () => {
    const before = completionShares({ user_a_id: A, user_a_points: 6, user_b_id: B, user_b_points: 4 });
    const rows = ledgerRows(before, repricedShares({ minutes: 30, tax: 4, ownerPercent: 60, ownerId: B, otherId: A }).shares);
    expect(rows.map((r) => [r.userId, r.delta])).toEqual([[A, -2], [B, 2]]);
  });

  it("a lower tax is a debit, and a household of one mirrors the owner", () => {
    const before = completionShares({ user_a_id: A, user_a_points: 16, user_b_id: A, user_b_points: 0 });
    const rows = ledgerRows(before, repricedShares({ minutes: 60, tax: 0, ownerPercent: 100, ownerId: A, otherId: A }).shares);
    expect(rows).toEqual([{ userId: A, before: 16, after: 12, delta: -4 }]);
  });

  it("formats differences with a real minus sign", () => {
    expect([formatDelta(3), formatDelta(-2), formatDelta(0)]).toEqual(["+3", "\u22122", "0"]);
  });
});

describe("category picker logic", () => {
  const cats = ["Laundry", "Kitchen", "Cleaning", "Garden", "Kitchen extras"];

  it("with nothing typed, lists every category alphabetically and offers nothing to create", () => {
    expect(categoryOptions(cats, "")).toEqual({
      matches: ["Cleaning", "Garden", "Kitchen", "Kitchen extras", "Laundry"],
      create: null,
    });
    expect(categoryOptions(cats, "   ").create).toBeNull();
  });

  it("narrows live as you type, starts-with matches first, then the rest alphabetically", () => {
    expect(categoryOptions(cats, "k").matches).toEqual(["Kitchen", "Kitchen extras"]);
    expect(categoryOptions(cats, "en").matches).toEqual(["Garden", "Kitchen", "Kitchen extras"]); // contains, none start with it
    expect(categoryOptions(["Wash", "Dishwasher", "Aw"], "wa").matches).toEqual(["Wash", "Dishwasher"]); // prefix before contains
  });

  it("offers to create text that matches no category, but not one that exists (any case)", () => {
    expect(categoryOptions(cats, "Pets")).toEqual({ matches: [], create: "Pets" });
    expect(categoryOptions(cats, "  Pets  ").create).toBe("Pets");
    expect(categoryOptions(cats, "kitch").create).toBe("kitch"); // partial: still a new name
    expect(categoryOptions(cats, "kitchen")).toEqual({ matches: ["Kitchen", "Kitchen extras"], create: null });
    expect(categoryOptions([], "Pets")).toEqual({ matches: [], create: "Pets" });
    expect(categoryOptions([], "")).toEqual({ matches: [], create: null });
  });

  it("does not reorder the list it is given", () => {
    const input = ["b", "a"];
    categoryOptions(input, "");
    expect(input).toEqual(["b", "a"]);
  });

  it("saves an existing category with its own spelling and anything else trimmed", () => {
    expect(resolveCategory(cats, "  kitchen ")).toBe("Kitchen");
    expect(resolveCategory(cats, " Pets ")).toBe("Pets");
    expect(resolveCategory(cats, "   ")).toBe("");
  });
});
