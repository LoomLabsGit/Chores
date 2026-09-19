"use client";

import { useState } from "react";
import { formatLongDay } from "@/lib/logic/dates";
import { allChoresAlphabetical, commonChores, recentChores } from "@/lib/logic/library";
import { describeRepeat, REPEAT_OPTIONS, type RepeatChoice } from "@/lib/logic/recurrence";
import { calculatePoints, ESTIMATE_STEPS, snapMinutes } from "@/lib/logic/points";
import { useHousehold } from "@/lib/store/household-store";
import type { ChoreLibraryItem } from "@/lib/types";
import { Icon } from "../icons";
import { useToast } from "../toast";
import { fieldClass, primaryButton } from "../ui/controls";
import { AssigneeField, DurationField, RewardPreview, TaxField } from "../ui/points-controls";
import { ConfirmDialog, Modal } from "../ui/modal";

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
  // Remember a typed chore so "Back" does not lose it.
  const [typed, setTyped] = useState("");

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
        <Library onPick={(chore) => setDraft({ kind: "library", chore })} />
      )}
    </Modal>
  );
}

function Pill({
  chore,
  onPick,
  onDelete,
}: {
  chore: ChoreLibraryItem;
  onPick: (c: ChoreLibraryItem) => void;
  onDelete?: (c: ChoreLibraryItem) => void;
}) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-line bg-surface shadow-card">
      <button
        onClick={() => onPick(chore)}
        className={`flex min-h-11 items-center gap-2 py-1 pl-4 text-[15px] font-bold ${onDelete ? "pr-1" : "pr-4"}`}
      >
        {chore.title}
        <span className="flex items-center gap-0.5 text-xs font-extrabold text-gold">
          <Icon name="bolt" size={11} />
          {calculatePoints(chore.default_duration, chore.chore_tax)}
        </span>
      </button>
      {onDelete && (
        <button
          onClick={() => onDelete(chore)}
          aria-label={`Delete ${chore.title} from library`}
          className="flex h-11 w-11 items-center justify-center rounded-full text-muted hover:text-danger"
        >
          <Icon name="x" size={16} />
        </button>
      )}
    </span>
  );
}

/** Step 1: choose from the library (or type a new chore in the docked input). */
function Library({ onPick }: { onPick: (c: ChoreLibraryItem) => void }) {
  const { state, actions } = useHousehold();
  const { toast } = useToast();
  const [pendingDelete, setPendingDelete] = useState<ChoreLibraryItem | null>(null);

  const recent = recentChores(state.library);
  const common = commonChores(state.library);
  const all = allChoresAlphabetical(state.library);

  return (
    <div className="flex flex-col gap-5">
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
        <h3 id="all-h" className="mb-2 text-xs font-extrabold uppercase tracking-wide text-muted">
          All tasks
        </h3>
        {all.length === 0 ? (
          <p className="rounded-2xl bg-raised px-4 py-6 text-center text-sm text-muted">
            Your library is empty. Type a chore below to create your first one.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {all.map((c) => (
              <Pill key={c.id} chore={c} onPick={onPick} onDelete={setPendingDelete} />
            ))}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete chore?"
        message="Are you sure you want to delete this chore from your library?"
        confirmLabel="Delete"
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const chore = pendingDelete;
          setPendingDelete(null);
          if (chore) void actions.archiveChore(chore.id).then((ok) => ok && toast(`${chore.title} removed from your library`));
        }}
      />
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
  const { me, partner, tone, actions } = useHousehold();
  const { toast } = useToast();
  const [day, setDay] = useState(date);
  const [assignee, setAssignee] = useState<string | null>(me.id);
  const [repeat, setRepeat] = useState<RepeatChoice>("none");
  const [minutes, setMinutes] = useState(draft.kind === "library" ? snapMinutes(draft.chore.default_duration) : 15);
  const [tax, setTax] = useState(draft.kind === "library" ? draft.chore.chore_tax : 0);

  const name = draft.kind === "library" ? draft.chore.title : draft.title;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!day) return;
    const repeating = repeat !== "none";
    onClose();
    onAdded(day); // jump the calendar to that week straight away; the chore appears optimistically
    const run =
      draft.kind === "library"
        ? actions.scheduleChore(draft.chore, day, assignee, { repeat, minutes, tax })
        : actions.createAndScheduleChore({ title: draft.title, minutes, tax }, day, assignee, repeat);
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

      <div className="flex flex-col gap-1.5">
        <label htmlFor="add-minutes" className="text-sm font-extrabold">
          How long will it take?
        </label>
        <DurationField inputId="add-minutes" value={minutes} onChange={setMinutes} steps={ESTIMATE_STEPS} label="Estimated minutes" />
      </div>

      <TaxField value={tax} onChange={setTax} />
      <RewardPreview minutes={minutes} tax={tax} />

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
