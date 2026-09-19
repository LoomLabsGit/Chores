"use client";

import { useState } from "react";
import type { LibraryUsage } from "@/lib/logic/library";
import { useHousehold } from "@/lib/store/household-store";
import type { ChoreLibraryItem } from "@/lib/types";
import { useToast } from "../toast";
import { Modal } from "../ui/modal";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * Deleting a chore from the library. When it is still planned on the calendar the person chooses
 * whether those unfinished copies go too; finished chores and points already earned are always kept.
 */
export function DeleteChoreSheet({
  chore,
  usage,
  onCancel,
  onDeleted,
}: {
  chore: ChoreLibraryItem | null;
  usage: LibraryUsage | undefined;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const { actions } = useHousehold();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const open = usage?.open ?? 0;
  const repeating = usage?.repeating ?? 0;

  async function run(removeOpen: boolean) {
    if (!chore) return;
    setBusy(true);
    const removed = await actions.deleteLibraryChore(chore.id, removeOpen);
    setBusy(false);
    if (removed === null) return;
    onDeleted();
    toast(
      removed > 0
        ? `Deleted ${chore.title} and removed ${plural(removed, "chore")} from the calendar`
        : `Deleted ${chore.title}`,
      "success",
    );
  }

  return (
    <Modal open={!!chore} onClose={busy ? () => {} : onCancel} title={chore ? `Delete ${chore.title}?` : "Delete chore"} variant="center">
      <div className="flex flex-col gap-4">
        <p className="text-[15px] leading-relaxed text-muted">
          It is removed from your library and can&rsquo;t be picked when adding a chore. Finished chores and the points they
          earned are kept.
          {repeating > 0 && " It also stops repeating."}
        </p>
        {open > 0 && (
          <p className="rounded-2xl bg-warn-soft px-4 py-3 text-sm font-bold text-warn">
            {plural(open, "unfinished chore")} still on the calendar.
          </p>
        )}
        <div className="flex flex-col gap-2">
          {open > 0 ? (
            <>
              <button
                onClick={() => run(true)}
                disabled={busy}
                className="min-h-12 rounded-2xl bg-danger px-4 font-bold text-white disabled:opacity-50"
              >
                Delete and remove {open === 1 ? "it" : `all ${open}`} from the calendar
              </button>
              <button
                onClick={() => run(false)}
                disabled={busy}
                className="min-h-12 rounded-2xl border border-line px-4 font-bold hover:bg-raised disabled:opacity-50"
              >
                Delete, but keep {open === 1 ? "it" : "them"} on the calendar
              </button>
            </>
          ) : (
            <button
              onClick={() => run(false)}
              disabled={busy}
              className="min-h-12 rounded-2xl bg-danger px-4 font-bold text-white disabled:opacity-50"
            >
              Delete
            </button>
          )}
          <button
            onClick={onCancel}
            disabled={busy}
            data-autofocus
            className="min-h-12 rounded-2xl px-4 font-bold text-muted hover:bg-raised disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
