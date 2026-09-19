"use client";

import { useState } from "react";
import { useHousehold } from "@/lib/store/household-store";
import type { Challenge } from "@/lib/types";
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

/** Edit a challenge: name, how many times, the reward and who it is for. Payouts follow for a finished one. */
export function EditChallengeSheet({ challenge, onClose }: { challenge: Challenge | null; onClose: () => void }) {
  if (!challenge) return null;
  return (
    <Modal open onClose={onClose} title="Edit challenge" variant="sheet">
      <Form key={challenge.id} challenge={challenge} onClose={onClose} />
    </Modal>
  );
}

function Form({ challenge, onClose }: { challenge?: Challenge; onClose: () => void }) {
  const { me, partner, tone, nameOf, actions } = useHousehold();
  const { toast } = useToast();
  const [title, setTitle] = useState(challenge?.title ?? "");
  const [assignee, setAssignee] = useState(challenge?.assigned_to ?? me.id);
  const [target, setTarget] = useState(challenge?.target_count ?? 10);
  const [reward, setReward] = useState(challenge?.reward_points ?? 20);
  const [busy, setBusy] = useState(false);

  const editing = !!challenge;
  const finished = challenge?.status === "completed";
  const reassigned = editing && assignee !== challenge.assigned_to;
  const toPartner = !!partner && assignee === partner.id;
  const rewardChange = finished ? reward - challenge.reward_points : 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    if (!challenge) {
      const ok = await actions.createChallenge({ title: title.trim(), assignedTo: assignee, target, reward });
      setBusy(false);
      if (!ok) return;
      onClose();
      toast(toPartner ? `Sent to ${partner!.display_name} for approval` : "Challenge started", "success");
      return;
    }
    const row = await actions.updateChallenge(challenge.id, { title: title.trim(), target, reward, assignedTo: assignee });
    setBusy(false);
    if (!row) return;
    onClose();
    if (finished && (rewardChange !== 0 || reassigned)) toast("Saved. Balances updated to match", "points");
    else if (reassigned && row.status === "pending") toast(`Sent to ${nameOf(assignee)} for approval`, "success");
    else if (row.status === "completed" && challenge.status !== "completed") toast(`Challenge complete! +${row.reward_points} pts`, "points");
    else toast("Saved", "success");
  }

  const people = [
    { id: me.id, name: "Myself" },
    ...(partner ? [{ id: partner.id, name: partner.display_name }] : []),
  ];

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <label className="flex flex-col gap-1.5 text-sm font-extrabold">
        Challenge name
        <input
          data-autofocus={!editing || undefined}
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
          options={people.map((p) => ({
            value: p.id,
            label: (
              <>
                <Avatar name={p.id === me.id ? me.display_name : p.name} tone={tone(p.id)} size={22} />
                {p.name}
              </>
            ),
          }))}
        />
        {!editing && toPartner && (
          <p className="text-xs font-semibold text-muted">
            {partner!.display_name} will get a notification and needs to accept before it starts.
          </p>
        )}
        {reassigned && !finished && (
          <p className="text-xs font-semibold text-muted">
            {toPartner
              ? `${partner!.display_name} needs to accept it. Progress so far (${challenge.current_count}) is kept.`
              : `It becomes yours straight away. Progress so far (${challenge.current_count}) is kept.`}
          </p>
        )}
        {reassigned && finished && (
          <p className="text-xs font-semibold text-muted">
            The {reward} pts move from {nameOf(challenge.assigned_to)} to {nameOf(assignee)}.
          </p>
        )}
        {!partner && <p className="text-xs font-semibold text-muted">Invite your partner to set challenges for each other.</p>}
      </div>

      {finished ? (
        <div className="flex items-center justify-between gap-3 rounded-2xl bg-raised px-4 py-3">
          <div>
            <p className="text-sm font-extrabold">Target repetitions</p>
            <p className="text-xs font-semibold text-muted">Locked while it is finished. Press &minus; on the challenge to reopen it.</p>
          </div>
          <span className="text-lg font-extrabold tabular-nums">{challenge.target_count}</span>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-extrabold">Target repetitions</p>
            <p className="text-xs text-muted">
              {editing && challenge.current_count > 0
                ? `${challenge.current_count} done so far, so it can't go lower`
                : "How many times to do it"}
            </p>
          </div>
          <Stepper
            label="target repetitions"
            value={target}
            min={Math.max(1, challenge?.current_count ?? 1)}
            max={365}
            onChange={setTarget}
          />
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-extrabold">Reward points</p>
          <p className="text-xs text-muted">
            {finished && rewardChange !== 0
              ? `${nameOf(assignee)}'s balance changes by ${rewardChange > 0 ? "+" : "−"}${Math.abs(rewardChange)} pts`
              : finished
                ? "Already paid out. Changing it adjusts the balance"
                : "Paid out on completion"}
          </p>
        </div>
        <Stepper label="reward points" value={reward} min={1} max={500} step={5} onChange={setReward} />
      </div>

      <button type="submit" disabled={busy || !title.trim()} className={`${primaryButton} min-h-14 text-lg`}>
        {editing ? "Save changes" : toPartner ? "Send challenge" : "Start challenge"}
      </button>
    </form>
  );
}
