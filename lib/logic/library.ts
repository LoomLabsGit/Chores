import type { ChoreLibraryItem, PricingType } from "@/lib/types";
import { formatDelta } from "./ledger";

/** The six pre-baked chores shown in the Add Chore sheet's "Common" row. */
export const COMMON_CHORE_TITLES = [
  "Washing up",
  "Hoovering",
  "Cooking dinner",
  "Watering plants",
  "Dirty laundry",
  "Hanging laundry",
] as const;

const active = (l: ChoreLibraryItem[]) => l.filter((c) => !c.is_archived);

/** The 5 most recently scheduled chores (last_used_at is null until first scheduled). */
export function recentChores(library: ChoreLibraryItem[], limit = 5): ChoreLibraryItem[] {
  return active(library)
    .filter((c) => c.last_used_at)
    .sort((a, b) => Date.parse(b.last_used_at!) - Date.parse(a.last_used_at!))
    .slice(0, limit);
}

export function commonChores(library: ChoreLibraryItem[]): ChoreLibraryItem[] {
  const live = active(library);
  return COMMON_CHORE_TITLES.flatMap((title) => {
    const hit = live.find((c) => c.title.toLowerCase() === title.toLowerCase());
    return hit ? [hit] : [];
  });
}

export function allChoresAlphabetical(library: ChoreLibraryItem[]): ChoreLibraryItem[] {
  return active(library).sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
}

// ---------------------------------------------------------------------------
// Manage chores
// ---------------------------------------------------------------------------

/** How a library chore is being used, from public.library_usage(). */
export type LibraryUsage = {
  /** Unfinished copies on the calendar (including overdue ones). */
  open: number;
  /** Finished copies: history. */
  done: number;
  /** Repeating series that are still running. */
  repeating: number;
};

export const NO_USAGE: LibraryUsage = { open: 0, done: 0, repeating: 0 };

export const DEFAULT_CATEGORY = "General";
export const MAX_CATEGORY_LENGTH = 30;

const norm = (s: string) => s.trim().toLowerCase();

/** Distinct categories in use, alphabetical. */
export function libraryCategories(library: ChoreLibraryItem[]): string[] {
  const seen = new Map<string, string>();
  for (const c of active(library)) {
    const name = c.category?.trim() || DEFAULT_CATEGORY;
    if (!seen.has(norm(name))) seen.set(norm(name), name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

const alphabetical = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

/**
 * What a category picker offers for what has been typed. With nothing typed it is every category,
 * alphabetically. As you type the list reduces live (matches that start with the text first, then
 * the rest, each alphabetical). `create` is the text to offer as a NEW category: only when something
 * is typed and no existing category is exactly that (ignoring case).
 */
export function categoryOptions(categories: string[], typed: string): { matches: string[]; create: string | null } {
  const q = norm(typed);
  const matches = categories
    .filter((c) => !q || norm(c).includes(q))
    .sort((a, b) => {
      const pa = q && norm(a).startsWith(q) ? 0 : 1;
      const pb = q && norm(b).startsWith(q) ? 0 : 1;
      return pa - pb || alphabetical(a, b);
    });
  const exists = categories.some((c) => norm(c) === q);
  return { matches, create: q && !exists ? typed.trim() : null };
}

/** The category text to save: an existing category keeps its spelling ("kitchen" -> "Kitchen"), anything else is trimmed. */
export function resolveCategory(categories: string[], typed: string): string {
  const q = norm(typed);
  return categories.find((c) => norm(c) === q) ?? typed.trim();
}

/** Live chores matching a search box and an optional category, alphabetical. */
export function filterLibrary(library: ChoreLibraryItem[], query: string, category: string | null): ChoreLibraryItem[] {
  const q = norm(query);
  return allChoresAlphabetical(library).filter((c) => {
    const cat = c.category?.trim() || DEFAULT_CATEGORY;
    if (category && norm(cat) !== norm(category)) return false;
    return !q || norm(c.title).includes(q) || norm(cat).includes(q);
  });
}

/** True when another live chore already uses this name (case-insensitive). */
export function titleTaken(library: ChoreLibraryItem[], title: string, exceptId?: string): boolean {
  const t = norm(title);
  return !!t && active(library).some((c) => c.id !== exceptId && norm(c.title) === t);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type LibraryValues = {
  title: string;
  minutes: number;
  tax: number;
  /** Defaults to time-based. */
  pricing?: PricingType;
  /** Defaults to 15. Only matters for a fixed bounty. */
  bounty?: number;
};

/**
 * What saving an edit will do to chores that already exist, as short sentences. Mirrors
 * public.update_library_chore(): a new name reaches every copy (finished ones too); time, tax, bounty and the
 * pricing model reach unfinished copies and repeating chores. Finished chores are re-priced (moving balances by
 * the difference) only when the value that priced them changed: the tax of a time-based chore, or the bounty of
 * a fixed-bounty one, and only if `repriceFinished` is on. Time only ever changes the estimate, and a change of
 * pricing model never rewrites history.
 */
export function describePush(
  before: LibraryValues,
  after: LibraryValues,
  usage: LibraryUsage,
  repriceFinished = true,
): string[] {
  const lines: string[] = [];
  const modelBefore = before.pricing ?? "time_based";
  const modelAfter = after.pricing ?? "time_based";
  const fixed = modelAfter === "fixed_bounty";

  const renamed = before.title.trim() !== after.title.trim();
  const modelChanged = modelBefore !== modelAfter;
  const timeChanged = !fixed && before.minutes !== after.minutes;
  const taxChanged = !fixed && before.tax !== after.tax;
  const bountyChanged = fixed && (before.bounty ?? 15) !== (after.bounty ?? 15);

  if (renamed) {
    const copies = usage.open + usage.done;
    if (copies > 0) lines.push(`The new name shows on ${plural(copies, "chore")} already on the calendar.`);
  }

  const changes = [
    modelChanged ? (fixed ? "fixed bounty" : "time-based pricing") : null,
    timeChanged ? "time" : null,
    taxChanged ? "tax" : null,
    bountyChanged || (modelChanged && fixed) ? "bounty" : null,
  ].filter((c): c is string => !!c);
  if (changes.length) {
    const what = changes.length > 1 ? `${changes.slice(0, -1).join(", ")} and ${changes[changes.length - 1]}` : changes[0];
    const targets = [
      usage.open > 0 ? plural(usage.open, "unfinished chore") : null,
      usage.repeating > 0 ? `${plural(usage.repeating, "repeating chore")} (every later day)` : null,
    ].filter(Boolean);
    if (targets.length) lines.push(`The new ${what} ${changes.length > 1 ? "apply" : "applies"} to ${targets.join(" and ")}.`);
  }

  if (usage.done > 0 && changes.length) {
    // Finished chores only follow a change to the very value that priced them.
    const repriced = !modelChanged && (taxChanged || bountyChanged);
    if (repriced && repriceFinished) {
      const perChore = bountyChanged ? (after.bounty ?? 15) - (before.bounty ?? 15) : after.tax - before.tax;
      lines.push(`${plural(usage.done, "finished chore")} will be re-priced (${formatDelta(perChore)} pts each) and balances adjusted to match.`);
    } else {
      lines.push("Finished chores keep the points they earned.");
    }
  }
  return lines;
}

/** "3 on the calendar · 12 done · repeats" for a row in the manage list. */
export function describeUsage(usage: LibraryUsage): string {
  const parts: string[] = [];
  if (usage.open > 0) parts.push(`${usage.open} on the calendar`);
  if (usage.done > 0) parts.push(`${usage.done} done`);
  if (usage.repeating > 0) parts.push("repeats");
  return parts.length ? parts.join(" · ") : "Not used yet";
}
