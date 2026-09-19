"use client";

import { useMemo, useState } from "react";
import { clampMinutes, computeSplit, DURATION_STEPS } from "@/lib/logic/split";
import { formatLongDay } from "@/lib/logic/dates";
import { useHousehold } from "@/lib/store/household-store";
import type { ChoreInstance } from "@/lib/types";
import { Icon } from "../icons";
import { useToast } from "../toast";
import { Avatar, fieldClass, primaryButton } from "../ui/controls";
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

  const defaultMinutes = useMemo(
    () => state.library.find((c) => c.id === instance.chore_id)?.default_duration ?? 15,
    [state.library, instance.chore_id],
  );
  const [minutes, setMinutes] = useState(defaultMinutes);
  const [split, setSplit] = useState(false);
  const [myPct, setMyPct] = useState(50);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const pct = split ? myPct : 100;
  const result = computeSplit(minutes, instance.points_assigned, pct);
  const myTone = tone(me.id);
  const partnerTone = partner ? tone(partner.id) : myTone === "a" ? "b" : "a";

  const bump = (delta: number) => setMinutes((m) => clampMinutes(m + delta));

  async function complete() {
    setBusy(true);
    onClose(); // optimistic: the card flips to done immediately
    const ok = await actions.completeChore(instance, minutes, pct);
    if (!ok) return;
    if (result.me.points > 0) toast(`Nice work! +${result.me.points} pt${result.me.points === 1 ? "" : "s"}`, "points");
    else if (partner) toast(`Logged. ${partner.display_name} earns ${result.partner.points} pts`, "success");
    else toast("Logged", "success");
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="-mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-semibold text-muted">
        <span className="flex items-center gap-1 text-gold">
          <Icon name="star" size={14} />
          {instance.points_assigned} pts
        </span>
        <span>{formatLongDay(instance.scheduled_date)}</span>
        <span>Assigned to {nameOf(instance.assigned_to)}</span>
      </p>

      <section aria-labelledby="duration-label" className="flex flex-col gap-2.5">
        <div className="flex items-end justify-between gap-3">
          <label id="duration-label" htmlFor="duration" className="text-sm font-extrabold">
            How long did it take?
          </label>
        </div>
        <div className="flex items-center gap-3">
          <input
            id="duration"
            type="number"
            inputMode="numeric"
            min={0}
            max={1440}
            value={minutes}
            onChange={(e) => setMinutes(clampMinutes(e.target.valueAsNumber))}
            onFocus={(e) => e.target.select()}
            className={`${fieldClass} w-28 text-center text-2xl font-extrabold tabular-nums`}
          />
          <span className="text-base font-bold text-muted">minutes</span>
        </div>
        <div className="grid grid-cols-5 gap-2" role="group" aria-label="Subtract minutes">
          {DURATION_STEPS.map((n) => (
            <button
              key={`m${n}`}
              onClick={() => bump(-n)}
              disabled={minutes === 0}
              aria-label={`Subtract ${n} minute${n === 1 ? "" : "s"}`}
              className="min-h-12 rounded-2xl bg-raised text-base font-extrabold text-ink active:scale-95 disabled:opacity-40"
            >
              &minus;{n}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-5 gap-2" role="group" aria-label="Add minutes">
          {DURATION_STEPS.map((n) => (
            <button
              key={`p${n}`}
              onClick={() => bump(n)}
              aria-label={`Add ${n} minute${n === 1 ? "" : "s"}`}
              className="min-h-12 rounded-2xl bg-brand-soft text-base font-extrabold text-brand active:scale-95"
            >
              +{n}
            </button>
          ))}
        </div>
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
            <p className="text-center text-[13px] font-bold leading-snug" aria-live="polite">
              <span>
                {me.display_name}: {result.me.pct}% ({result.me.minutes}m, {result.me.points} pts)
              </span>
              <span className="mx-1.5 text-muted">|</span>
              <span>
                {partner.display_name}: {result.partner.pct}% ({result.partner.minutes}m, {result.partner.points} pts)
              </span>
            </p>
          </div>
        )}
      </section>

      <div className="flex flex-col gap-2">
        <button onClick={complete} disabled={busy} className={`${primaryButton} min-h-14 w-full text-lg`}>
          <Icon name="check" strokeWidth={3} />
          Complete
          {!split && <span className="opacity-80">· +{instance.points_assigned} pts</span>}
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
