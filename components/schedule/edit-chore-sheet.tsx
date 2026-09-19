"use client";

import { useState } from "react";
import { ESTIMATE_STEPS } from "@/lib/logic/points";
import {
  describeRepeat,
  frequencyFromRule,
  REPEAT_OPTIONS,
  type RepeatChoice,
} from "@/lib/logic/recurrence";
import { useHousehold } from "@/lib/store/household-store";
import type { ChoreInstance } from "@/lib/types";
import { useToast } from "../toast";
import { fieldClass, primaryButton, Segmented } from "../ui/controls";
import { Modal } from "../ui/modal";
import { AssigneeField, DurationField, RewardPreview, TaxField } from "../ui/points-controls";

export function EditChoreSheet({ instance, onClose }: { instance: ChoreInstance | null; onClose: () => void }) {
  if (!instance) return null;
  return (
    <Modal open onClose={onClose} title="Edit chore" variant="sheet">
      <EditForm key={instance.id} instance={instance} onClose={onClose} />
    </Modal>
  );
}

function EditForm({ instance, onClose }: { instance: ChoreInstance; onClose: () => void }) {
  const { me, partner, state, tone, actions } = useHousehold();
  const { toast } = useToast();

  // A finished chore keeps the points and time it paid out; only name, day and assignee change.
  const finished = instance.is_completed;
  const inSeries = !finished && !!instance.parent_recurrence_id;
  const currentRepeat: RepeatChoice = inSeries ? frequencyFromRule(instance.recurrence_rule) : "none";
  const completion = state.completions[instance.id];
  const earned = completion ? completion.user_a_points + completion.user_b_points : null;

  const [title, setTitle] = useState(instance.title);
  const [minutes, setMinutes] = useState(instance.estimated_duration);
  const [tax, setTax] = useState(instance.chore_tax);
  const [date, setDate] = useState(instance.scheduled_date);
  const [assignee, setAssignee] = useState<string | null>(instance.assigned_to);
  const [repeat, setRepeat] = useState<RepeatChoice>(currentRepeat);
  const [scope, setScope] = useState<"this" | "future">("this");
  const [busy, setBusy] = useState(false);

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
      assignedTo: assignee,
      date,
      repeat: effectiveRepeat,
      scope,
    });
    setBusy(false);
    if (!ok) return;
    onClose();
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
          This chore is finished.{earned !== null ? ` Its ${earned} points and` : " Its points and"} logged time stay as
          they are. To change them, uncheck it first.
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
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="edit-minutes" className="text-sm font-extrabold">
              Estimated time
            </label>
            <DurationField
              inputId="edit-minutes"
              value={minutes}
              onChange={setMinutes}
              steps={ESTIMATE_STEPS}
              label="Estimated minutes"
            />
          </div>
          <TaxField value={tax} onChange={setTax} />
          <RewardPreview minutes={minutes} tax={tax} />
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

      <AssigneeField value={assignee} onChange={setAssignee} me={me} partner={partner} tone={tone} />

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
