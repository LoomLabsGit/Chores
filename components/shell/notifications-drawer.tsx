"use client";

import { useEffect, useState } from "react";
import { pendingProposals } from "@/lib/logic/notifications";
import { timeAgo } from "@/lib/logic/dates";
import { useHousehold } from "@/lib/store/household-store";
import type { AppNotification, NotificationType } from "@/lib/types";
import { Icon, type IconName } from "../icons";
import { Modal } from "../ui/modal";
import { EmptyState } from "../ui/controls";

const TYPE_ICON: Record<NotificationType, IconName> = {
  chore_assigned: "calendar",
  chore_completed: "check",
  challenge_proposed: "trophy",
  challenge_accepted: "trophy",
  challenge_declined: "trophy",
  challenge_completed: "trophy",
  reward_redeemed: "gift",
};

export function NotificationsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Notifications" variant="drawer">
      <NotificationList />
    </Modal>
  );
}

// Mounted only while the drawer is open, so "unread at open" is captured once.
function NotificationList() {
  const { me, state, actions } = useHousehold();
  const [unreadAtOpen] = useState(() => new Set(state.notifications.filter((n) => !n.is_read).map((n) => n.id)));
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void actions.markAllRead();
    // Alerts that arrive while the drawer is open are read immediately too.
  }, [actions, state.notifications.length]);

  const proposals = pendingProposals(state.challenges, me.id);
  const pendingIds = new Set(proposals.map((c) => c.id));
  // A pending proposal is shown once, with buttons, in "Needs your reply".
  const events = state.notifications.filter(
    (n) => !(n.type === "challenge_proposed" && n.reference_id && pendingIds.has(n.reference_id)),
  );

  async function respond(id: string, accept: boolean) {
    setBusy(id);
    await actions.respondToChallenge(id, accept);
    setBusy(null);
  }

  if (!proposals.length && !events.length) {
    return (
      <EmptyState icon={<Icon name="bell" size={26} />} title="All caught up">
        Chores your partner assigns, challenges and reward redemptions will show up here.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {proposals.length > 0 && (
        <section aria-label="Needs your reply" className="flex flex-col gap-2">
          <h3 className="text-xs font-extrabold uppercase tracking-wide text-muted">Needs your reply</h3>
          {proposals.map((c) => (
            <article key={c.id} className="rounded-2xl border border-brand/30 bg-brand-soft p-4">
              <p className="text-sm font-semibold text-muted">
                {state.members.find((m) => m.id === c.creator_id)?.display_name ?? "Your partner"} set a challenge for you
              </p>
              <p className="mt-0.5 text-base font-extrabold">{c.title}</p>
              <p className="mt-1 text-sm text-muted">
                {c.target_count} {c.target_count === 1 ? "time" : "times"} &middot; <span className="font-bold text-gold">+{c.reward_points} pts</span>
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  disabled={busy === c.id}
                  onClick={() => respond(c.id, false)}
                  className="min-h-11 flex-1 rounded-xl border border-line bg-surface font-bold disabled:opacity-50"
                >
                  Decline
                </button>
                <button
                  disabled={busy === c.id}
                  onClick={() => respond(c.id, true)}
                  className="min-h-11 flex-1 rounded-xl bg-brand font-extrabold text-brand-ink disabled:opacity-50"
                >
                  Accept
                </button>
              </div>
            </article>
          ))}
        </section>
      )}

      {events.length > 0 && (
        <section aria-label="Recent activity" className="flex flex-col gap-1.5">
          <h3 className="text-xs font-extrabold uppercase tracking-wide text-muted">Recent</h3>
          <ul className="flex flex-col gap-1.5">
            {events.map((n) => (
              <Row key={n.id} n={n} fresh={unreadAtOpen.has(n.id)} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Row({ n, fresh }: { n: AppNotification; fresh: boolean }) {
  return (
    <li className={`flex items-start gap-3 rounded-2xl px-3 py-3 ${fresh ? "bg-brand-soft" : "bg-raised"}`}>
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface text-brand">
        <Icon name={TYPE_ICON[n.type]} size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold leading-snug">{n.message}</p>
        <p className="mt-0.5 text-xs text-muted">{timeAgo(n.created_at)}</p>
      </div>
      {fresh && <span aria-label="New" className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-brand" />}
    </li>
  );
}
