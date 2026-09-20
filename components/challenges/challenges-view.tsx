"use client";

import { useEffect, useRef, useState } from "react";
import { contributionLine, describeDeadline, hasEnded, jointHalf, payoutEach } from "@/lib/logic/challenges";
import { formatLongDay, todayISO } from "@/lib/logic/dates";
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

  // Joint challenges belong to both of you; individual ones to the person they are for.
  const mine = (c: Challenge) => c.is_joint || c.assigned_to === me.id;
  const proposals = pendingProposals(state.challenges, me.id);
  const active = state.challenges.filter((c) => c.status === "active").sort((a, b) => Number(mine(b)) - Number(mine(a)));
  // Waiting for a reply (from me to my partner) and declined ones: both stay manageable so nothing is stuck.
  const waiting = state.challenges.filter(
    (c) => (c.status === "pending" && c.creator_id === me.id && c.assigned_to !== me.id) || c.status === "rejected",
  );
  const missed = state.challenges.filter(hasEnded);
  const allCompleted = state.challenges.filter((c) => c.status === "completed");
  const completed = showAllCompleted ? allCompleted : allCompleted.slice(0, COMPLETED_SHOWN);

  // What each missed forfeit really docked (the balance never goes below 0, so it can be less than the penalty).
  const [docked, setDocked] = useState<Record<string, number>>({});
  const penalisedIds = missed.filter((c) => c.status === "expired_penalized").map((c) => c.id).join(",");
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  });
  useEffect(() => {
    if (!penalisedIds) return;
    let live = true;
    void actionsRef.current.fetchChallengePenalties(penalisedIds.split(",")).then((d) => live && setDocked(d));
    return () => {
      live = false;
    };
  }, [penalisedIds]);

  /** "Give to Blake" / "Take it on myself": the other person than the one it is for now. */
  const otherPerson = (c: Challenge) => (c.assigned_to === me.id ? partner : me);

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
    const row = await actions.updateChallenge(c.id, {
      title: c.title,
      target: c.target_count,
      reward: c.reward_points,
      assignedTo: to.id,
      deadline: c.deadline_date,
      penalty: c.penalty_points,
    });
    if (!row) return;
    toast(
      row.status === "pending" ? `Sent to ${to.display_name} for approval` : to.id === me.id ? "It's yours now" : `Given to ${to.display_name}`,
      "success",
    );
  }

  const removeMessage = (c: Challenge) => {
    if (c.status === "completed") {
      return c.is_joint
        ? `It disappears from Stats and the ${jointHalf(c.reward_points)} pts each of you earned are taken back.`
        : `It disappears from Stats and the ${c.reward_points} pts ${nameOf(c.assigned_to)} earned are taken back.`;
    }
    if (c.status === "expired_penalized") {
      const n = docked[c.id] ?? c.penalty_points;
      return `The ${n} pts that were docked from ${nameOf(c.assigned_to)} are given back.`;
    }
    return "This can't be undone.";
  };

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
            Set yourself a habit (&ldquo;Gym 12 times&rdquo;), challenge your partner, take one on together, or set a forfeit to hold
            yourself to something.
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

      {missed.length > 0 && (
        <section aria-label="Missed or expired" className="flex flex-col gap-2">
          <h2 className="text-xs font-extrabold uppercase tracking-wide text-muted">Missed or expired</h2>
          <ul className="flex flex-col gap-2">
            {missed.map((c) => (
              <MissedRow key={c.id} challenge={c} docked={docked[c.id]} ops={ops} />
            ))}
          </ul>
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
            ? reducing.is_joint
              ? `It goes back to active and the ${jointHalf(reducing.reward_points)} pts each of you earned are taken back. Log it again to earn them again.`
              : `It goes back to active and the ${reducing.reward_points} pts ${nameOf(reducing.assigned_to)} earned are taken back. Log it again to earn them again.`
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
              .then((row) => row && toast(`Reopened. ${row.current_count} of ${row.target_count}${c.reward_points > 0 ? ", reward taken back" : ""}`, "info"));
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
        message={removing ? removeMessage(removing) : ""}
        confirmLabel="Delete"
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const c = removing;
          setRemoving(null);
          if (c)
            void actions.deleteChallenge(c.id).then((taken) => {
              if (taken === null) return;
              toast(
                taken > 0 ? `Deleted. ${taken} pts taken back` : taken < 0 ? `Deleted. ${-taken} pts given back` : "Challenge deleted",
                "success",
              );
            });
        }}
      />
    </div>
  );
}

/** The ... menu on any challenge: everything that isn't the everyday tap. */
function ChallengeMenu({ challenge: c, ops, otherName }: { challenge: Challenge; ops: Ops; otherName: string | undefined }) {
  const { me } = useHousehold();
  const mine = c.assigned_to === me.id;
  const ended = hasEnded(c);
  const items: MenuItem[] = ended
    ? [{ key: "delete", label: "Delete", icon: "trash", danger: true, run: () => ops.remove(c) }]
    : [
        { key: "edit", label: "Edit", icon: "pencil", run: () => ops.edit(c) },
        // A joint challenge belongs to both of you, so there is nobody to hand it to.
        ...(otherName && !c.is_joint
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
 * Either partner can log a joint challenge; an individual one only the person it is for.
 */
function ProgressStepper({ challenge: c }: { challenge: Challenge }) {
  const { me, actions } = useHousehold();
  const { toast, celebrate } = useToast();
  const canLog = c.is_joint || c.assigned_to === me.id;

  const minus = () => void actions.setChallengeProgress(c.id, c.current_count - 1);

  async function plus() {
    const result = await actions.incrementChallenge(c.id);
    if (result !== "completed") return;
    celebrate();
    if (c.type === "forfeit") toast("You held the line. Nothing lost!", "success");
    else if (c.is_joint) toast(`Challenge complete! +${jointHalf(c.reward_points)} pts each`, "points");
    else toast(`Challenge complete! +${c.reward_points} pts`, "points");
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
      {canLog ? (
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

/** Two overlapping avatars: a joint challenge belongs to both of you. */
function PairAvatars({ size = 20 }: { size?: number }) {
  const { state, tone } = useHousehold();
  return (
    <span className="flex items-center" aria-hidden>
      {state.members.map((m, i) => (
        <span key={m.id} className={i ? "-ml-1.5" : ""}>
          <Avatar name={m.display_name} tone={tone(m.id)} size={size} ring />
        </span>
      ))}
    </span>
  );
}

/** "-10 pts if missed by Sat 26 Sep": the warning line of a forfeit challenge. */
function ForfeitWarning({ challenge: c, compact }: { challenge: Challenge; compact?: boolean }) {
  return (
    <p className={`flex items-start gap-1.5 font-bold text-warn ${compact ? "text-xs" : "text-[13px] leading-snug"}`}>
      <span className="mt-px shrink-0">
        <Icon name="alert" size={compact ? 13 : 15} />
      </span>
      <span>
        &minus;{c.penalty_points} pts if missed
        {c.deadline_date ? ` by ${formatLongDay(c.deadline_date)}` : ""}
      </span>
    </p>
  );
}

function ChallengeCard({ challenge: c, ops, otherName }: { challenge: Challenge; ops: Ops; otherName: string | undefined }) {
  const { me, partner, tone, nameOf, actions } = useHousehold();
  const { toast, celebrate } = useToast();
  const forfeit = c.type === "forfeit";
  const canLog = c.is_joint || c.assigned_to === me.id;
  const today = todayISO();
  const overdue = !!c.deadline_date && c.deadline_date < today;

  /** Tapping the ring logs one, the same as "Log one". */
  async function tapRing() {
    if (!canLog) return;
    const result = await actions.incrementChallenge(c.id);
    if (result !== "completed") return;
    celebrate();
    if (forfeit) toast("You held the line. Nothing lost!", "success");
    else if (c.is_joint) toast(`Challenge complete! +${jointHalf(c.reward_points)} pts each`, "points");
    else toast(`Challenge complete! +${c.reward_points} pts`, "points");
  }

  const ring = (
    <ProgressRing challenge={c} tone={tone(c.assigned_to)} size={80} color={forfeit ? "var(--warn)" : undefined} />
  );

  return (
    <article
      className={`flex flex-col gap-3 rounded-3xl border p-4 shadow-card ${
        forfeit ? "border-warn/60 bg-warn-soft/25" : "border-line bg-surface"
      }`}
      aria-label={forfeit ? `${c.title}, forfeit challenge` : c.is_joint ? `${c.title}, joint challenge` : undefined}
    >
      <div className="flex items-center gap-4">
        {canLog ? (
          <button
            onClick={tapRing}
            aria-label={`Tap to log one for ${c.title}. ${c.current_count} of ${c.target_count} done.`}
            className="shrink-0 rounded-full transition-transform active:scale-95"
          >
            {ring}
          </button>
        ) : (
          ring
        )}
        <div className="min-w-0 flex-1">
          <p className="flex items-start gap-1.5 text-base font-extrabold leading-snug">
            {forfeit && (
              <span className="mt-0.5 shrink-0 text-warn">
                <Icon name="shield" size={17} />
              </span>
            )}
            <span className="line-clamp-2">{c.title}</span>
          </p>

          {c.is_joint ? (
            <div className="mt-1 flex flex-col gap-1">
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs font-bold text-muted">
                <PairAvatars />
                <span className="whitespace-nowrap rounded-full bg-brand-soft px-2 py-0.5 text-brand">Shared 50/50</span>
                <span className="flex items-center gap-0.5 whitespace-nowrap text-gold">
                  <Icon name="star" size={11} />
                  {jointHalf(c.reward_points)} each
                </span>
              </p>
              <p className="text-xs font-bold text-muted" aria-label="Contributions">
                {contributionLine(c, me.is_admin, partner?.display_name ?? "Partner")}
              </p>
            </div>
          ) : (
            <div className="mt-1 flex flex-col gap-1">
              <p className="flex items-center gap-1.5 text-xs font-bold text-muted">
                <Avatar name={nameOf(c.assigned_to)} tone={tone(c.assigned_to)} size={18} />
                {c.assigned_to === me.id ? "You" : nameOf(c.assigned_to)}
                {!forfeit && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="flex items-center gap-0.5 text-gold">
                      <Icon name="star" size={11} />+{payoutEach(c)} pts
                    </span>
                  </>
                )}
              </p>
              {forfeit && <ForfeitWarning challenge={c} compact />}
            </div>
          )}

          {c.deadline_date && (
            <p className={`mt-1 text-xs font-bold ${overdue ? "text-danger" : "text-muted"}`}>
              {describeDeadline(c.deadline_date, today)}
              {!forfeit && ` · ${formatLongDay(c.deadline_date)}`}
            </p>
          )}
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
  const forfeit = c.type === "forfeit";

  async function respond(accept: boolean) {
    setBusy(true);
    const ok = await actions.respondToChallenge(c.id, accept);
    setBusy(false);
    if (ok) toast(accept ? "Challenge accepted. Good luck!" : "Challenge declined", accept ? "success" : "info");
  }

  return (
    <article className={`rounded-3xl border p-4 ${forfeit ? "border-warn/50 bg-warn-soft/40" : "border-brand/30 bg-brand-soft"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-muted">
            {nameOf(c.creator_id)} set {forfeit ? "a forfeit challenge" : "a challenge"} for you
          </p>
          <p className="mt-0.5 flex items-start gap-1.5 text-lg font-extrabold">
            {forfeit && (
              <span className="mt-1 shrink-0 text-warn">
                <Icon name="shield" size={18} />
              </span>
            )}
            {c.title}
          </p>
        </div>
        <ChallengeMenu challenge={c} ops={ops} otherName={otherName} />
      </div>
      <p className="mt-1 text-sm text-muted">
        {c.target_count} {c.target_count === 1 ? "time" : "times"}
        {c.current_count > 0 && <> · {c.current_count} done already</>}
        {!forfeit && (
          <>
            {" "}
            · <span className="font-bold text-gold">+{c.reward_points} pts</span>
          </>
        )}
      </p>
      {forfeit && (
        <div className="mt-1.5">
          <ForfeitWarning challenge={c} />
        </div>
      )}
      {!forfeit && c.deadline_date && <p className="mt-1 text-xs font-bold text-muted">Due {formatLongDay(c.deadline_date)}</p>}
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
        <p className="flex items-center gap-1.5 truncate font-bold">
          {c.type === "forfeit" && (
            <span className="shrink-0 text-warn">
              <Icon name="shield" size={15} />
            </span>
          )}
          <span className="truncate">{c.title}</span>
        </p>
        <p className="text-xs text-muted">{c.assigned_to === me.id ? "You declined this one" : `For ${nameOf(c.assigned_to)}`}</p>
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

/** A challenge that ran out of time: a forfeit that was docked, or any other that simply lapsed. */
function MissedRow({ challenge: c, docked, ops }: { challenge: Challenge; docked: number | undefined; ops: Ops }) {
  const { nameOf } = useHousehold();
  const penalised = c.status === "expired_penalized";
  return (
    <li className="flex min-h-16 items-center gap-3 rounded-2xl bg-raised py-2 pl-3 pr-1">
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${penalised ? "bg-warn-soft text-warn" : "bg-line text-muted"}`}
      >
        <Icon name={penalised ? "alert" : "x"} size={16} strokeWidth={2.6} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-bold">{c.title}</p>
        <p className="truncate text-xs text-muted">
          {c.is_joint ? "Both of you" : nameOf(c.assigned_to)} ·{" "}
          {penalised ? (
            <span className="font-extrabold text-warn">
              Missed{c.deadline_date ? ` on ${formatLongDay(c.deadline_date)}` : ""} · &minus;{docked ?? c.penalty_points} pts
            </span>
          ) : (
            <span>Expired{c.deadline_date ? ` on ${formatLongDay(c.deadline_date)}` : ""} · nothing lost</span>
          )}
        </p>
      </div>
      <ChallengeMenu challenge={c} ops={ops} otherName={undefined} />
    </li>
  );
}

function CompletedRow({ challenge: c, ops, otherName }: { challenge: Challenge; ops: Ops; otherName: string | undefined }) {
  const { nameOf, partner } = useHousehold();
  const forfeit = c.type === "forfeit";
  return (
    <li className="flex min-h-16 items-center gap-2 rounded-2xl bg-raised py-2 pl-3 pr-1">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ok text-white">
        <Icon name={forfeit ? "shield" : "check"} size={16} strokeWidth={forfeit ? 2.4 : 3} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-bold">{c.title}</p>
        <p className="truncate text-xs text-muted">
          {c.is_joint ? `You & ${partner?.display_name ?? "partner"}` : nameOf(c.assigned_to)} ·{" "}
          {forfeit ? (
            <span className="font-extrabold text-ok">Held the line</span>
          ) : (
            <span className="font-extrabold text-gold">
              +{payoutEach(c)} pts{c.is_joint ? " each" : ""}
            </span>
          )}
        </p>
      </div>
      {/* Same - / count as an active challenge: "-" reopens it (with a confirmation) and takes the reward back. */}
      <button
        onClick={() => ops.reduce(c)}
        aria-label={`Undo: reduce ${c.title} to ${c.target_count - 1} of ${c.target_count}${c.reward_points > 0 ? " and take the reward back" : ""}`}
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
