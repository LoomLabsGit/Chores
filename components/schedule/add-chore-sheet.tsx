"use client";

import { useState } from "react";
import { formatLongDay } from "@/lib/logic/dates";
import { allChoresAlphabetical, commonChores, recentChores } from "@/lib/logic/library";
import { useHousehold } from "@/lib/store/household-store";
import type { ChoreLibraryItem } from "@/lib/types";
import { Icon } from "../icons";
import { useToast } from "../toast";
import { Avatar, fieldClass, Segmented, Stepper } from "../ui/controls";
import { ConfirmDialog, Modal } from "../ui/modal";

export function AddChoreSheet({ open, date, onClose }: { open: boolean; date: string; onClose: () => void }) {
  // Mounted only while open, so the assignee choice resets on every opening.
  if (!open) return null;
  return <Sheet date={date} onClose={onClose} />;
}

function Sheet({ date, onClose }: { date: string; onClose: () => void }) {
  const { me } = useHousehold();
  const [assignee, setAssignee] = useState(me.id);
  return (
    <Modal
      open
      onClose={onClose}
      title="Add chore"
      variant="sheet"
      footer={<NewChoreInput date={date} assignee={assignee} onDone={onClose} />}
    >
      <Library date={date} assignee={assignee} onAssign={setAssignee} onClose={onClose} />
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
          <Icon name="star" size={11} />
          {chore.default_points}
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

function Library({
  date,
  assignee,
  onAssign,
  onClose,
}: {
  date: string;
  assignee: string;
  onAssign: (id: string) => void;
  onClose: () => void;
}) {
  const { me, partner, state, tone, actions } = useHousehold();
  const { toast } = useToast();
  const [pendingDelete, setPendingDelete] = useState<ChoreLibraryItem | null>(null);

  const recent = recentChores(state.library);
  const common = commonChores(state.library);
  const all = allChoresAlphabetical(state.library);

  function pick(chore: ChoreLibraryItem) {
    onClose();
    void actions.scheduleChore(chore, date, assignee).then((ok) => ok && toast(`Added ${chore.title} to ${formatLongDay(date)}`, "success"));
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold text-muted">
          Adding to <span className="font-extrabold text-ink">{formatLongDay(date)}</span>
        </p>
        {partner && (
          <Segmented
            label="Assign to"
            value={assignee}
            onChange={onAssign}
            options={[me, partner].map((m) => ({
              value: m.id,
              label: (
                <>
                  <Avatar name={m.display_name} tone={tone(m.id)} size={22} />
                  {m.id === me.id ? "Me" : m.display_name}
                </>
              ),
            }))}
          />
        )}
      </div>

      {recent.length > 0 && (
        <section aria-labelledby="recent-h">
          <h3 id="recent-h" className="mb-2 text-xs font-extrabold uppercase tracking-wide text-muted">
            Recent
          </h3>
          <div className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5 pb-1">
            {recent.map((c) => (
              <Pill key={c.id} chore={c} onPick={pick} />
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
              <Pill key={c.id} chore={c} onPick={pick} />
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
              <Pill key={c.id} chore={c} onPick={pick} onDelete={setPendingDelete} />
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

/** Docked at the bottom of the sheet: type a name, set points + duration, add. */
function NewChoreInput({ date, assignee, onDone }: { date: string; assignee: string; onDone: () => void }) {
  const { actions } = useHousehold();
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [points, setPoints] = useState(5);
  const [minutes, setMinutes] = useState(15);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const name = title.trim();
    if (!name) return;
    onDone();
    void actions
      .createAndScheduleChore({ title: name, points, minutes }, date, assignee)
      .then((ok) => ok && toast(`Added ${name} to ${formatLongDay(date)}`, "success"));
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5">
      <div className="flex gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={60}
          placeholder="Add a new chore..."
          aria-label="New chore name"
          enterKeyHint="done"
          className={fieldClass}
        />
        <button
          type="submit"
          disabled={!title.trim()}
          aria-label="Add chore"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand text-brand-ink disabled:opacity-40"
        >
          <Icon name="plus" size={24} strokeWidth={2.5} />
        </button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Stepper label="points" value={points} min={1} max={10} onChange={setPoints} />
          <span className="text-xs font-bold text-muted">pts</span>
        </div>
        <div className="flex items-center gap-1">
          <Stepper label="minutes" value={minutes} min={5} max={240} step={5} onChange={setMinutes} />
          <span className="text-xs font-bold text-muted">min</span>
        </div>
      </div>
    </form>
  );
}
