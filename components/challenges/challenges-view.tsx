"use client";

import { useState } from "react";
import { pendingProposals } from "@/lib/logic/notifications";
import { useHousehold } from "@/lib/store/household-store";
import type { Challenge } from "@/lib/types";
import { Icon } from "../icons";
import { useToast } from "../toast";
import { Avatar, EmptyState, primaryButton } from "../ui/controls";
import { NewChallengeSheet } from "./new-challenge-sheet";
import { ProgressRing } from "./progress-ring";

export function ChallengesView() {
  const { me, state } = useHousehold();
  const [creating, setCreating] = useState(false);

  const mine = (c: Challenge) => c.assigned_to === me.id;
  const proposals = pendingProposals(state.challenges, me.id);
  const active = state.challenges.filter((c) => c.status === "active").sort((a, b) => Number(mine(b)) - Number(mine(a)));
  const sent = state.challenges.filter(
    (c) => c.creator_id === me.id && c.assigned_to !== me.id && (c.status === "pending" || c.status === "rejected"),
  );
  const completed = state.challenges.filter((c) => c.status === "completed").slice(0, 6);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-extrabold tracking-tight">Challenges</h1>
        <button onClick={() => setCreating(true)} className={`${primaryButton} min-h-11 px-4`}>
          <Icon name="plus" size={20} strokeWidth={2.6} />
          New
        </button>
      </div>

      {proposals.length > 0 && (
        <section aria-label="Proposals for you" className="flex flex-col gap-3">
          <h2 className="text-xs font-extrabold uppercase tracking-wide text-muted">Waiting for your reply</h2>
          {proposals.map((c) => (
            <ProposalCard key={c.id} challenge={c} />
          ))}
        </section>
      )}

      <section aria-label="Active challenges" className="flex flex-col gap-3">
        <h2 className="text-xs font-extrabold uppercase tracking-wide text-muted">Active</h2>
        {active.length === 0 ? (
          <EmptyState icon={<Icon name="trophy" size={26} />} title="No active challenges">
            Set yourself a habit (&ldquo;Gym 12 times&rdquo;) or challenge your partner. Every tap counts toward a points reward.
          </EmptyState>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {active.map((c) => (
              <ChallengeCard key={c.id} challenge={c} />
            ))}
          </div>
        )}
      </section>

      {sent.length > 0 && (
        <section aria-label="Sent to your partner" className="flex flex-col gap-2">
          <h2 className="text-xs font-extrabold uppercase tracking-wide text-muted">Sent to partner</h2>
          {sent.map((c) => (
            <SentRow key={c.id} challenge={c} />
          ))}
        </section>
      )}

      {completed.length > 0 && (
        <section aria-label="Completed challenges" className="flex flex-col gap-2">
          <h2 className="text-xs font-extrabold uppercase tracking-wide text-muted">Completed</h2>
          <ul className="flex flex-col gap-2">
            {completed.map((c) => (
              <CompletedRow key={c.id} challenge={c} />
            ))}
          </ul>
        </section>
      )}

      <NewChallengeSheet open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function ChallengeCard({ challenge: c }: { challenge: Challenge }) {
  const { me, tone, nameOf, actions } = useHousehold();
  const { toast, celebrate } = useToast();
  const mine = c.assigned_to === me.id;

  async function tap() {
    const result = await actions.incrementChallenge(c.id);
    if (result === "completed") {
      celebrate();
      toast(`Challenge complete! +${c.reward_points} pts`, "points");
    }
  }

  const body = (
    <>
      <ProgressRing challenge={c} tone={tone(c.assigned_to)} />
      <div className="min-w-0 flex-1 text-left">
        <p className="line-clamp-2 text-base font-extrabold leading-snug">{c.title}</p>
        <p className="mt-1 flex items-center gap-1.5 text-xs font-bold text-muted">
          <Avatar name={nameOf(c.assigned_to)} tone={tone(c.assigned_to)} size={18} />
          {mine ? "You" : nameOf(c.assigned_to)}
          <span aria-hidden>·</span>
          <span className="flex items-center gap-0.5 text-gold">
            <Icon name="star" size={11} />
            {c.reward_points}
          </span>
        </p>
        <p className="mt-2 text-xs font-bold text-muted">{mine ? "Tap to log one" : "Their challenge"}</p>
      </div>
    </>
  );

  const cls = "flex min-h-28 items-center gap-4 rounded-3xl border border-line bg-surface p-4 shadow-card";

  return mine ? (
    <button
      onClick={tap}
      aria-label={`Log progress for ${c.title}. ${c.current_count} of ${c.target_count} done.`}
      className={`${cls} w-full transition-transform active:scale-[0.98]`}
    >
      {body}
    </button>
  ) : (
    <article className={cls}>{body}</article>
  );
}

function ProposalCard({ challenge: c }: { challenge: Challenge }) {
  const { nameOf, actions } = useHousehold();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function respond(accept: boolean) {
    setBusy(true);
    const ok = await actions.respondToChallenge(c.id, accept);
    setBusy(false);
    if (ok) toast(accept ? "Challenge accepted. Good luck!" : "Challenge declined", accept ? "success" : "info");
  }

  return (
    <article className="rounded-3xl border border-brand/30 bg-brand-soft p-4">
      <p className="text-sm font-semibold text-muted">{nameOf(c.creator_id)} set a challenge for you</p>
      <p className="mt-0.5 text-lg font-extrabold">{c.title}</p>
      <p className="mt-1 text-sm text-muted">
        {c.target_count} {c.target_count === 1 ? "time" : "times"} · <span className="font-bold text-gold">+{c.reward_points} pts</span>
      </p>
      <div className="mt-3 flex gap-2">
        <button
          disabled={busy}
          onClick={() => respond(false)}
          className="min-h-12 flex-1 rounded-2xl border border-line bg-surface font-bold disabled:opacity-50"
        >
          Decline
        </button>
        <button disabled={busy} onClick={() => respond(true)} className={`${primaryButton} flex-1`}>
          Accept
        </button>
      </div>
    </article>
  );
}

function SentRow({ challenge: c }: { challenge: Challenge }) {
  const { nameOf } = useHousehold();
  const declined = c.status === "rejected";
  return (
    <div className="flex min-h-14 items-center gap-3 rounded-2xl bg-raised px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate font-bold">{c.title}</p>
        <p className="text-xs text-muted">For {nameOf(c.assigned_to)}</p>
      </div>
      <span
        className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-extrabold ${declined ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn"}`}
      >
        {declined ? "Declined" : "Awaiting reply"}
      </span>
    </div>
  );
}

function CompletedRow({ challenge: c }: { challenge: Challenge }) {
  const { nameOf } = useHousehold();
  return (
    <li className="flex min-h-14 items-center gap-3 rounded-2xl bg-raised px-4 py-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ok text-white">
        <Icon name="check" size={16} strokeWidth={3} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-bold">{c.title}</p>
        <p className="text-xs text-muted">
          {nameOf(c.assigned_to)} · {c.target_count} {c.target_count === 1 ? "time" : "times"}
        </p>
      </div>
      <span className="shrink-0 text-sm font-extrabold text-gold">+{c.reward_points} pts</span>
    </li>
  );
}
