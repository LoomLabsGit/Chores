import type { BacklogItem, BacklogPriority } from "@/lib/types";

// The backlog: jobs that need doing, kept in one shared list until someone plans them onto the calendar.
// Everything here is pure (no React, no Supabase) so it can be unit tested directly.

export const DEFAULT_PRIORITY: BacklogPriority = 2;

/** Highest first, which is also the order the backlog is shown in. */
export const PRIORITIES: { value: BacklogPriority; label: string }[] = [
  { value: 3, label: "High" },
  { value: 2, label: "Medium" },
  { value: 1, label: "Low" },
];

export const priorityLabel = (p: BacklogPriority): string => PRIORITIES.find((x) => x.value === p)?.label ?? "Medium";

/**
 * Highest priority first. Within a priority the job that has waited longest comes first, so an old job is never
 * buried under newer ones of the same weight. (The id breaks exact ties so the order never shuffles on a refresh.)
 */
export function sortBacklog(items: BacklogItem[]): BacklogItem[] {
  return [...items].sort(
    (a, b) =>
      b.priority - a.priority ||
      Date.parse(a.created_at) - Date.parse(b.created_at) ||
      a.id.localeCompare(b.id),
  );
}

/** Whose jobs to show: everyone's, the signed-in person's, their partner's, or the ones nobody owns yet. */
export type BacklogWho = "all" | "mine" | "partner" | "open";

export type BacklogFilter = {
  query: string;
  /** null = every priority. */
  priority: BacklogPriority | null;
  who: BacklogWho;
};

export const NO_FILTER: BacklogFilter = { query: "", priority: null, who: "all" };

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** True once any narrowing is on, so the screen can offer "clear filters". */
export const isFiltering = (f: BacklogFilter) => norm(f.query) !== "" || f.priority !== null || f.who !== "all";

/** The jobs matching a filter, in backlog order. */
export function filterBacklog(items: BacklogItem[], filter: BacklogFilter, meId: string): BacklogItem[] {
  const q = norm(filter.query);
  return sortBacklog(items).filter((item) => {
    if (filter.priority !== null && item.priority !== filter.priority) return false;
    if (filter.who === "mine" && item.assigned_to !== meId) return false;
    if (filter.who === "partner" && (item.assigned_to === null || item.assigned_to === meId)) return false;
    if (filter.who === "open" && item.assigned_to !== null) return false;
    return !q || norm(item.title).includes(q);
  });
}

/** Already-sorted jobs split into their priority bands (empty bands left out), highest first. */
export function groupByPriority(sorted: BacklogItem[]): { priority: BacklogPriority; items: BacklogItem[] }[] {
  return PRIORITIES.map(({ value }) => ({ priority: value, items: sorted.filter((i) => i.priority === value) })).filter(
    (g) => g.items.length > 0,
  );
}

/** "12 jobs" or "3 of 12 jobs". */
export function describeCount(shown: number, total: number): string {
  const jobs = (n: number) => `${n} ${n === 1 ? "job" : "jobs"}`;
  return shown === total ? jobs(total) : `${shown} of ${jobs(total)}`;
}

/** The jobs worth offering while adding to the calendar: backlog order, optionally narrowed by a search. */
export function backlogForPicker(items: BacklogItem[], query: string, limit?: number): BacklogItem[] {
  const matches = filterBacklog(items, { ...NO_FILTER, query }, "");
  return limit === undefined ? matches : matches.slice(0, limit);
}
