"use client";

import { useState } from "react";
import { completionShares, formatDelta, ledgerRows, repricedShares } from "@/lib/logic/ledger";
import { COMPLETION_STEPS, ESTIMATE_STEPS } from "@/lib/logic/points";
import {
  describeRepeat,
  frequencyFromRule,
  REPEAT_OPTIONS,
  type RepeatChoice,
} from "@/lib/logic/recurrence";
import { useHousehold } from "@/lib/store/household-store";
import type { ChoreInstance, PricingType } from "@/lib/types";
import { useToast } from "../toast";
import { fieldClass, primaryButton, Segmented } from "../ui/controls";
import { Modal } from "../ui/modal";
import { Avatar } from "../ui/controls";
import { AssigneeField, BountyField, DurationField, PricingFields, SplitControl, TaxField } from "../ui/points-controls";

export function EditChoreSheet({ instance, onClose }: { instance: ChoreInstance | null; onClose: () => void }) {
  if (!instance) return null;
  return (
    <Modal open onClose={onClose} title="Edit chore" variant="sheet">
      <EditForm key={instance.id} instance={instance} onClose={onClose} />
    </Modal>
  );
}

function EditForm({ instance, onClose }: { instance: ChoreInstance; onClose: () => void }) {
  const { me, partner, state, tone, nameOf, actions } = useHousehold();
  const { toast } = useToast();

  // A finished chore can be edited too: name and day never affect points, but time logged, tax, split and assignee
  // re-price it (the dynamic ledger) and each balance moves by the difference.
  const finished = instance.is_completed;
  const inSeries = !finished && !!instance.parent_recurrence_id;
  const currentRepeat: RepeatChoice = inSeries ? frequencyFromRule(instance.recurrence_rule) : "none";
  const completion = state.completions[instance.id];
  // A finished chore can be re-priced (the dynamic ledger) when its completion record is there.
  const repriceable = finished && !!completion;

  const [title, setTitle] = useState(instance.title);
  const [minutes, setMinutes] = useState(instance.estimated_duration);
  const [tax, setTax] = useState(instance.chore_tax);
  // A finished chore keeps the pricing model it was paid under; an unfinished one can switch.
  const [pricing, setPricing] = useState<PricingType>(instance.pricing_type);
  const [bounty, setBounty] = useState(instance.fixed_bounty_points);
  const [date, setDate] = useState(instance.scheduled_date);
  const [assignee, setAssignee] = useState<string | null>(finished ? (instance.assigned_to ?? me.id) : instance.assigned_to);
  const [logged, setLogged] = useState(completion ? completion.total_duration_minutes : instance.estimated_duration);
  const [split, setSplit] = useState(!!completion && completion.owner_percent < 100);
  const [ownerPct, setOwnerPct] = useState(completion && completion.owner_percent < 100 ? completion.owner_percent : 50);
  const [repeat, setRepeat] = useState<RepeatChoice>(currentRepeat);
  const [scope, setScope] = useState<"this" | "future">("this");
  const [busy, setBusy] = useState(false);

  // Dynamic ledger: what this finished chore is worth now, and who gains or loses the difference.
  // Only a real change of assignee moves the credit; the split's first share belongs to the owner.
  const ownerId = !completion
    ? null
    : assignee && assignee !== instance.assigned_to
      ? assignee
      : completion.user_a_id;
  const otherId = ownerId ? (state.members.find((m) => m.id !== ownerId)?.id ?? ownerId) : null;
  const ledger =
    repriceable && ownerId && otherId
      ? (() => {
          const after = repricedShares({
            minutes: logged,
            pricing: { pricing_type: instance.pricing_type, fixed_bounty_points: bounty, chore_tax: tax },
            ownerPercent: split && otherId !== ownerId ? ownerPct : 100,
            ownerId,
            otherId,
          });
          const rows = ledgerRows(completionShares(completion), after.shares);
          return { total: after.total, before: completion.user_a_points + completion.user_b_points, rows };
        })()
      : null;
  const pointsChange = !!ledger && ledger.rows.some((r) => r.delta !== 0);
  const ownerProfile = ownerId ? state.members.find((m) => m.id === ownerId) : undefined;
  const otherProfile = otherId && otherId !== ownerId ? state.members.find((m) => m.id === otherId) : undefined;
  const ownerTone = ownerId ? tone(ownerId) : tone(me.id);
  const otherTone = otherId ? tone(otherId) : ownerTone === "a" ? "b" : "a";

  // For a repeating chore the frequency can only change together with "this and future".
  const repeatEditable = !inSeries || scope === "future";
  const effectiveRepeat = repeatEditable ? repeat : currentRepeat;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !date) return;
    setBusy(true);
    const ok = await actions.editChore(instance, {
      title,
      minutes,
      tax,
      pricing: finished ? instance.pricing_type : pricing,
      bounty,
      assignedTo: assignee,
      date,
      repeat: effectiveRepeat,
      scope,
      ...(repriceable ? { loggedMinutes: logged, ownerPercent: split && otherId !== ownerId ? ownerPct : 100 } : {}),
    });
    setBusy(false);
    if (!ok) return;
    onClose();
    if (ledger && pointsChange) {
      const moved = ledger.rows.filter((r) => r.delta !== 0).map((r) => `${r.userId === me.id ? "You" : nameOf(r.userId)} ${formatDelta(r.delta)}`);
      toast(`Saved. Balances updated: ${moved.join(", ")} pts`, "points");
      return;
    }
    toast(
      !inSeries && !finished && effectiveRepeat !== "none"
        ? `Saved. ${describeRepeat(effectiveRepeat, date)}`
        : inSeries && scope === "future"
          ? "Saved for this and future chores"
          : "Saved",
      "success",
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      {finished && (
        <p className="rounded-2xl bg-ok-soft px-4 py-3 text-sm font-semibold text-ok">
          {repriceable
            ? "This chore is finished. Change the time, tax or bounty, the split or who it is for and its points are recalculated. Each balance moves by the difference straight away."
            : "This chore is finished. Its points can't be recalculated because it has no completion record."}
        </p>
      )}
      {inSeries && (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-extrabold">Apply changes to</span>
          <Segmented
            label="Apply changes to"
            value={scope}
            onChange={setScope}
            options={[
              { value: "this", label: "Only this chore" },
              { value: "future", label: "This and future" },
            ]}
          />
          <p className="text-xs font-semibold text-muted">
            {scope === "this"
              ? "The other days in this repeating chore stay as they are."
              : "Every later unfinished day changes too. Finished and earlier days are never touched."}
          </p>
        </div>
      )}

      <label className="flex flex-col gap-1.5 text-sm font-extrabold">
        Name
        <input
          required
          maxLength={60}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={fieldClass}
        />
      </label>

      {!finished && (
        <PricingFields
          pricing={pricing}
          onPricing={setPricing}
          bounty={bounty}
          onBounty={setBounty}
          minutes={minutes}
          onMinutes={setMinutes}
          tax={tax}
          onTax={setTax}
          steps={ESTIMATE_STEPS}
          timeLabel="Estimated time"
          timeId="edit-minutes"
        />
      )}

      {repriceable && (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="edit-logged" className="text-sm font-extrabold">
              Time logged
            </label>
            <DurationField inputId="edit-logged" value={logged} onChange={setLogged} steps={COMPLETION_STEPS} label="Minutes logged" />
          </div>
          {instance.pricing_type === "fixed_bounty" ? (
            <BountyField value={bounty} onChange={setBounty} note="Changing it re-prices this chore, and balances adjust by the difference." />
          ) : (
            <TaxField value={tax} onChange={setTax} />
          )}
          {otherProfile && ownerProfile && (
            <SplitControl
              owner={ownerProfile}
              other={otherProfile}
              ownerTone={ownerTone}
              otherTone={otherTone}
              enabled={split}
              onToggle={() => setSplit((v) => !v)}
              pct={ownerPct}
              onPct={setOwnerPct}
            />
          )}
        </>
      )}

      <label className="flex flex-col gap-1.5 text-sm font-extrabold">
        <span>
          Day
          {inSeries && scope === "future" && (
            <span className="font-medium text-muted"> (this occurrence only)</span>
          )}
        </span>
        <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className={fieldClass} />
      </label>

      <AssigneeField value={assignee} onChange={setAssignee} me={me} partner={partner} tone={tone} allowUnassigned={!finished} />

      {ledger && (
        <section aria-label="Points ledger" className="rounded-3xl border border-line bg-raised p-4 text-[15px]" aria-live="polite">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-extrabold">Points ledger</span>
            <span className="font-extrabold tabular-nums text-gold">
              {ledger.before === ledger.total ? `${ledger.total} pts` : `${ledger.before} \u2192 ${ledger.total} pts`}
            </span>
          </div>
          {pointsChange ? (
            <ul className="mt-2.5 flex flex-col gap-1.5 border-t border-line pt-2.5 text-sm font-bold">
              {ledger.rows
                .filter((r) => r.delta !== 0 || r.before !== 0)
                .map((r) => (
                  <li key={r.userId} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2">
                      <Avatar name={nameOf(r.userId)} tone={tone(r.userId)} size={20} />
                      {r.userId === me.id ? "You" : nameOf(r.userId)}: {r.before} &rarr; {r.after}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-extrabold tabular-nums ${
                        r.delta > 0 ? "bg-ok-soft text-ok" : r.delta < 0 ? "bg-danger-soft text-danger" : "bg-line text-muted"
                      }`}
                    >
                      {formatDelta(r.delta)} pts
                    </span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm font-semibold text-muted">No change to anyone&rsquo;s points.</p>
          )}
        </section>
      )}

      {!finished && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="repeat" className="text-sm font-extrabold">
            Repeat
          </label>
          {repeatEditable ? (
            <select
              id="repeat"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value as RepeatChoice)}
              className={fieldClass}
            >
              {REPEAT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <p id="repeat" className={`${fieldClass} flex items-center text-muted`}>
              {REPEAT_OPTIONS.find((o) => o.value === currentRepeat)?.label ?? "Repeats"}
            </p>
          )}
          <p className="text-xs font-semibold text-muted" aria-live="polite">
            {inSeries && scope === "future" && repeat === "none"
              ? "This will be the last one. Later days are removed."
              : inSeries && scope === "future" && repeat !== currentRepeat
                ? `${describeRepeat(repeat, date)}. Later days are rebuilt from this one.`
                : describeRepeat(effectiveRepeat, date)}
            {inSeries && scope === "this" && ". Choose “This and future” to change how often."}
          </p>
        </div>
      )}

      <button type="submit" disabled={busy || !title.trim() || !date} className={`${primaryButton} min-h-14 text-lg`}>
        {busy ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
