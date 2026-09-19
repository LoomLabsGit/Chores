"use client";

import { useDraggable } from "@dnd-kit/core";
import { formatMinutes } from "@/lib/logic/split";
import { useHousehold } from "@/lib/store/household-store";
import type { ChoreInstance } from "@/lib/types";
import { Icon } from "../icons";
import { Avatar } from "../ui/controls";

type Props = {
  instance: ChoreInstance;
  overdue: boolean;
  onOpen: (i: ChoreInstance) => void;
  /** Narrow vertical layout for the seven-column desktop board. */
  compact?: boolean;
  /** Shown as a trash button on completed cards. */
  onRemove?: (i: ChoreInstance) => void;
};

/** Draggable card. The 44px grip is the only drag activator, so the rest of the card scrolls and taps normally on touch. */
export function ChoreCard({ instance, overdue, onOpen, compact, onRemove }: Props) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: instance.id,
    disabled: instance.is_completed,
  });

  const handle = instance.is_completed ? (
    onRemove ? (
      <button
        onClick={() => onRemove(instance)}
        aria-label={`Remove completed chore ${instance.title}`}
        className="flex h-11 w-9 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-danger-soft hover:text-danger"
      >
        <Icon name="trash" size={18} />
      </button>
    ) : (
      <span aria-hidden className="h-11 w-2 shrink-0" />
    )
  ) : (
    <button
      ref={setActivatorNodeRef}
      {...listeners}
      {...attributes}
      aria-label={`Drag ${instance.title} to another day or partner`}
      className="flex h-11 w-9 shrink-0 cursor-grab touch-none items-center justify-center rounded-xl text-muted hover:bg-raised active:cursor-grabbing"
    >
      <Icon name="grip" size={20} />
    </button>
  );

  return (
    <div ref={setNodeRef} className={isDragging ? "opacity-30" : undefined}>
      <ChoreCardView instance={instance} overdue={overdue} onOpen={onOpen} handle={handle} compact={compact} />
    </div>
  );
}

export function ChoreCardView({
  instance,
  overdue,
  onOpen,
  handle,
  floating,
  compact,
}: Props & { handle?: React.ReactNode; floating?: boolean }) {
  const { state, tone, nameOf } = useHousehold();
  const completion = state.completions[instance.id];
  const done = instance.is_completed;

  const contributors = completion
    ? [
        completion.user_a_duration + completion.user_a_points > 0 ? completion.user_a_id : null,
        completion.user_b_id !== completion.user_a_id && completion.user_b_duration + completion.user_b_points > 0
          ? completion.user_b_id
          : null,
      ].filter((x): x is string => !!x)
    : [];

  const title = (
    <span
      className={`block font-extrabold leading-tight ${
        compact ? "line-clamp-2 break-words text-sm" : "truncate text-[15px]"
      } ${done ? "text-muted line-through decoration-2" : ""}`}
    >
      {instance.title}
    </span>
  );

  const meta = (
    <span
      className={`mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-bold text-muted ${compact ? "text-[11px]" : "text-xs"}`}
    >
      {done ? (
        <>
          <span className="flex items-center">
            {contributors.map((id, i) => (
              <span key={id} className={i ? "-ml-1.5" : ""}>
                <Avatar name={nameOf(id)} tone={tone(id)} size={18} ring />
              </span>
            ))}
          </span>
          {completion && <span>{formatMinutes(completion.total_duration_minutes)}</span>}
          <span className="text-ok">Done</span>
        </>
      ) : (
        <>
          <span className="flex items-center gap-1">
            <Avatar name={nameOf(instance.assigned_to)} tone={tone(instance.assigned_to)} size={18} />
            {!compact && nameOf(instance.assigned_to)}
          </span>
          <span className="flex items-center gap-0.5 text-gold">
            <Icon name="star" size={11} />
            {instance.points_assigned}
          </span>
          {instance.is_recurring && (
            <span className="flex items-center" role="img" aria-label="Repeats" title="Repeats">
              <Icon name="repeat" size={12} />
            </span>
          )}
          {overdue && <span className="rounded-full bg-warn-soft px-1.5 py-0.5 text-warn">Overdue</span>}
        </>
      )}
    </span>
  );

  const openButton = (
    <button
      onClick={() => !done && onOpen(instance)}
      disabled={done}
      aria-label={done ? undefined : `Complete ${instance.title}`}
      className={`min-h-11 min-w-0 text-left disabled:cursor-default ${
        compact ? "block w-full rounded-t-xl px-2.5 pb-1 pt-2.5" : "flex-1 rounded-xl px-1.5 py-1.5"
      }`}
    >
      {title}
      {meta}
    </button>
  );

  const check = done ? (
    <span
      aria-label="Completed"
      role="img"
      className="anim-check flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ok"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ok text-white">
        <Icon name="check" size={18} strokeWidth={3} />
      </span>
    </span>
  ) : (
    <button
      onClick={() => onOpen(instance)}
      aria-label={`Mark ${instance.title} complete`}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
    >
      <span className="h-8 w-8 rounded-full border-2 border-line bg-surface transition-colors hover:border-ok" />
    </button>
  );

  return (
    <article
      className={`rounded-2xl border bg-surface ${compact ? "flex flex-col" : "flex items-center gap-0.5 p-1 pr-1.5"} ${
        floating ? "rotate-1 border-brand shadow-sheet" : "shadow-card"
      } ${overdue && !done ? "border-warn/50" : "border-line"} ${done ? "bg-raised" : ""}`}
    >
      {compact ? (
        <>
          {openButton}
          <div className="flex items-center justify-between px-0.5 pb-0.5">
            {handle}
            {check}
          </div>
        </>
      ) : (
        <>
          {handle}
          {openButton}
          {check}
        </>
      )}
    </article>
  );
}
