"use client";

import { useState } from "react";
import { timeAgo } from "@/lib/logic/dates";
import { useHousehold } from "@/lib/store/household-store";
import type { Reward } from "@/lib/types";
import { Icon } from "../icons";
import { useToast } from "../toast";
import { Avatar, EmptyState, fieldClass, primaryButton, secondaryButton, Stepper } from "../ui/controls";
import { ConfirmDialog, Modal } from "../ui/modal";

export function ShopView() {
  const { me, partner, state, nameOf, tone, actions } = useHousehold();
  const [adding, setAdding] = useState(false);
  const [retiring, setRetiring] = useState<Reward | null>(null);

  const rewards = state.rewards.filter((r) => r.is_active).sort((a, b) => a.cost - b.cost);
  const admin = state.members.find((m) => m.is_admin);
  const rewardTitle = (id: string | null) => state.rewards.find((r) => r.id === id)?.title ?? "A reward";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-extrabold tracking-tight">Rewards</h1>
        {me.is_admin && (
          <button onClick={() => setAdding(true)} className={`${primaryButton} min-h-11 px-4`}>
            <Icon name="plus" size={20} strokeWidth={2.6} />
            Add
          </button>
        )}
      </div>

      <section
        aria-label="Your balance"
        className="flex items-center gap-4 rounded-3xl bg-gold-soft p-5 text-gold"
      >
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-surface/70">
          <Icon name="star" size={30} />
        </span>
        <div>
          <p className="text-sm font-bold opacity-80">You have</p>
          <p className="text-3xl font-extrabold leading-none">
            <span key={me.points} className="anim-pop inline-block">
              {me.points}
            </span>{" "}
            <span className="text-lg">pts</span>
          </p>
        </div>
        {partner && (
          <p className="ml-auto text-right text-xs font-bold opacity-80">
            {partner.display_name}
            <br />
            <span className="text-base font-extrabold">{partner.points} pts</span>
          </p>
        )}
      </section>

      {rewards.length === 0 ? (
        <EmptyState icon={<Icon name="gift" size={26} />} title="No rewards yet">
          {me.is_admin
            ? "Add the first reward your household can spend points on."
            : `Ask ${admin?.display_name ?? "the household admin"} to add some rewards.`}
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rewards.map((r) => (
            <RewardCard key={r.id} reward={r} onRetire={me.is_admin ? () => setRetiring(r) : undefined} />
          ))}
        </ul>
      )}

      {state.redemptions.length > 0 && (
        <section aria-label="Recent redemptions" className="flex flex-col gap-2">
          <h2 className="text-xs font-extrabold uppercase tracking-wide text-muted">History</h2>
          <ul className="flex flex-col gap-2">
            {state.redemptions.slice(0, 10).map((r) => (
              <li key={r.id} className="flex min-h-14 items-center gap-3 rounded-2xl bg-raised px-4 py-2.5">
                <Avatar name={nameOf(r.redeemed_by)} tone={tone(r.redeemed_by)} size={30} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold">{rewardTitle(r.reward_id)}</p>
                  <p className="text-xs text-muted">
                    {r.redeemed_by === me.id ? "You" : nameOf(r.redeemed_by)} · {timeAgo(r.created_at)}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-extrabold tabular-nums text-muted">&minus;{r.cost} pts</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <AddRewardSheet open={adding} onClose={() => setAdding(false)} />
      <ConfirmDialog
        open={!!retiring}
        title="Retire this reward?"
        message={`"${retiring?.title}" will disappear from the shop. Past redemptions stay in the history.`}
        confirmLabel="Retire"
        danger
        onCancel={() => setRetiring(null)}
        onConfirm={() => {
          const r = retiring;
          setRetiring(null);
          if (r) void actions.setRewardActive(r.id, false);
        }}
      />
    </div>
  );
}

function RewardCard({ reward, onRetire }: { reward: Reward; onRetire?: () => void }) {
  const { me, partner, actions } = useHousehold();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const short = reward.cost - me.points;
  const affordable = short <= 0;

  async function redeem() {
    setBusy(true);
    const ok = await actions.redeemReward(reward.id);
    setBusy(false);
    if (ok) {
      toast(partner ? `Redeemed ${reward.title}! ${partner.display_name} has been told.` : `Redeemed ${reward.title}!`, "success");
    }
  }

  return (
    <li className="flex flex-col gap-3 rounded-3xl border border-line bg-surface p-4 shadow-card">
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-lg font-extrabold leading-snug">{reward.title}</h3>
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-gold-soft px-2.5 py-1 text-sm font-extrabold text-gold">
            <Icon name="star" size={13} />
            {reward.cost}
          </span>
        </div>
        {reward.description && <p className="mt-1 text-sm text-muted">{reward.description}</p>}
      </div>
      <button
        onClick={redeem}
        disabled={!affordable || busy}
        className={`${affordable ? primaryButton : secondaryButton} w-full`}
      >
        {affordable ? "Redeem" : `${short} more pts to go`}
      </button>
      {onRetire && (
        <button onClick={onRetire} className="-mb-1 min-h-11 self-center text-xs font-bold text-muted hover:text-danger">
          Retire reward
        </button>
      )}
    </li>
  );
}

function AddRewardSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <Modal open onClose={onClose} title="New reward" variant="sheet">
      <AddRewardForm onClose={onClose} />
    </Modal>
  );
}

function AddRewardForm({ onClose }: { onClose: () => void }) {
  const { actions } = useHousehold();
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [cost, setCost] = useState(50);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    const ok = await actions.addReward({ title, description, cost });
    setBusy(false);
    if (ok) {
      onClose();
      toast("Reward added", "success");
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <label className="flex flex-col gap-1.5 text-sm font-extrabold">
        Reward
        <input
          data-autofocus
          required
          maxLength={60}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. 10 min massage"
          className={fieldClass}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-extrabold">
        <span>
          Details <span className="font-medium text-muted">(optional)</span>
        </span>
        <input
          maxLength={120}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Anything to add?"
          className={fieldClass}
        />
      </label>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-extrabold">Cost</p>
        <Stepper label="cost in points" value={cost} min={1} max={2000} step={5} unit=" pts" onChange={setCost} />
      </div>
      <button type="submit" disabled={busy || !title.trim()} className={`${primaryButton} min-h-14 text-lg`}>
        Add reward
      </button>
    </form>
  );
}
