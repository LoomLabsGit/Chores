import { priorityLabel } from "@/lib/logic/backlog";
import type { BacklogPriority } from "@/lib/types";

/** Colour for each priority. The word always travels with it, so colour is never the only signal. */
export const PRIORITY_DOT: Record<BacklogPriority, string> = {
  3: "bg-danger",
  2: "bg-warn",
  1: "bg-muted/60",
};

export const PRIORITY_TEXT: Record<BacklogPriority, string> = {
  3: "text-danger",
  2: "text-warn",
  1: "text-muted",
};

/** A small coloured dot standing for a priority (decorative: pair it with the word). */
export function PriorityDot({ priority, className = "" }: { priority: BacklogPriority; className?: string }) {
  return <span aria-hidden className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${PRIORITY_DOT[priority]} ${className}`} />;
}

/** "High priority" etc., with its dot. */
export function PriorityLabel({ priority }: { priority: BacklogPriority }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${PRIORITY_TEXT[priority]}`}>
      <PriorityDot priority={priority} />
      {priorityLabel(priority)}
    </span>
  );
}
