"use client";

import { useState } from "react";
import {
  DEFAULT_CATEGORY,
  describePush,
  libraryCategories,
  NO_USAGE,
  resolveCategory,
  titleTaken,
  type LibraryUsage,
} from "@/lib/logic/library";
import { formatDelta } from "@/lib/logic/ledger";
import { DEFAULT_BOUNTY, ESTIMATE_STEPS, snapMinutes } from "@/lib/logic/points";
import { useHousehold } from "@/lib/store/household-store";
import type { ChoreLibraryItem, PricingType } from "@/lib/types";
import { Icon } from "../icons";
import { useToast } from "../toast";
import { fieldClass, primaryButton } from "../ui/controls";
import { CategoryCombobox } from "../ui/category-combobox";
import { Modal } from "../ui/modal";
import { PricingFields } from "../ui/points-controls";

type Props = {
  /** The chore to edit, or "new" to add one. null keeps the sheet closed. */
  target: ChoreLibraryItem | "new" | null;
  usage: LibraryUsage | undefined;
  onClose: () => void;
  onDelete: (chore: ChoreLibraryItem) => void;
};

export function ChoreFormSheet({ target, usage, onClose, onDelete }: Props) {
  if (!target) return null;
  return (
    <Modal open onClose={onClose} title={target === "new" ? "New chore" : "Edit chore"} variant="sheet">
      <Form key={target === "new" ? "new" : target.id} chore={target === "new" ? null : target} usage={usage} onClose={onClose} onDelete={onDelete} />
    </Modal>
  );
}

function Form({
  chore,
  usage,
  onClose,
  onDelete,
}: {
  chore: ChoreLibraryItem | null;
  usage: LibraryUsage | undefined;
  onClose: () => void;
  onDelete: (chore: ChoreLibraryItem) => void;
}) {
  const { state, actions } = useHousehold();
  const { toast } = useToast();

  const original = {
    title: chore?.title ?? "",
    // A new chore starts with no category picked; an existing one shows the category it has.
    category: chore ? chore.category?.trim() || DEFAULT_CATEGORY : "",
    minutes: chore ? snapMinutes(chore.default_duration) : 15,
    tax: chore?.chore_tax ?? 0,
    pricing: (chore?.pricing_type ?? "time_based") as PricingType,
    bounty: chore?.fixed_bounty_points ?? DEFAULT_BOUNTY,
  };
  const [title, setTitle] = useState(original.title);
  const [category, setCategory] = useState(original.category);
  const [minutes, setMinutes] = useState(original.minutes);
  const [tax, setTax] = useState(original.tax);
  const [pricing, setPricing] = useState<PricingType>(original.pricing);
  const [bounty, setBounty] = useState(original.bounty);
  const [reprice, setReprice] = useState(true);
  const [busy, setBusy] = useState(false);

  const name = title.trim();
  const taken = titleTaken(state.library, name, chore?.id);
  const changed =
    !chore || name !== original.title || (category.trim() || DEFAULT_CATEGORY) !== original.category ||
    minutes !== original.minutes ||
    tax !== original.tax ||
    pricing !== original.pricing ||
    bounty !== original.bounty;
  const canSave = !!name && !taken && changed && !busy;

  const categories = libraryCategories(state.library);
  const pushLines = chore
    ? describePush(
        { title: original.title, minutes: original.minutes, tax: original.tax, pricing: original.pricing, bounty: original.bounty },
        { title: name, minutes, tax, pricing, bounty },
        usage ?? NO_USAGE,
        reprice,
      )
    : [];
  // Finished chores are only re-priced when the value that priced them changed: the tax of a time-based chore or
  // the bounty of a fixed one (never a switch of model), so that is the only time the choice matters.
  const askReprice =
    !!chore &&
    (usage?.done ?? 0) > 0 &&
    pricing === original.pricing &&
    (pricing === "time_based" ? tax !== original.tax : bounty !== original.bounty);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    const input = {
      title: name,
      category: resolveCategory(categories, category) || DEFAULT_CATEGORY,
      minutes,
      tax,
      pricing,
      bounty,
    };
    if (!chore) {
      const ok = await actions.createLibraryChore(input);
      setBusy(false);
      if (!ok) return;
      onClose();
      toast(`Added ${name} to your library`, "success");
      return;
    }
    const result = await actions.updateLibraryChore(chore.id, input, { repriceFinished: reprice });
    setBusy(false);
    if (!result) return;
    onClose();
    const reached = [
      result.open > 0 ? `${result.open} on the calendar` : null,
      result.series > 0 ? `${result.series} repeating` : null,
    ].filter(Boolean);
    const ledger =
      result.done > 0
        ? `. Re-priced ${result.done} finished (${result.myDelta === 0 ? "your balance unchanged" : `you ${formatDelta(result.myDelta)} pts`}${
            result.theirDelta !== 0 ? `, partner ${formatDelta(result.theirDelta)}` : ""
          })`
        : "";
    toast(
      reached.length ? `Saved ${name}. Updated ${reached.join(" and ")}${ledger}` : `Saved ${name}${ledger}`,
      "success",
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <label className="flex flex-col gap-1.5 text-sm font-extrabold">
        Name
        <input
          required
          maxLength={60}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Clean the bathroom"
          aria-invalid={taken}
          aria-describedby={taken ? "name-taken" : undefined}
          className={fieldClass}
        />
        {taken && (
          <span id="name-taken" role="alert" className="text-xs font-bold text-danger">
            You already have a chore called &ldquo;{name}&rdquo;.
          </span>
        )}
      </label>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="manage-category" className="text-sm font-extrabold">
          Category
        </label>
        <CategoryCombobox id="manage-category" value={category} onChange={setCategory} categories={categories} />
      </div>

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
        timeLabel="Usual time"
        timeId="manage-minutes"
        timeAriaLabel="Usual minutes"
      />

      {chore && (
        <div className="rounded-2xl bg-raised px-4 py-3 text-sm" aria-live="polite">
          <p className="font-extrabold">{pushLines.length ? "Saving will also update the calendar" : "Across the board"}</p>
          {pushLines.length ? (
            <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5 font-semibold text-muted">
              {pushLines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-0.5 font-semibold text-muted">
              Change the name, time or tax and it&rsquo;s applied to this chore everywhere it is planned.
            </p>
          )}
          {askReprice && (
            <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 rounded-xl bg-surface px-3 py-2.5 text-sm font-bold">
              <input
                type="checkbox"
                checked={reprice}
                onChange={(e) => setReprice(e.target.checked)}
                className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--brand)]"
              />
              <span>
                Also re-price the {usage!.done} finished {usage!.done === 1 ? "chore" : "chores"}
                <span className="block text-xs font-semibold text-muted">
                  Balances adjust by the difference. Untick to leave past points as they were.
                </span>
              </span>
            </label>
          )}
        </div>
      )}

      <button type="submit" disabled={!canSave} className={`${primaryButton} min-h-14 text-lg`}>
        {busy ? "Saving…" : chore ? "Save changes" : "Add to library"}
      </button>

      {chore && (
        <button
          type="button"
          onClick={() => onDelete(chore)}
          className="flex min-h-12 items-center justify-center gap-2 rounded-2xl text-sm font-bold text-danger hover:bg-danger-soft"
        >
          <Icon name="trash" size={18} />
          Delete this chore
        </button>
      )}
    </form>
  );
}
