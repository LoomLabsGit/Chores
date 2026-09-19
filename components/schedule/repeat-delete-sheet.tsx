"use client";

import { useEffect, useState } from "react";
import { formatLongDay } from "@/lib/logic/dates";
import { useHousehold } from "@/lib/store/household-store";
import type { ChoreInstance } from "@/lib/types";
import { useToast } from "../toast";
import { Icon } from "../icons";
import { Modal } from "../ui/modal";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * Deleting one day of a repeating chore asks what you mean: just this day, or all of them.
 * "All" removes every unfinished day and stops the chore repeating; finished days are kept.
 */
export function RepeatDeleteSheet({ instance, onClose }: { instance: ChoreInstance | null; onClose: () => void }) {
  if (!instance) return null;
  return (
    <Modal open onClose={onClose} title="Delete repeating chore?" variant="center">
      <Choice key={instance.id} instance={instance} onClose={onClose} />
    </Modal>
  );
}

function Choice({ instance, onClose }: { instance: ChoreInstance; onClose: () => void }) {
  const { actions } = useHousehold();
  const { toast } = useToast();
  const [openDays, setOpenDays] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void actions.countOpenInSeries(instance).then((n) => live && setOpenDays(n));
    return () => {
      live = false;
    };
    // The count is only needed once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.id]);

  async function justThis() {
    setBusy(true);
    onClose();
    const ok = await actions.removeInstance(instance.id);
    if (ok) toast(`Deleted ${instance.title} on ${formatLongDay(instance.scheduled_date)}. The other days stay`);
  }

  async function all() {
    setBusy(true);
    const removed = await actions.removeSeries(instance);
    setBusy(false);
    if (removed === null) return;
    onClose();
    toast(`Deleted all ${plural(removed, "day")} of ${instance.title}. It no longer repeats`);
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="flex items-start gap-2.5 text-[15px] leading-relaxed text-muted">
        <span className="mt-0.5 shrink-0 text-brand">
          <Icon name="repeat" size={18} />
        </span>
        <span>
          <strong className="text-ink">{instance.title}</strong> repeats. Do you want to delete just{" "}
          {formatLongDay(instance.scheduled_date)}, or all of it?
        </span>
      </p>
      <div className="flex flex-col gap-2">
        <button
          onClick={justThis}
          disabled={busy}
          data-autofocus
          className="min-h-14 rounded-2xl border border-line px-4 text-left font-bold hover:bg-raised disabled:opacity-50"
        >
          Just this one
          <span className="block text-xs font-semibold text-muted">Only {formatLongDay(instance.scheduled_date)}. Every other day stays.</span>
        </button>
        <button
          onClick={all}
          disabled={busy}
          className="min-h-14 rounded-2xl bg-danger px-4 text-left font-bold text-white disabled:opacity-50"
        >
          All{openDays !== null ? ` ${plural(openDays, "unfinished day")}` : ""}
          <span className="block text-xs font-semibold opacity-90">
            Removes every unfinished day and stops it repeating. Finished days are kept.
          </span>
        </button>
        <button onClick={onClose} disabled={busy} className="min-h-12 rounded-2xl px-4 font-bold text-muted hover:bg-raised disabled:opacity-50">
          Cancel
        </button>
      </div>
    </div>
  );
}
