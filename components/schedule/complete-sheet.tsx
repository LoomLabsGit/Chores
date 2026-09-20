"use client";

import { useState } from "react";
import { formatLongDay } from "@/lib/logic/dates";
import {
  calculateBasePoints,
  calculateSplit,
  choreTotal,
  COMPLETION_STEPS,
  estimatePoints,
  snapMinutes,
} from "@/lib/logic/points";
import { useHousehold } from "@/lib/store/household-store";
import type { ChoreInstance } from "@/lib/types";
import { Icon } from "../icons";
import { useToast } from "../toast";
import { Avatar, primaryButton } from "../ui/controls";
import { DurationField, SplitControl } from "../ui/points-controls";
import { Modal } from "../ui/modal";

export function CompleteSheet({
  instance,
  onClose,
  onEdit,
  onRemove,
}: {
  instance: ChoreInstance | null;
  onClose: () => void;
  onEdit: (i: ChoreInstance) => void;
  /** Deleting goes through the schedule's own flow, which asks "just this one" or "all" for repeating chores. */
  onRemove: (i: ChoreInstance) => void;
}) {
  return (
    <Modal open={!!instance} onClose={onClose} title={instance?.title ?? "Complete chore"} variant="sheet">
      {instance && <CompleteForm key={instance.id} instance={instance} onClose={onClose} onEdit={onEdit} onRemove={onRemove} />}
    </Modal>
  );
}

function CompleteForm({
  instance,
  onClose,
  onEdit,
  onRemove,
}: {
  instance: ChoreInstance;
  onClose: () => void;
  onEdit: (i: ChoreInstance) => void;
  onRemove: (i: ChoreInstance) => void;
}) {
  const { me, partner, state, tone, nameOf, actions } = useHousehold();
  const { toast } = useToast();

  // Starts at the estimate; the real time you log is what the points are worked out from.
  const [minutes, setMinutes] = useState(snapMinutes(instance.estimated_duration));
  const [split, setSplit] = useState(false);
  const [ownerPct, setOwnerPct] = useState(50);
  const [busy, setBusy] = useState(false);

  // Points go to whoever the chore is assigned to, not to whoever taps Complete.
  // An unassigned chore is claimed by you. The split slider always runs owner -> other.
  const ownerIsMe = !instance.assigned_to || instance.assigned_to === me.id;
  const owner = ownerIsMe ? me : (partner ?? me);
  const other = ownerIsMe ? partner : me;
  const ownerTone = tone(owner.id);
  const otherTone = other ? tone(other.id) : ownerTone === "a" ? "b" : "a";

  const pct = split ? ownerPct : 100;
  // A fixed bounty (a "mission") pays the same whatever the time; the minutes are only saved for Stats.
  const mission = instance.pricing_type === "fixed_bounty";
  const base = calculateBasePoints(minutes);
  const total = choreTotal(minutes, instance);
  const result = calculateSplit(minutes, total, pct); // a = owner, b = the other person
  const myPoints = ownerIsMe ? result.a.points : result.b.points;

  async function complete() {
    setBusy(true);
    onClose(); // optimistic: the card flips to done immediately
    const ok = await actions.completeChore(instance, minutes, pct);
    if (!ok) return;
    if (myPoints > 0) toast(`Nice work! +${myPoints} pt${myPoints === 1 ? "" : "s"}`, "points");
    else if (other) {
      // The caller earned nothing (a 0% share, or someone else's chore): say who did.
      const earner = ownerIsMe ? { name: other.display_name, pts: result.b.points } : { name: owner.display_name, pts: result.a.points };
      toast(`Logged. ${earner.name} earns ${earner.pts} pts`, "success");
    }
    else toast("Logged", "success");
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="-mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-semibold text-muted">
        <span className="flex items-center gap-1 text-gold">
          <Icon name="bolt" size={14} />
          {estimatePoints(instance)} pts {mission ? "fixed" : "est."}
        </span>
        <span>{formatLongDay(instance.scheduled_date)}</span>
        <span>{instance.assigned_to ? `Assigned to ${nameOf(instance.assigned_to)}` : "Unassigned"}</span>
      </p>

      <section aria-labelledby="duration-label" className="flex flex-col gap-2.5">
        <div>
          <label id="duration-label" htmlFor="duration" className="text-sm font-extrabold">
            How long did it take?
          </label>
          {mission && <p className="text-xs font-semibold text-muted">Only saved for your stats. It doesn&rsquo;t change the points.</p>}
        </div>
        <DurationField inputId="duration" value={minutes} onChange={setMinutes} steps={COMPLETION_STEPS} label="Minutes taken" />
      </section>

      <SplitControl
        owner={owner}
        other={other}
        ownerTone={ownerTone}
        otherTone={otherTone}
        enabled={split}
        onToggle={() => setSplit((v) => !v)}
        pct={ownerPct}
        onPct={setOwnerPct}
      />

      <section aria-label="Points breakdown" className="rounded-3xl border border-line bg-raised p-4 text-[15px]">
        {mission ? (
          <>
            <p className="pb-2 text-sm font-bold text-muted">
              Task: <span className="text-ink">{instance.title}</span> (Fixed Mission)
            </p>
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-bold text-muted">Time Logged: {minutes} mins</span>
              <span className="text-xs font-bold text-muted">Saved for stats</span>
            </div>
            <div className="mt-2.5 flex items-baseline justify-between gap-3 border-t border-line pt-2.5">
              <span className="font-extrabold">Fixed Bounty:</span>
              <span className="text-lg font-extrabold tabular-nums text-gold" aria-live="polite">
                {total} Points
              </span>
            </div>
          </>
        ) : (
          <>
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
          </>
        )}
        {!ownerIsMe && !split && (
          <p className="mt-3 border-t border-line pt-3 text-sm font-bold text-muted">
            This is {owner.display_name}&rsquo;s chore, so all {result.a.points} points go to {owner.display_name}.
          </p>
        )}
        {split && partner && (
          <ul className="mt-3 flex flex-col gap-1.5 border-t border-line pt-3 text-sm font-bold" aria-live="polite">
            <li className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2">
                <Avatar name={owner.display_name} tone={ownerTone} size={20} />
                {owner.display_name} ({result.a.pct}%): {result.a.minutes} mins
              </span>
              <span className="tabular-nums">&rarr; {result.a.points} pts</span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2">
                <Avatar name={other?.display_name ?? ""} tone={otherTone} size={20} />
                {other?.display_name} ({result.b.pct}%): {result.b.minutes} mins
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
          <span className="opacity-80">
            {ownerIsMe ? `· +${myPoints} pts` : `· ${owner.display_name} +${result.a.points} pts`}
          </span>
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
            onClick={() => onRemove(instance)}
            className="min-h-11 rounded-2xl text-sm font-bold text-danger hover:bg-danger-soft"
          >
            Remove
          </button>
        </div>
      </div>

    </div>
  );
}
