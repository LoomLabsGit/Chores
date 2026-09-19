"use client";

import { useState } from "react";
import { addDays, formatLongDay } from "@/lib/logic/dates";
import { useHousehold } from "@/lib/store/household-store";
import type { ChoreInstance } from "@/lib/types";
import { useToast } from "../toast";
import { fieldClass, primaryButton } from "../ui/controls";
import { Modal } from "../ui/modal";

const SHIFTS = [
  { label: "−1 week", days: -7 },
  { label: "−1 day", days: -1 },
  { label: "+1 day", days: 1 },
  { label: "+1 week", days: 7 },
];

/** "Change date" from the ... menu: works for finished and unfinished chores, on phone and desktop. */
export function DateSheet({
  instance,
  onClose,
  onMoved,
}: {
  instance: ChoreInstance | null;
  onClose: () => void;
  /** Called with the new day so the calendar can jump to that week. */
  onMoved: (date: string) => void;
}) {
  if (!instance) return null;
  return (
    <Modal open onClose={onClose} title="Change date" variant="sheet">
      <DateForm key={instance.id} instance={instance} onClose={onClose} onMoved={onMoved} />
    </Modal>
  );
}

function DateForm({
  instance,
  onClose,
  onMoved,
}: {
  instance: ChoreInstance;
  onClose: () => void;
  onMoved: (date: string) => void;
}) {
  const { actions } = useHousehold();
  const { toast } = useToast();
  const [date, setDate] = useState(instance.scheduled_date);
  const [busy, setBusy] = useState(false);
  const unchanged = date === instance.scheduled_date;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!date) return;
    if (unchanged) return onClose();
    setBusy(true);
    const ok = instance.is_completed
      ? // Finished chores go through the server function that leaves points and time untouched.
        await actions.editChore(instance, {
          title: instance.title,
          minutes: instance.estimated_duration,
          tax: instance.chore_tax,
          assignedTo: instance.assigned_to,
          date,
          repeat: "none",
          scope: "this",
        })
      : await actions.moveInstance(instance.id, { scheduled_date: date });
    setBusy(false);
    if (!ok) return;
    onClose();
    onMoved(date);
    toast(`Moved ${instance.title} to ${formatLongDay(date)}`, "success");
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <div className="rounded-2xl bg-raised p-4">
        <p className="text-lg font-extrabold leading-snug">{instance.title}</p>
        <p className="mt-0.5 text-sm font-semibold text-muted">
          {instance.is_completed ? "Done" : "Planned"} on {formatLongDay(instance.scheduled_date)}
        </p>
      </div>

      <label className="flex flex-col gap-1.5 text-sm font-extrabold">
        New date
        <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className={fieldClass} />
        <span className="text-xs font-semibold text-muted">{date ? formatLongDay(date) : "Choose a day"}</span>
      </label>

      <div className="grid grid-cols-4 gap-2" role="group" aria-label="Shift the date">
        {SHIFTS.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => date && setDate(addDays(date, s.days))}
            className="min-h-12 rounded-2xl bg-raised text-sm font-extrabold active:scale-95"
          >
            {s.label}
          </button>
        ))}
      </div>

      <button type="submit" disabled={busy || !date} className={`${primaryButton} min-h-14 text-lg`}>
        {busy ? "Moving…" : unchanged ? "Done" : "Move chore"}
      </button>
    </form>
  );
}
