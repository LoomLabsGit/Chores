"use client";

import { useRef, useState } from "react";
import { DEFAULT_PRIORITY, PRIORITIES } from "@/lib/logic/backlog";
import { choreTotal, DEFAULT_BOUNTY, ESTIMATE_STEPS, snapMinutes } from "@/lib/logic/points";
import { formatMinutes } from "@/lib/logic/split";
import { useHousehold } from "@/lib/store/household-store";
import type { BacklogItem, BacklogPriority, PricingType } from "@/lib/types";
import { Icon } from "../icons";
import { useToast } from "../toast";
import { fieldClass, primaryButton, Segmented } from "../ui/controls";
import { ConfirmDialog, Modal } from "../ui/modal";
import { AssigneeField, PricingFields } from "../ui/points-controls";
import { PriorityDot } from "./priority";

/** The add / edit sheet for a backlog job. `target` is the job to edit, "new" to log one, or null when closed. */
export function JobSheet({ target, onClose }: { target: BacklogItem | "new" | null; onClose: () => void }) {
  if (!target) return null;
  return (
    <Modal open onClose={onClose} title={target === "new" ? "Add to backlog" : "Edit job"} variant="sheet">
      <Form key={target === "new" ? "new" : target.id} job={target === "new" ? null : target} onClose={onClose} />
    </Modal>
  );
}

function Form({ job, onClose }: { job: BacklogItem | null; onClose: () => void }) {
  const { me, partner, tone, actions } = useHousehold();
  const { toast } = useToast();
  const titleRef = useRef<HTMLInputElement>(null);

  const original = {
    title: job?.title ?? "",
    priority: (job?.priority ?? DEFAULT_PRIORITY) as BacklogPriority,
    assignee: job?.assigned_to ?? null,
    minutes: job ? snapMinutes(job.estimated_duration) : 15,
    tax: job?.chore_tax ?? 0,
    pricing: (job?.pricing_type ?? "time_based") as PricingType,
    bounty: job?.fixed_bounty_points ?? DEFAULT_BOUNTY,
  };
  const [title, setTitle] = useState(original.title);
  const [priority, setPriority] = useState(original.priority);
  const [assignee, setAssignee] = useState<string | null>(original.assignee);
  const [minutes, setMinutes] = useState(original.minutes);
  const [tax, setTax] = useState(original.tax);
  const [pricing, setPricing] = useState(original.pricing);
  const [bounty, setBounty] = useState(original.bounty);
  const [showTime, setShowTime] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const name = title.trim();
  const changed =
    !job ||
    name !== original.title ||
    priority !== original.priority ||
    assignee !== original.assignee ||
    minutes !== original.minutes ||
    tax !== original.tax ||
    pricing !== original.pricing ||
    bounty !== original.bounty;
  const canSave = !!name && changed && !busy;

  const points = choreTotal(minutes, {
    pricing_type: pricing,
    fixed_bounty_points: bounty,
    chore_tax: tax,
  });
  const summary =
    pricing === "fixed_bounty"
      ? `Fixed bounty · ${points} pts`
      : `${formatMinutes(minutes)}${tax > 0 ? ` + ${tax} tax` : ""} · ${points} pts`;

  const input = {
    title: name,
    priority,
    assignedTo: assignee,
    minutes,
    tax,
    pricing,
    bounty,
  };

  async function save(another: boolean) {
    if (!canSave) return;
    setBusy(true);
    if (job) {
      const ok = await actions.updateBacklogItem(job.id, input);
      setBusy(false);
      if (!ok) return;
      onClose();
      toast(`Saved ${name}`, "success");
      return;
    }
    const added = await actions.addBacklogItem(input);
    setBusy(false);
    if (!added) return;
    toast(`Added ${name} to the backlog`, "success");
    if (another) {
      // Keep the priority and person, so a run of similar jobs is quick to log.
      setTitle("");
      titleRef.current?.focus();
    } else {
      onClose();
    }
  }

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
        className="flex flex-col gap-5"
      >
        <label className="flex flex-col gap-1.5 text-sm font-extrabold">
          What needs doing?
          <input
            ref={titleRef}
            data-autofocus={job ? undefined : true}
            required
            maxLength={60}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Fix the leaking tap"
            enterKeyHint="done"
            className={fieldClass}
          />
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-extrabold">Priority</span>
          <Segmented
            label="Priority"
            value={String(priority)}
            onChange={(v) => setPriority(Number(v) as BacklogPriority)}
            options={PRIORITIES.map((p) => ({
              value: String(p.value),
              label: (
                <>
                  <PriorityDot priority={p.value} />
                  {p.label}
                </>
              ),
            }))}
          />
        </div>

        <AssigneeField
          value={assignee}
          onChange={setAssignee}
          me={me}
          partner={partner}
          tone={tone}
          label="For"
          unassignedHint="Nobody in particular: whoever has some free time can pick it up."
        />

        <div className="flex flex-col gap-4">
          <button
            type="button"
            aria-expanded={showTime}
            onClick={() => setShowTime((v) => !v)}
            className="flex min-h-12 items-center justify-between gap-3 rounded-2xl bg-raised px-4 text-left"
          >
            <span className="min-w-0">
              <span className="block text-sm font-extrabold">Time &amp; points</span>
              <span className="block truncate text-xs font-semibold text-muted">{summary}</span>
            </span>
            <Icon
              name="chevron-down"
              size={18}
              className={`shrink-0 text-muted transition-transform ${showTime ? "rotate-180" : ""}`}
            />
          </button>
          {showTime && (
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
              timeId="job-minutes"
            />
          )}
        </div>

        <button type="submit" disabled={!canSave} className={`${primaryButton} min-h-14 text-lg`}>
          {busy ? "Saving…" : job ? "Save changes" : "Add to backlog"}
        </button>

        {!job && (
          <button
            type="button"
            disabled={!canSave}
            onClick={() => void save(true)}
            className="-mt-2 flex min-h-12 items-center justify-center gap-2 rounded-2xl text-sm font-bold text-brand hover:bg-brand-soft disabled:opacity-40"
          >
            <Icon name="plus" size={18} strokeWidth={2.6} />
            Add and log another
          </button>
        )}

        {job && (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="-mt-2 flex min-h-12 items-center justify-center gap-2 rounded-2xl text-sm font-bold text-danger hover:bg-danger-soft"
          >
            <Icon name="trash" size={18} />
            Delete this job
          </button>
        )}
      </form>
      {/* Outside the form, so its buttons can never submit it. */}
      {job && (
        <ConfirmDialog
          open={confirmDelete}
          title="Delete this job?"
          message={`“${job.title}” comes off the backlog for both of you.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            onClose();
            void actions.removeBacklogItem(job.id).then((ok) => ok && toast(`Deleted ${job.title}`));
          }}
        />
      )}
    </>
  );
}
