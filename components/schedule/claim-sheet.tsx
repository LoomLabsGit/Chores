"use client";

import { useState } from "react";
import { formatLongDay } from "@/lib/logic/dates";
import { choreTotal, ESTIMATE_STEPS } from "@/lib/logic/points";
import { useHousehold } from "@/lib/store/household-store";
import type { ChoreInstance } from "@/lib/types";
import { Icon } from "../icons";
import { useToast } from "../toast";
import { primaryButton, secondaryButton } from "../ui/controls";
import { Modal } from "../ui/modal";
import { BountyField, BountyPreview, DurationField, RewardPreview, TaxField } from "../ui/points-controls";

/**
 * Opens when you tap an unassigned card. Adjust the time estimate and tax if you like, then either
 * claim it (it becomes yours) or complete it right now (which claims it for you at 100% by default).
 */
export function ClaimSheet({
  instance,
  onClose,
  onCompleteNow,
}: {
  instance: ChoreInstance | null;
  onClose: () => void;
  /** Receives the chore with any adjusted estimate/tax, ready for the completion sheet. */
  onCompleteNow: (i: ChoreInstance) => void;
}) {
  if (!instance) return null;
  return (
    <Modal open onClose={onClose} title="Unassigned chore" variant="sheet">
      <ClaimForm key={instance.id} instance={instance} onClose={onClose} onCompleteNow={onCompleteNow} />
    </Modal>
  );
}

function ClaimForm({
  instance,
  onClose,
  onCompleteNow,
}: {
  instance: ChoreInstance;
  onClose: () => void;
  onCompleteNow: (i: ChoreInstance) => void;
}) {
  const { me, actions } = useHousehold();
  const { toast } = useToast();
  const [minutes, setMinutes] = useState(instance.estimated_duration);
  const [tax, setTax] = useState(instance.chore_tax);
  const [bounty, setBounty] = useState(instance.fixed_bounty_points);
  const [busy, setBusy] = useState(false);
  const mission = instance.pricing_type === "fixed_bounty";
  const changed = minutes !== instance.estimated_duration || tax !== instance.chore_tax || bounty !== instance.fixed_bounty_points;
  const adjusted = { estimated_duration: minutes, chore_tax: tax, fixed_bounty_points: bounty };

  async function claim() {
    setBusy(true);
    const ok = await actions.moveInstance(instance.id, { assigned_to: me.id, ...adjusted });
    setBusy(false);
    if (!ok) return;
    onClose();
    toast(`Claimed ${instance.title}. It's worth ${mission ? "" : "about "}${choreTotal(minutes, { ...instance, ...adjusted })} pts`, "success");
  }

  async function completeNow() {
    setBusy(true);
    // Save the adjusted estimate first; completing then claims the chore for you.
    const ok = changed ? await actions.moveInstance(instance.id, adjusted) : true;
    setBusy(false);
    if (!ok) return;
    onClose();
    onCompleteNow({ ...instance, ...adjusted });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-2xl border border-dashed border-muted/50 bg-raised/60 p-4">
        <p className="text-lg font-extrabold leading-snug">{instance.title}</p>
        <p className="mt-0.5 text-sm font-semibold text-muted">
          Nobody has this yet · {formatLongDay(instance.scheduled_date)}
        </p>
      </div>

      {mission ? (
        <>
          <BountyField value={bounty} onChange={setBounty} />
          <BountyPreview bounty={bounty} />
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="claim-minutes" className="text-sm font-extrabold">
              Estimated time
            </label>
            <DurationField inputId="claim-minutes" value={minutes} onChange={setMinutes} steps={ESTIMATE_STEPS} label="Estimated minutes" />
          </div>
          <TaxField value={tax} onChange={setTax} />
          <RewardPreview minutes={minutes} tax={tax} />
        </>
      )}

      <div className="flex flex-col gap-2">
        <button onClick={claim} disabled={busy} className={`${primaryButton} min-h-14 w-full text-lg`}>
          <Icon name="check" strokeWidth={3} />
          Claim Task
        </button>
        <button onClick={completeNow} disabled={busy} className={`${secondaryButton} min-h-12 w-full`}>
          <Icon name="bolt" size={18} />
          Complete Now
        </button>
      </div>
    </div>
  );
}
