"use client";

import Link from "next/link";
import { useState } from "react";
import { formatLongDay } from "@/lib/logic/dates";
import {
  allChoresAlphabetical,
  commonChores,
  filterLibrary,
  libraryCategories,
  recentChores,
  resolveCategory,
  titleTaken,
} from "@/lib/logic/library";
import { describeRepeat, REPEAT_OPTIONS, type RepeatChoice } from "@/lib/logic/recurrence";
import { DEFAULT_BOUNTY, ESTIMATE_STEPS, libraryPoints, snapMinutes } from "@/lib/logic/points";
import { useHousehold } from "@/lib/store/household-store";
import type { ChoreLibraryItem, PricingType } from "@/lib/types";
import { Icon } from "../icons";
import { useToast } from "../toast";
import { CategoryChips } from "../ui/category-chips";
import { CategoryCombobox } from "../ui/category-combobox";
import { fieldClass, primaryButton } from "../ui/controls";
import { AssigneeField, PricingFields } from "../ui/points-controls";
import { Modal } from "../ui/modal";

/** What the user picked in step 1, waiting for "when / who / repeat" in step 2. */
type Draft =
  | { kind: "library"; chore: ChoreLibraryItem }
  | { kind: "new"; title: string };

type Props = {
  open: boolean;
  /** Day to start on (the day whose "+" was tapped, or the day being viewed). */
  date: string;
  onClose: () => void;
  /** Called with the day a chore was added to, so the calendar can jump to that week. */
  onAdded: (date: string) => void;
};

export function AddChoreSheet({ open, ...rest }: Props) {
  // Mounted only while open, so every opening starts fresh at step 1.
  if (!open) return null;
  return <Sheet {...rest} />;
}

function Sheet({ date, onClose, onAdded }: Omit<Props, "open">) {
  const [draft, setDraft] = useState<Draft | null>(null);
  // Remember a typed chore and the search/filter so "Back" does not lose them.
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);

  return (
    <Modal
      open
      onClose={onClose}
      title="Add chore"
      variant="sheet"
      headerExtra={
        draft && (
          <button
            onClick={() => setDraft(null)}
            aria-label="Back to choosing a chore"
            className="flex h-11 items-center gap-1 rounded-full pl-2 pr-3 text-sm font-bold text-brand hover:bg-brand-soft"
          >
            <Icon name="chevron-left" size={18} />
            Back
          </button>
        )
      }
      footer={
        draft ? undefined : (
          <NewChoreInput
            initial={typed}
            onNext={(title) => {
              setTyped(title);
              setDraft({ kind: "new", title });
            }}
          />
        )
      }
    >
      {draft ? (
        <WhenWhoRepeat draft={draft} date={date} onClose={onClose} onAdded={onAdded} />
      ) : (
        <Library
          onPick={(chore) => setDraft({ kind: "library", chore })}
          onCreate={(title) => {
            setTyped(title);
            setDraft({ kind: "new", title });
          }}
          onManage={onClose}
          query={query}
          onQuery={setQuery}
          category={category}
          onCategory={setCategory}
        />
      )}
    </Modal>
  );
}

function Pill({ chore, onPick }: { chore: ChoreLibraryItem; onPick: (c: ChoreLibraryItem) => void }) {
  return (
    <button
      onClick={() => onPick(chore)}
      className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-line bg-surface px-4 py-1 text-[15px] font-bold shadow-card"
    >
      {chore.title}
      <span className="flex items-center gap-0.5 text-xs font-extrabold text-gold">
        <Icon name="bolt" size={11} />
        {libraryPoints(chore)}
      </span>
    </button>
  );
}

/**
 * Step 1: choose from the library, with the same search and quick category filters as the Manage tab.
 * Filtering swaps the Recent / Common / All sections for one list of matches. (A new chore can also be
 * typed in the docked input.)
 */
function Library({
  onPick,
  onCreate,
  onManage,
  query,
  onQuery,
  category,
  onCategory,
}: {
  onPick: (c: ChoreLibraryItem) => void;
  onCreate: (title: string) => void;
  onManage: () => void;
  query: string;
  onQuery: (q: string) => void;
  category: string | null;
  onCategory: (c: string | null) => void;
}) {
  const { state } = useHousehold();

  const categories = libraryCategories(state.library);
  // A filter must not outlive the last chore in its category.
  const activeCategory = category && categories.some((c) => c.toLowerCase() === category.toLowerCase()) ? category : null;
  const searching = query.trim() !== "" || activeCategory !== null;
  const results = searching ? filterLibrary(state.library, query, activeCategory) : [];
  // Offered only when nothing matches: with matches on screen, picking one is what you are after.
  const canCreate = results.length === 0 && query.trim() !== "" && !titleTaken(state.library, query);

  const recent = recentChores(state.library);
  const common = commonChores(state.library);
  const all = allChoresAlphabetical(state.library);

  return (
    <div className="flex flex-col gap-5">
      {/* Pinned to the top of the sheet so it stays reachable while scrolling a long library. */}
      <div className="sticky top-0 z-10 -mx-5 flex flex-col gap-2.5 bg-surface px-5 pb-2 pt-1">
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search chores"
          aria-label="Search chores"
          enterKeyHint="search"
          className={fieldClass}
        />
        <CategoryChips categories={categories} value={activeCategory} onChange={onCategory} className="-mx-5 px-5" />
      </div>

      {searching ? (
        <section aria-label="Search results" aria-live="polite" className="flex flex-col gap-3">
          <h3 className="text-xs font-extrabold uppercase tracking-wide text-muted">
            {results.length} {results.length === 1 ? "match" : "matches"}
          </h3>
          {results.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {results.map((c) => (
                <Pill key={c.id} chore={c} onPick={onPick} />
              ))}
            </div>
          )}
          {canCreate && (
            <button
              onClick={() => onCreate(query.trim())}
              className="flex min-h-12 items-center gap-2 self-start rounded-2xl border border-dashed border-brand/50 px-4 text-left font-bold text-brand hover:bg-brand-soft"
            >
              <Icon name="plus" size={18} strokeWidth={2.6} />
              <span className="min-w-0 truncate">Create &ldquo;{query.trim()}&rdquo; as a new chore</span>
            </button>
          )}
          {results.length === 0 && !canCreate && (
            <p className="rounded-2xl bg-raised px-4 py-6 text-center text-sm text-muted">
              Nothing matches. Try a different search or category.
            </p>
          )}
        </section>
      ) : (
        <>
          <p className="text-sm font-semibold text-muted">Pick a chore, or type a new one below.</p>

          {recent.length > 0 && (
            <section aria-labelledby="recent-h">
              <h3 id="recent-h" className="mb-2 text-xs font-extrabold uppercase tracking-wide text-muted">
                Recent
              </h3>
              <div className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5 pb-1">
                {recent.map((c) => (
                  <Pill key={c.id} chore={c} onPick={onPick} />
                ))}
              </div>
            </section>
          )}

          {common.length > 0 && (
            <section aria-labelledby="common-h">
              <h3 id="common-h" className="mb-2 text-xs font-extrabold uppercase tracking-wide text-muted">
                Common
              </h3>
              <div className="flex flex-wrap gap-2">
                {common.map((c) => (
                  <Pill key={c.id} chore={c} onPick={onPick} />
                ))}
              </div>
            </section>
          )}

          <section aria-labelledby="all-h">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 id="all-h" className="text-xs font-extrabold uppercase tracking-wide text-muted">
                All tasks
              </h3>
              <Link
                href="/manage"
                onClick={onManage}
                className="flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-bold text-brand hover:bg-brand-soft"
              >
                <Icon name="sliders" size={16} />
                Manage chores
              </Link>
            </div>
            {all.length === 0 ? (
              <p className="rounded-2xl bg-raised px-4 py-6 text-center text-sm text-muted">
                Your library is empty. Type a chore below to create your first one.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {all.map((c) => (
                  <Pill key={c.id} chore={c} onPick={onPick} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** Docked at the bottom of step 1: type a name and continue. Duration, tax and the rest come next. */
function NewChoreInput({ initial, onNext }: { initial: string; onNext: (title: string) => void }) {
  const [title, setTitle] = useState(initial);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const name = title.trim();
    if (name) onNext(name);
  }

  return (
    <form onSubmit={submit} className="flex gap-2">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={60}
        placeholder="Add a new chore..."
        aria-label="New chore name"
        enterKeyHint="next"
        className={fieldClass}
      />
      <button
        type="submit"
        disabled={!title.trim()}
        aria-label="Continue with this new chore"
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand text-brand-ink disabled:opacity-40"
      >
        <Icon name="chevron-right" size={24} strokeWidth={2.5} />
      </button>
    </form>
  );
}

/** Step 2: how long, how nasty, which day, who does it, and whether it repeats. Nothing is added until "Add". */
function WhenWhoRepeat({
  draft,
  date,
  onClose,
  onAdded,
}: {
  draft: Draft;
  date: string;
  onClose: () => void;
  onAdded: (date: string) => void;
}) {
  const { me, partner, tone, state, actions } = useHousehold();
  const { toast } = useToast();
  const categories = libraryCategories(state.library);
  const [day, setDay] = useState(date);
  const [assignee, setAssignee] = useState<string | null>(me.id);
  const [repeat, setRepeat] = useState<RepeatChoice>("none");
  const [minutes, setMinutes] = useState(draft.kind === "library" ? snapMinutes(draft.chore.default_duration) : 15);
  const [tax, setTax] = useState(draft.kind === "library" ? draft.chore.chore_tax : 0);
  // A library chore brings its own pricing model; a new one starts time-based.
  const [pricing, setPricing] = useState<PricingType>(draft.kind === "library" ? draft.chore.pricing_type : "time_based");
  const [bounty, setBounty] = useState(draft.kind === "library" ? draft.chore.fixed_bounty_points : DEFAULT_BOUNTY);
  // Only a brand-new chore needs a category; one from the library already has its own.
  const [category, setCategory] = useState("");

  const name = draft.kind === "library" ? draft.chore.title : draft.title;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!day) return;
    const repeating = repeat !== "none";
    onClose();
    onAdded(day); // jump the calendar to that week straight away; the chore appears optimistically
    const run =
      draft.kind === "library"
        ? actions.scheduleChore(draft.chore, day, assignee, { repeat, minutes, tax, pricing, bounty })
        : actions.createAndScheduleChore(
            { title: draft.title, minutes, tax, pricing, bounty, category: resolveCategory(categories, category) },
            day,
            assignee,
            repeat,
          );
    void run.then(
      (ok) =>
        ok &&
        toast(
          repeating ? `Added ${name}. ${describeRepeat(repeat, day)}` : `Added ${name} to ${formatLongDay(day)}`,
          "success",
        ),
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <div className="rounded-2xl bg-raised p-4">
        <p className="text-lg font-extrabold leading-snug">{name}</p>
      </div>

      {draft.kind === "new" && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="add-category" className="text-sm font-extrabold">
            Category
          </label>
          <CategoryCombobox id="add-category" value={category} onChange={setCategory} categories={categories} />
        </div>
      )}

      <PricingFields
        pricing={pricing}
        onPricing={setPricing}
        bounty={bounty}
        onBounty={setBounty}
        minutes={minutes}
        onMinutes={setMinutes}
        tax={tax}
        onTax={setTax}
        steps={ESTIMATE_STEPS}
        timeId="add-minutes"
      />

      <label className="flex flex-col gap-1.5 text-sm font-extrabold">
        Day
        <input type="date" required value={day} onChange={(e) => setDay(e.target.value)} className={fieldClass} />
        <span className="text-xs font-semibold text-muted">{day ? formatLongDay(day) : "Choose a day"}</span>
      </label>

      <AssigneeField value={assignee} onChange={setAssignee} me={me} partner={partner} tone={tone} />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="add-repeat" className="text-sm font-extrabold">
          Repeat
        </label>
        <select
          id="add-repeat"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value as RepeatChoice)}
          className={fieldClass}
        >
          {REPEAT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <p className="text-xs font-semibold text-muted" aria-live="polite">
          {day ? describeRepeat(repeat, day) : ""}
        </p>
      </div>

      <button type="submit" disabled={!day} className={`${primaryButton} min-h-14 text-lg`}>
        <Icon name="plus" strokeWidth={2.6} />
        {repeat === "none" ? "Add chore" : "Add and repeat"}
      </button>
    </form>
  );
}
