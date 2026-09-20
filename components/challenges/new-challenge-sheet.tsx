"use client";

import { useState } from "react";
import { jointHalf } from "@/lib/logic/challenges";
import { formatLongDay, todayISO } from "@/lib/logic/dates";
import { useHousehold } from "@/lib/store/household-store";
import type { Challenge, ChallengeType } from "@/lib/types";
import { Icon } from "../icons";
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

/**
 * Edit a challenge: name, how many times, the reward or penalty, the deadline and (for an individual one) who it
 * is for. Its kind (reward / forfeit) and scope (individual / joint) are fixed; payouts follow for a finished one.
 */
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
  const [type, setType] = useState<ChallengeType>(challenge?.type ?? "reward");
  const [joint, setJoint] = useState(challenge?.is_joint ?? false);
  const [assignee, setAssignee] = useState(challenge?.assigned_to ?? me.id);
  const [target, setTarget] = useState(challenge?.target_count ?? 10);
  const [reward, setReward] = useState(challenge?.reward_points || 20);
  const [penalty, setPenalty] = useState(challenge?.penalty_points || 10);
  const [deadline, setDeadline] = useState(challenge?.deadline_date ?? "");
  const [busy, setBusy] = useState(false);

  const today = todayISO();
  const editing = !!challenge;
  const forfeit = type === "forfeit";
  const finished = challenge?.status === "completed";
  const reassigned = editing && !joint && assignee !== challenge.assigned_to;
  const toPartner = !!partner && !joint && assignee === partner.id;
  const rewardChange = finished ? (joint ? jointHalf(reward) - jointHalf(challenge.reward_points) : reward - challenge.reward_points) : 0;
  const whoName = joint ? "you both" : assignee === me.id ? "you" : nameOf(assignee);
  const deadlineOk = !forfeit || !!deadline;
  const canSave = !!title.trim() && deadlineOk && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    const common = {
      title: title.trim(),
      target,
      reward: forfeit ? 0 : reward,
      assignedTo: joint ? me.id : assignee,
      deadline: deadline || null,
      penalty: forfeit ? penalty : 0,
    };
    if (!challenge) {
      const ok = await actions.createChallenge({ ...common, type, joint });
      setBusy(false);
      if (!ok) return;
      onClose();
      toast(
        joint
          ? `Joint challenge started. ${partner?.display_name ?? "Your partner"} can log progress too`
          : toPartner
            ? `Sent to ${partner!.display_name} for approval`
            : forfeit
              ? "Forfeit challenge started. Hold the line!"
              : "Challenge started",
        "success",
      );
      return;
    }
    const row = await actions.updateChallenge(challenge.id, common);
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
          placeholder={forfeit ? "e.g. Put the washing away before bed" : "e.g. Go to the gym"}
          className={fieldClass}
        />
      </label>

      {/* What kind, and for whom. Both are fixed once it exists (delete and re-create to change them). */}
      {editing ? (
        <div className="flex flex-wrap items-center gap-2 text-xs font-extrabold">
          <span className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 ${forfeit ? "bg-warn-soft text-warn" : "bg-gold-soft text-gold"}`}>
            <Icon name={forfeit ? "shield" : "star"} size={14} />
            {forfeit ? "Forfeit" : "Reward"}
          </span>
          <span className="flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5 text-muted">
            <Icon name="users" size={14} />
            {joint ? "Joint" : "Individual"}
          </span>
          <span className="font-semibold text-muted">Fixed once created</span>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-extrabold">Type</span>
            <Segmented
              label="Challenge type"
              value={type}
              onChange={(t) => {
                setType(t);
                if (t === "forfeit") setJoint(false); // a forfeit docks points, so it is for one person
              }}
              options={[
                { value: "reward", label: <><Icon name="star" size={16} />Reward</> },
                { value: "forfeit", label: <><Icon name="shield" size={16} />Forfeit</> },
              ]}
            />
            <p className="text-xs font-semibold text-muted">
              {forfeit
                ? "Hold the line: do it enough times before the deadline, or lose points. Nothing is earned for succeeding."
                : "Earn points when you reach the target."}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-extrabold">Who</span>
            <Segmented
              label="Challenge scope"
              value={joint ? "joint" : "individual"}
              onChange={(v) => setJoint(v === "joint")}
              options={[
                { value: "individual", label: <>Individual</> },
                { value: "joint", label: <><Icon name="users" size={16} />Joint</>, disabled: forfeit || !partner },
              ]}
            />
            <p className="text-xs font-semibold text-muted">
              {forfeit
                ? "A forfeit is for one person, because it can dock points."
                : !partner
                  ? "Invite your partner to set a joint challenge."
                  : joint
                    ? `Starts straight away for both of you. Either can log progress, and the reward is shared 50/50 (${jointHalf(reward)} pts each).`
                    : "Just one of you."}
            </p>
          </div>
        </>
      )}

      {!joint && (
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
      )}

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
                : forfeit
                  ? "How many times before the deadline"
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

      {forfeit ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-warn/40 bg-warn-soft/50 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-extrabold text-warn">Penalty points</p>
              <p className="text-xs font-semibold text-muted">Docked from {whoName} if the target is missed. Never below 0.</p>
            </div>
            <Stepper label="penalty points" value={penalty} min={1} max={500} step={5} onChange={setPenalty} />
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-extrabold">Reward points</p>
            <p className="text-xs text-muted">
              {finished && rewardChange !== 0
                ? `${joint ? "Each balance" : `${nameOf(assignee)}'s balance`} changes by ${rewardChange > 0 ? "+" : "−"}${Math.abs(rewardChange)} pts`
                : finished
                  ? "Already paid out. Changing it adjusts the balance"
                  : joint
                    ? `Paid out on completion, ${jointHalf(reward)} pts to each of you`
                    : "Paid out on completion"}
            </p>
          </div>
          <Stepper label="reward points" value={reward} min={1} max={500} step={5} onChange={setReward} />
        </div>
      )}

      {!finished && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="challenge-deadline" className="text-sm font-extrabold">
            Deadline {forfeit ? <span className="text-warn">(required)</span> : <span className="font-medium text-muted">(optional)</span>}
          </label>
          <div className="flex items-center gap-2">
            <input
              id="challenge-deadline"
              type="date"
              min={editing && challenge.deadline_date && challenge.deadline_date < today ? challenge.deadline_date : today}
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              required={forfeit}
              className={fieldClass}
            />
            {!forfeit && deadline && (
              <button
                type="button"
                onClick={() => setDeadline("")}
                aria-label="Clear the deadline"
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-raised text-muted hover:text-ink"
              >
                <Icon name="x" size={18} />
              </button>
            )}
          </div>
          <p className="text-xs font-semibold text-muted" aria-live="polite">
            {forfeit && deadline
              ? `Judged at midnight at the end of ${formatLongDay(deadline)}. Reach ${target} by then or lose ${penalty} pts.`
              : deadline
                ? `Runs out at the end of ${formatLongDay(deadline)}. Nothing is lost if it is missed.`
                : forfeit
                  ? "Choose the day it is judged."
                  : "No deadline: it stays open until it is done."}
          </p>
        </div>
      )}

      <button type="submit" disabled={!canSave} className={`${primaryButton} min-h-14 text-lg`}>
        {editing ? "Save changes" : joint ? "Start together" : toPartner ? "Send challenge" : forfeit ? "Start forfeit" : "Start challenge"}
      </button>
    </form>
  );
}
