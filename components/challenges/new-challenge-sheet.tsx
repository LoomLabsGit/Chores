"use client";

import { useState } from "react";
import { useHousehold } from "@/lib/store/household-store";
import { useToast } from "../toast";
import { Avatar, fieldClass, primaryButton, Segmented, Stepper } from "../ui/controls";
import { Modal } from "../ui/modal";

export function NewChallengeSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <Modal open onClose={onClose} title="New challenge" variant="sheet">
      <Form onClose={onClose} />
    </Modal>
  );
}

function Form({ onClose }: { onClose: () => void }) {
  const { me, partner, tone, actions } = useHousehold();
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState(me.id);
  const [target, setTarget] = useState(10);
  const [reward, setReward] = useState(20);
  const [busy, setBusy] = useState(false);

  const toPartner = !!partner && assignee === partner.id;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    const ok = await actions.createChallenge({ title: title.trim(), assignedTo: assignee, target, reward });
    setBusy(false);
    if (!ok) return;
    onClose();
    toast(toPartner ? `Sent to ${partner!.display_name} for approval` : "Challenge started", "success");
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <label className="flex flex-col gap-1.5 text-sm font-extrabold">
        Challenge name
        <input
          data-autofocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={80}
          required
          placeholder="e.g. Go to the gym"
          className={fieldClass}
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <span id="assignee-label" className="text-sm font-extrabold">
          Who is it for?
        </span>
        <Segmented
          label="Assignee"
          value={assignee}
          onChange={setAssignee}
          options={[
            {
              value: me.id,
              label: (
                <>
                  <Avatar name={me.display_name} tone={tone(me.id)} size={22} />
                  Myself
                </>
              ),
            },
            ...(partner
              ? [
                  {
                    value: partner.id,
                    label: (
                      <>
                        <Avatar name={partner.display_name} tone={tone(partner.id)} size={22} />
                        {partner.display_name}
                      </>
                    ),
                  },
                ]
              : []),
          ]}
        />
        {toPartner && (
          <p className="text-xs font-semibold text-muted">
            {partner!.display_name} will get a notification and needs to accept before it starts.
          </p>
        )}
        {!partner && <p className="text-xs font-semibold text-muted">Invite your partner to set challenges for each other.</p>}
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-extrabold">Target repetitions</p>
          <p className="text-xs text-muted">How many times to do it</p>
        </div>
        <Stepper label="target repetitions" value={target} min={1} max={365} onChange={setTarget} />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-extrabold">Reward points</p>
          <p className="text-xs text-muted">Paid out on completion</p>
        </div>
        <Stepper label="reward points" value={reward} min={1} max={500} step={5} onChange={setReward} />
      </div>

      <button type="submit" disabled={busy || !title.trim()} className={`${primaryButton} min-h-14 text-lg`}>
        {toPartner ? "Send challenge" : "Start challenge"}
      </button>
    </form>
  );
}
