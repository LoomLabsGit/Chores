"use client";

import { useState } from "react";
import { pendingProposals } from "@/lib/logic/notifications";
import { useHousehold } from "@/lib/store/household-store";
import type { Challenge } from "@/lib/types";
import { Icon } from "../icons";
import { useToast } from "../toast";
import { ActionMenu, type MenuItem } from "../ui/action-menu";
import { Avatar, EmptyState, primaryButton } from "../ui/controls";
import { ConfirmDialog } from "../ui/modal";
import { EditChallengeSheet, NewChallengeSheet } from "./new-challenge-sheet";
import { ProgressRing } from "./progress-ring";

/** What the menus on every challenge can do; the dialogs live once, in the view. */
type Ops = {
  edit: (c: Challenge) => void;
  give: (c: Challenge) => void;
  reset: (c: Challenge) => void;
  remove: (c: Challenge) => void;
  reduce: (c: Challenge) => void;
};

const COMPLETED_SHOWN = 6;

export function ChallengesView() {
  const { me, partner, state, nameOf, actions } = useHousehold();
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Challenge | null>(null);
  const [giving, setGiving] = useState<Challenge | null>(null);
  const [resetting, setResetting] = useState<Challenge | null>(null);
  const [removing, setRemoving] = useState<Challenge | null>(null);
  const [reducing, setReducing] = useState<Challenge | null>(null);
  const [showAllCompleted, setShowAllCompleted] = useState(false);

  const mine = (c: Challenge) => c.assigned_to === me.id;
  const proposals = pendingProposals(state.challenges, me.id);
  const active = state.challenges.filter((c) => c.status === "active").sort((a, b) => Number(mine(b)) - Number(mine(a)));
  // Waiting for a reply (from me to my partner) and declined ones: both stay manageable so nothing is stuck.
  const waiting = state.challenges.filter(
    (c) => (c.status === "pending" && c.creator_id === me.id && c.assigned_to !== me.id) || c.status === "rejected",
  );
  const allCompleted = state.challenges.filter((c) => c.status === "completed");
  const completed = showAllCompleted ? allCompleted : allCompleted.slice(0, COMPLETED_SHOWN);

  /** "Give to Blake" / "Take it on myself": the other person than the one it is for now. */
  const otherPerson = (c: Challenge) => (mine(c) ? partner : me);

  const ops: Ops = {
    edit: setEditing,
    give: (c) => (c.status === "completed" ? setGiving(c) : void handOver(c)),
    reset: setResetting,
    remove: setRemoving,
    reduce: setReducing,
  };

  async function handOver(c: Challenge) {
    const to = otherPerson(c);
    if (!to) return;
    const row = await actions.updateChallenge(c.id, { title: c.title, target: c.target_count, reward: c.reward_points, assignedTo: to.id });
    if (!row) return;
    toast(
      row.status === "pending" ? `Sent to ${to.display_name} for approval` : to.id === me.id ? "It's yours now" : `Given to ${to.display_name}`,
      "success",
    );
  }

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
            <ProposalCard key={c.id} challenge={c} ops={ops} otherName={otherPerson(c)?.display_name} />
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
              <ChallengeCard key={c.id} challenge={c} ops={ops} otherName={otherPerson(c)?.display_name} />
            ))}
          </div>
        )}
      </section>

      {waiting.length > 0 && (
        <section aria-label="Waiting or declined" className="flex flex-col gap-2">
          <h2 className="text-xs font-extrabold uppercase tracking-wide text-muted">Waiting or declined</h2>
          {waiting.map((c) => (
            <WaitingRow key={c.id} challenge={c} ops={ops} otherName={otherPerson(c)?.display_name} />
          ))}
        </section>
      )}

      {allCompleted.length > 0 && (
        <section aria-label="Completed challenges" className="flex flex-col gap-2">
          <h2 className="text-xs font-extrabold uppercase tracking-wide text-muted">Completed</h2>
          <ul className="flex flex-col gap-2">
            {completed.map((c) => (
              <CompletedRow key={c.id} challenge={c} ops={ops} otherName={otherPerson(c)?.display_name} />
            ))}
          </ul>
          {allCompleted.length > COMPLETED_SHOWN && (
            <button
              onClick={() => setShowAllCompleted((v) => !v)}
              className="min-h-11 self-start rounded-full px-3 text-sm font-bold text-brand hover:bg-brand-soft"
            >
              {showAllCompleted ? "Show fewer" : `Show all ${allCompleted.length}`}
            </button>
          )}
        </section>
      )}

      <NewChallengeSheet open={creating} onClose={() => setCreating(false)} />
      <EditChallengeSheet challenge={editing} onClose={() => setEditing(null)} />

      <ConfirmDialog
        open={!!reducing}
        title={reducing ? `Reduce "${reducing.title}" to ${reducing.target_count - 1} of ${reducing.target_count}?` : ""}
        message={
          reducing
            ? `It goes back to active and the ${reducing.reward_points} pts ${nameOf(reducing.assigned_to)} earned are taken back. Log it again to earn them again.`
            : ""
        }
        confirmLabel={reducing ? `Reduce to ${reducing.target_count - 1} of ${reducing.target_count}` : "Reduce"}
        danger
        onCancel={() => setReducing(null)}
        onConfirm={() => {
          const c = reducing;
          setReducing(null);
          if (c)
            void actions
              .setChallengeProgress(c.id, c.target_count - 1)
              .then((row) => row && toast(`Reopened. ${row.current_count} of ${row.target_count}, ${c.reward_points} pts taken back`, "info"));
        }}
      />
      <ConfirmDialog
        open={!!resetting}
        title={resetting ? `Reset "${resetting.title}"?` : ""}
        message={resetting ? `Progress goes back from ${resetting.current_count} to 0 of ${resetting.target_count}.` : ""}
        confirmLabel="Reset to 0"
        danger
        onCancel={() => setResetting(null)}
        onConfirm={() => {
          const c = resetting;
          setResetting(null);
          if (c) void actions.setChallengeProgress(c.id, 0).then((row) => row && toast("Progress reset", "info"));
        }}
      />
      <ConfirmDialog
        open={!!giving}
        title={giving && otherPerson(giving) ? `Give "${giving.title}" to ${otherPerson(giving)!.display_name}?` : ""}
        message={
          giving && otherPerson(giving)
            ? `The ${giving.reward_points} pts it paid move from ${nameOf(giving.assigned_to)} to ${otherPerson(giving)!.display_name}.`
            : ""
        }
        confirmLabel="Give it"
        onCancel={() => setGiving(null)}
        onConfirm={() => {
          const c = giving;
          setGiving(null);
          if (c) void handOver(c);
        }}
      />
      <ConfirmDialog
        open={!!removing}
        title={removing ? `Delete "${removing.title}"?` : ""}
        message={
          removing
            ? removing.status === "completed"
              ? `It disappears from Stats and the ${removing.reward_points} pts ${nameOf(removing.assigned_to)} earned are taken back.`
              : "This can't be undone."
            : ""
        }
        confirmLabel="Delete"
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const c = removing;
          setRemoving(null);
          if (c)
            void actions
              .deleteChallenge(c.id)
              .then((taken) => taken !== null && toast(taken > 0 ? `Deleted. ${taken} pts taken back` : "Challenge deleted", "success"));
        }}
      />
    </div>
  );
}

/** The ... menu on any challenge: everything that isn't the everyday tap. */
function ChallengeMenu({ challenge: c, ops, otherName }: { challenge: Challenge; ops: Ops; otherName: string | undefined }) {
  const { me } = useHousehold();
  const mine = c.assigned_to === me.id;
  const items: MenuItem[] = [
    { key: "edit", label: "Edit", icon: "pencil", run: () => ops.edit(c) },
    ...(otherName
      ? [{ key: "give", label: mine ? `Give to ${otherName}` : "Take it on myself", icon: "users" as const, run: () => ops.give(c) }]
      : []),
    ...(c.status === "active" && c.current_count > 0
      ? [{ key: "reset", label: "Reset progress", icon: "undo" as const, run: () => ops.reset(c) }]
      : []),
    { key: "delete", label: "Delete", icon: "trash", danger: true, run: () => ops.remove(c) },
  ];
  return <ActionMenu label={c.title} items={items} />;
}

/**
 * The counter on an active challenge: [ - ]  3 / 5  [ + Log one ]. A finished challenge shows the same "-" and
 * count (see CompletedRow), so taking progress back always works the same way.
 */
function ProgressStepper({ challenge: c }: { challenge: Challenge }) {
  const { me, actions } = useHousehold();
  const { toast, celebrate } = useToast();
  const mine = c.assigned_to === me.id;

  const minus = () => void actions.setChallengeProgress(c.id, c.current_count - 1);

  async function plus() {
    const result = await actions.incrementChallenge(c.id);
    if (result === "completed") {
      celebrate();
      toast(`Challenge complete! +${c.reward_points} pts`, "points");
    }
  }

  return (
    <div className="flex items-center gap-2" role="group" aria-label={`${c.title} progress controls`}>
      <button
        onClick={minus}
        disabled={c.current_count <= 0}
        aria-label={`Reduce ${c.title} by one, to ${c.current_count - 1} of ${c.target_count}`}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-raised text-ink transition-transform active:scale-90 disabled:opacity-40"
      >
        <Icon name="minus" size={20} strokeWidth={2.6} />
      </button>
      <span className="min-w-14 text-center text-base font-extrabold tabular-nums" aria-live="polite">
        {c.current_count}
        <span className="text-muted"> / {c.target_count}</span>
      </span>
      {mine ? (
        <button
          onClick={plus}
          aria-label={`Log one for ${c.title}. ${c.current_count} of ${c.target_count} done.`}
          className={`${primaryButton} min-h-11 flex-1 px-3 text-sm`}
        >
          <Icon name="plus" size={18} strokeWidth={2.8} />
          Log one
        </button>
      ) : (
        <span className="flex min-h-11 flex-1 items-center justify-center text-xs font-bold text-muted">Their challenge</span>
      )}
    </div>
  );
}

function ChallengeCard({ challenge: c, ops, otherName }: { challenge: Challenge; ops: Ops; otherName: string | undefined }) {
  const { me, tone, nameOf } = useHousehold();
  const mine = c.assigned_to === me.id;
  return (
    <article className="flex flex-col gap-3 rounded-3xl border border-line bg-surface p-4 shadow-card">
      <div className="flex items-center gap-4">
        <ProgressRing challenge={c} tone={tone(c.assigned_to)} size={80} />
        <div className="min-w-0 flex-1">
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
        </div>
        <ChallengeMenu challenge={c} ops={ops} otherName={otherName} />
      </div>
      <ProgressStepper challenge={c} />
    </article>
  );
}

function ProposalCard({ challenge: c, ops, otherName }: { challenge: Challenge; ops: Ops; otherName: string | undefined }) {
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
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-muted">{nameOf(c.creator_id)} set a challenge for you</p>
          <p className="mt-0.5 text-lg font-extrabold">{c.title}</p>
        </div>
        <ChallengeMenu challenge={c} ops={ops} otherName={otherName} />
      </div>
      <p className="mt-1 text-sm text-muted">
        {c.target_count} {c.target_count === 1 ? "time" : "times"}
        {c.current_count > 0 && <> · {c.current_count} done already</>} · <span className="font-bold text-gold">+{c.reward_points} pts</span>
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

function WaitingRow({ challenge: c, ops, otherName }: { challenge: Challenge; ops: Ops; otherName: string | undefined }) {
  const { me, nameOf } = useHousehold();
  const declined = c.status === "rejected";
  return (
    <div className="flex min-h-14 items-center gap-3 rounded-2xl bg-raised py-2.5 pl-4 pr-1">
      <div className="min-w-0 flex-1">
        <p className="truncate font-bold">{c.title}</p>
        <p className="text-xs text-muted">
          {c.assigned_to === me.id ? "You declined this one" : `For ${nameOf(c.assigned_to)}`}
        </p>
      </div>
      <span
        className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-extrabold ${declined ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn"}`}
      >
        {declined ? "Declined" : "Awaiting reply"}
      </span>
      <ChallengeMenu challenge={c} ops={ops} otherName={otherName} />
    </div>
  );
}

function CompletedRow({ challenge: c, ops, otherName }: { challenge: Challenge; ops: Ops; otherName: string | undefined }) {
  const { nameOf } = useHousehold();
  return (
    <li className="flex min-h-16 items-center gap-2 rounded-2xl bg-raised py-2 pl-3 pr-1">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ok text-white">
        <Icon name="check" size={16} strokeWidth={3} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-bold">{c.title}</p>
        <p className="truncate text-xs text-muted">
          {nameOf(c.assigned_to)} · <span className="font-extrabold text-gold">+{c.reward_points} pts</span>
        </p>
      </div>
      {/* Same - / count as an active challenge: "-" reopens it (with a confirmation) and takes the reward back. */}
      <button
        onClick={() => ops.reduce(c)}
        aria-label={`Undo: reduce ${c.title} to ${c.target_count - 1} of ${c.target_count} and take the reward back`}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface text-ink shadow-card transition-transform active:scale-90"
      >
        <Icon name="minus" size={20} strokeWidth={2.6} />
      </button>
      <span className="min-w-12 text-center text-base font-extrabold tabular-nums">
        {c.current_count}
        <span className="text-muted"> / {c.target_count}</span>
      </span>
      <ChallengeMenu challenge={c} ops={ops} otherName={otherName} />
    </li>
  );
}
