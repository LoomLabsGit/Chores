"use client";

import { useState } from "react";
import { formatLongDay } from "@/lib/logic/dates";
import {
  calculateBasePoints,
  calculatePoints,
  calculateSplit,
  COMPLETION_STEPS,
  estimatePoints,
  snapMinutes,
} from "@/lib/logic/points";
import { useHousehold } from "@/lib/store/household-store";
import type { ChoreInstance } from "@/lib/types";
import { Icon } from "../icons";
import { useToast } from "../toast";
import { Avatar, primaryButton } from "../ui/controls";
import { DurationField } from "../ui/points-controls";
import { ConfirmDialog, Modal } from "../ui/modal";

export function CompleteSheet({
  instance,
  onClose,
  onEdit,
}: {
  instance: ChoreInstance | null;
  onClose: () => void;
  onEdit: (i: ChoreInstance) => void;
}) {
  return (
    <Modal open={!!instance} onClose={onClose} title={instance?.title ?? "Complete chore"} variant="sheet">
      {instance && <CompleteForm key={instance.id} instance={instance} onClose={onClose} onEdit={onEdit} />}
    </Modal>
  );
}

function CompleteForm({
  instance,
  onClose,
  onEdit,
}: {
  instance: ChoreInstance;
  onClose: () => void;
  onEdit: (i: ChoreInstance) => void;
}) {
  const { me, partner, state, tone, nameOf, actions } = useHousehold();
  const { toast } = useToast();

  // Starts at the estimate; the real time you log is what the points are worked out from.
  const [minutes, setMinutes] = useState(snapMinutes(instance.estimated_duration));
  const [split, setSplit] = useState(false);
  const [myPct, setMyPct] = useState(50);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const pct = split ? myPct : 100;
  const base = calculateBasePoints(minutes);
  const total = calculatePoints(minutes, instance.chore_tax);
  const result = calculateSplit(minutes, total, pct); // a = you, b = your partner
  const myTone = tone(me.id);
  const partnerTone = partner ? tone(partner.id) : myTone === "a" ? "b" : "a";

  async function complete() {
    setBusy(true);
    onClose(); // optimistic: the card flips to done immediately
    const ok = await actions.completeChore(instance, minutes, pct);
    if (!ok) return;
    if (result.a.points > 0) toast(`Nice work! +${result.a.points} pt${result.a.points === 1 ? "" : "s"}`, "points");
    else if (partner) toast(`Logged. ${partner.display_name} earns ${result.b.points} pts`, "success");
    else toast("Logged", "success");
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="-mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-semibold text-muted">
        <span className="flex items-center gap-1 text-gold">
          <Icon name="bolt" size={14} />
          {estimatePoints(instance)} pts est.
        </span>
        <span>{formatLongDay(instance.scheduled_date)}</span>
        <span>{instance.assigned_to ? `Assigned to ${nameOf(instance.assigned_to)}` : "Unassigned"}</span>
      </p>

      <section aria-labelledby="duration-label" className="flex flex-col gap-2.5">
        <label id="duration-label" htmlFor="duration" className="text-sm font-extrabold">
          How long did it take?
        </label>
        <DurationField inputId="duration" value={minutes} onChange={setMinutes} steps={COMPLETION_STEPS} label="Minutes taken" />
      </section>

      <section className="rounded-3xl border border-line p-4">
        <div className="flex min-h-11 items-center justify-between gap-3">
          <div className="min-w-0">
            <p id="split-label" className="font-extrabold">
              Split effort with partner
            </p>
            {!partner && <p className="text-xs text-muted">Invite your partner to split chores.</p>}
          </div>
          <button
            role="switch"
            aria-checked={split}
            aria-labelledby="split-label"
            disabled={!partner}
            onClick={() => setSplit((s) => !s)}
            className={`relative h-8 w-14 shrink-0 rounded-full transition-colors disabled:opacity-40 ${split ? "bg-brand" : "bg-line"}`}
          >
            <span
              className={`absolute left-0 top-1 h-6 w-6 rounded-full bg-white shadow transition-transform ${split ? "translate-x-7" : "translate-x-1"}`}
            />
          </button>
        </div>

        {split && partner && (
          <div className="mt-3 flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <div className="flex w-12 shrink-0 flex-col items-center gap-0.5">
                <Avatar name={me.display_name} tone={myTone} size={40} />
                <span className="max-w-full truncate text-[11px] font-bold text-muted">{me.display_name}</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={10}
                value={myPct}
                onChange={(e) => setMyPct(Number(e.target.value))}
                aria-label={`${me.display_name}'s share of the effort`}
                aria-valuetext={`${me.display_name} ${myPct} percent, ${partner.display_name} ${100 - myPct} percent`}
                className="split-range flex-1"
                style={
                  {
                    "--fill": `${myPct}%`,
                    "--left": `var(--${myTone})`,
                    "--right": `var(--${partnerTone})`,
                  } as React.CSSProperties
                }
              />
              <div className="flex w-12 shrink-0 flex-col items-center gap-0.5">
                <Avatar name={partner.display_name} tone={partnerTone} size={40} />
                <span className="max-w-full truncate text-[11px] font-bold text-muted">{partner.display_name}</span>
              </div>
            </div>
          </div>
        )}
      </section>

      <section aria-label="Points breakdown" className="rounded-3xl border border-line bg-raised p-4 text-[15px]">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-bold text-muted">Logged: {minutes} mins</span>
          <span className="font-extrabold tabular-nums">{base} Base Pts</span>
        </div>
        <div className="mt-1.5 flex items-baseline justify-between gap-3">
          <span className="font-bold text-muted">Chore Tax:</span>
          <span className="font-extrabold tabular-nums">+{instance.chore_tax} Pts</span>
        </div>
        <div className="mt-2.5 flex items-baseline justify-between gap-3 border-t border-line pt-2.5">
          <span className="font-extrabold">Total Reward:</span>
          <span className="text-lg font-extrabold tabular-nums text-gold" aria-live="polite">
            {total} Points
          </span>
        </div>
        {split && partner && (
          <ul className="mt-3 flex flex-col gap-1.5 border-t border-line pt-3 text-sm font-bold" aria-live="polite">
            <li className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2">
                <Avatar name={me.display_name} tone={myTone} size={20} />
                {me.display_name} ({result.a.pct}%): {result.a.minutes} mins
              </span>
              <span className="tabular-nums">&rarr; {result.a.points} pts</span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2">
                <Avatar name={partner.display_name} tone={partnerTone} size={20} />
                {partner.display_name} ({result.b.pct}%): {result.b.minutes} mins
              </span>
              <span className="tabular-nums">&rarr; {result.b.points} pts</span>
            </li>
          </ul>
        )}
      </section>

      <div className="flex flex-col gap-2">
        <button onClick={complete} disabled={busy} className={`${primaryButton} min-h-14 w-full text-lg`}>
          <Icon name="check" strokeWidth={3} />
          Complete
          <span className="opacity-80">· +{result.a.points} pts</span>
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onEdit(instance)}
            className="flex min-h-11 items-center justify-center gap-1.5 rounded-2xl text-sm font-bold hover:bg-raised"
          >
            <Icon name="pencil" size={16} />
            Edit chore
          </button>
          <button
            onClick={() => setConfirmRemove(true)}
            className="min-h-11 rounded-2xl text-sm font-bold text-danger hover:bg-danger-soft"
          >
            Remove
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title="Remove this chore?"
        message={`"${instance.title}" will be removed from ${formatLongDay(instance.scheduled_date)} only. Any other days stay as they are.`}
        confirmLabel="Remove"
        danger
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false);
          onClose();
          void actions.removeInstance(instance.id);
        }}
      />
    </div>
  );
}
