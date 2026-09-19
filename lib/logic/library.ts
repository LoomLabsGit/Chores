import type { ChoreLibraryItem } from "@/lib/types";

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
