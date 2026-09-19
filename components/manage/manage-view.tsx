"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  describeUsage,
  DEFAULT_CATEGORY,
  filterLibrary,
  libraryCategories,
  type LibraryUsage,
} from "@/lib/logic/library";
import { calculatePoints } from "@/lib/logic/points";
import { useHousehold } from "@/lib/store/household-store";
import type { ChoreLibraryItem } from "@/lib/types";
import { Icon } from "../icons";
import { CategoryChips } from "../ui/category-chips";
import { EmptyState, fieldClass, primaryButton } from "../ui/controls";
import { ChoreFormSheet } from "./chore-form-sheet";
import { DeleteChoreSheet } from "./delete-chore-sheet";

/**
 * The chore library as a small CMS: every chore you can schedule, with its usual time, chore tax and
 * category. Edits here are pushed to the chores already on the calendar (see update_library_chore).
 */
export function ManageView() {
  const { state, actions } = useHousehold();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [editing, setEditing] = useState<ChoreLibraryItem | "new" | null>(null);
  const [deleting, setDeleting] = useState<ChoreLibraryItem | null>(null);
  const [usage, setUsage] = useState<Record<string, LibraryUsage> | null>(null);

  // Usage counts come from one grouped query. Refresh them whenever the library changes (your edits
  // and your partner's both arrive through it), without depending on the actions object's identity.
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  });
  const refreshUsage = useCallback(async () => {
    const next = await actionsRef.current.fetchLibraryUsage();
    if (next) setUsage(next);
  }, []);
  useEffect(() => {
    void refreshUsage();
  }, [refreshUsage, state.library]);

  const categories = libraryCategories(state.library);
  // A category filter must not outlive the last chore in it (e.g. after that chore is deleted).
  const activeCategory = category && categories.some((c) => c.toLowerCase() === category.toLowerCase()) ? category : null;
  const chores = filterLibrary(state.library, query, activeCategory);
  const total = filterLibrary(state.library, "", null).length;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Manage chores</h1>
          <p className="mt-1 max-w-prose text-sm font-semibold text-muted">
            Everything you can put on the calendar. Change a chore here and it updates everywhere it&rsquo;s planned.
          </p>
        </div>
        <button onClick={() => setEditing("new")} className={`${primaryButton} min-h-11 shrink-0 px-4`}>
          <Icon name="plus" size={20} strokeWidth={2.6} />
          New
        </button>
      </div>

      {total === 0 ? (
        <EmptyState icon={<Icon name="sliders" size={26} />} title="Your library is empty">
          Add the chores your household does. You can schedule them from the calendar.
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chores"
              aria-label="Search chores"
              className={fieldClass}
            />
            <CategoryChips
              categories={categories}
              value={activeCategory}
              onChange={setCategory}
              className="-mx-4 px-4 md:mx-0 md:flex-wrap md:px-0"
            />
            <p className="text-xs font-extrabold uppercase tracking-wide text-muted" aria-live="polite">
              {chores.length === total ? `${total} ${total === 1 ? "chore" : "chores"}` : `${chores.length} of ${total} chores`}
            </p>
          </div>

          {chores.length === 0 ? (
            <EmptyState icon={<Icon name="sliders" size={26} />} title="No chores match">
              Try a different search or category.
            </EmptyState>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {chores.map((c) => (
                <li key={c.id}>
                  <ChoreRow chore={c} usage={usage?.[c.id]} onOpen={() => setEditing(c)} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <ChoreFormSheet
        target={editing}
        usage={editing && editing !== "new" ? usage?.[editing.id] : undefined}
        onClose={() => setEditing(null)}
        onDelete={(chore) => {
          setEditing(null);
          setDeleting(chore);
        }}
      />
      <DeleteChoreSheet
        chore={deleting}
        usage={deleting ? usage?.[deleting.id] : undefined}
        onCancel={() => setDeleting(null)}
        onDeleted={() => setDeleting(null)}
      />
    </div>
  );
}

function ChoreRow({ chore, usage, onOpen }: { chore: ChoreLibraryItem; usage: LibraryUsage | undefined; onOpen: () => void }) {
  const pts = calculatePoints(chore.default_duration, chore.chore_tax);
  return (
    <button
      onClick={onOpen}
      aria-label={`Edit ${chore.title}`}
      className="flex min-h-[5.5rem] w-full items-center gap-3 rounded-3xl border border-line bg-surface p-4 text-left shadow-card transition-transform active:scale-[0.99]"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-extrabold">{chore.title}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm font-semibold text-muted">
          <span className="rounded-full bg-raised px-2 py-0.5 text-xs font-bold">{chore.category?.trim() || DEFAULT_CATEGORY}</span>
          <span>{chore.default_duration} min</span>
          {chore.chore_tax > 0 && <span>+{chore.chore_tax} tax</span>}
        </p>
        <p className="mt-1 truncate text-xs font-semibold text-muted">{usage ? describeUsage(usage) : " "}</p>
      </div>
      <span className="flex shrink-0 items-center gap-1 rounded-full bg-gold-soft px-3 py-1.5 text-sm font-extrabold text-gold">
        <Icon name="bolt" size={14} />
        {pts}
      </span>
      <Icon name="chevron-right" size={18} className="shrink-0 text-muted" />
    </button>
  );
}
