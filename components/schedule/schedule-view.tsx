"use client";

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useEffect, useMemo, useState } from "react";
import {
  addDays,
  dayOfMonth,
  formatLongDay,
  formatWeekTitle,
  startOfWeek,
  todayISO,
  weekdayShort,
  weekDays,
} from "@/lib/logic/dates";
import { useMediaQuery } from "@/lib/use-media-query";
import { useHousehold } from "@/lib/store/household-store";
import type { ChoreCompletion, ChoreInstance } from "@/lib/types";
import { Icon } from "../icons";
import { useToast } from "../toast";
import { Avatar, EmptyState, TONE_SOFT } from "../ui/controls";
import { AddChoreSheet } from "./add-chore-sheet";
import { ChoreCard, ChoreCardView } from "./chore-card";
import { CompleteSheet } from "./complete-sheet";
import { ConfirmDialog } from "../ui/modal";

// Pointer position decides the drop target; rect overlap is the keyboard fallback (no pointer).
const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length ? within : rectIntersection(args);
};

export function ScheduleView() {
  const { state, me, nameOf, actions } = useHousehold();
  const { toast } = useToast();
  const isDesktop = useMediaQuery("(min-width: 1024px)");

  const [today] = useState(() => todayISO());
  const [weekStart, setWeekStart] = useState(() => startOfWeek(today));
  const [selected, setSelected] = useState(today);
  const [addOpen, setAddOpen] = useState(false);
  const [completing, setCompleting] = useState<ChoreInstance | null>(null);
  const [removing, setRemoving] = useState<ChoreInstance | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const days = useMemo(() => weekDays(weekStart), [weekStart]);
  const weekEnd = days[6];

  useEffect(() => {
    void actions.loadWeek(weekStart, weekEnd);
  }, [actions, weekStart, weekEnd]);

  const byDate = useMemo(() => {
    const map: Record<string, ChoreInstance[]> = Object.fromEntries(days.map((d) => [d, []]));
    for (const inst of Object.values(state.instances)) map[inst.scheduled_date]?.push(inst);
    for (const list of Object.values(map)) {
      list.sort((a, b) => Number(a.is_completed) - Number(b.is_completed) || a.title.localeCompare(b.title));
    }
    return map;
  }, [state.instances, days]);

  const sensors = useSensors(
    // The grip button is the only activator, so a small distance is enough to tell a tap from a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const dragging = dragId ? state.instances[dragId] : undefined;

  function goToWeek(nextStart: string, nextSelected: string) {
    setWeekStart(nextStart);
    setSelected(nextSelected);
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    setDragId(null);
    const inst = state.instances[String(active.id)];
    if (!inst || !over) return;
    const target = String(over.id);
    if (target.startsWith("day:")) {
      const date = target.slice(4);
      if (date === inst.scheduled_date) return;
      void actions
        .moveInstance(inst.id, { scheduled_date: date })
        .then((ok) => ok && toast(`Moved ${inst.title} to ${formatLongDay(date)}`));
    } else if (target.startsWith("user:")) {
      const uid = target.slice(5);
      if (uid === inst.assigned_to) return;
      void actions
        .moveInstance(inst.id, { assigned_to: uid })
        .then((ok) => ok && toast(`${inst.title} is now ${uid === me.id ? "yours" : `${nameOf(uid)}'s`}`));
    }
  }

  const selectedList = byDate[selected] ?? [];

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={(e) => setDragId(String(e.active.id))}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragId(null)}
    >
      <div className="flex flex-col gap-3">
        <WeekHeader
          title={formatWeekTitle(weekStart)}
          onPrev={() => goToWeek(addDays(weekStart, -7), addDays(selected, -7))}
          onNext={() => goToWeek(addDays(weekStart, 7), addDays(selected, 7))}
          onToday={() => goToWeek(startOfWeek(today), today)}
          isCurrentWeek={weekStart === startOfWeek(today)}
        />

        {isDesktop ? (
          <div className="grid grid-cols-7 gap-3">
            {days.map((d) => (
              <DayColumn
                key={d}
                date={d}
                today={today}
                selected={selected === d}
                instances={byDate[d]}
                onSelect={() => setSelected(d)}
                onOpen={setCompleting}
                onRemove={setRemoving}
              />
            ))}
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
            <div className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-20 -mx-4 bg-app px-4 pb-2 pt-1">
              <div className="grid grid-cols-7 gap-1.5" role="tablist" aria-label="Days of the week">
                {days.map((d) => (
                  <DayChip
                    key={d}
                    date={d}
                    today={today}
                    selected={selected === d}
                    instances={byDate[d]}
                    onSelect={() => setSelected(d)}
                  />
                ))}
              </div>
            </div>

            <section aria-label={formatLongDay(selected)} className="flex flex-col gap-2.5">
              <div className="flex items-baseline justify-between px-1">
                <h2 className="text-lg font-extrabold">{selected === today ? "Today" : formatLongDay(selected)}</h2>
                <p className="text-sm font-semibold text-muted">
                  {selectedList.length
                    ? `${selectedList.filter((i) => i.is_completed).length} of ${selectedList.length} done`
                    : formatLongDay(selected)}
                </p>
              </div>
              {selectedList.length === 0 ? (
                <EmptyState icon={<Icon name="calendar" size={26} />} title="Nothing planned">
                  Tap <b>Add Chore</b> to plan something for {selected === today ? "today" : formatLongDay(selected)}.
                </EmptyState>
              ) : (
                selectedList.map((inst) => (
                  <ChoreCard key={inst.id} instance={inst} overdue={inst.scheduled_date < today} onOpen={setCompleting} onRemove={setRemoving} />
                ))
              )}
            </section>
          </div>
        )}
      </div>

      <DragOverlay dropAnimation={null}>
        {dragging ? (
          <div className="w-[min(22rem,90vw)]">
            <ChoreCardView instance={dragging} overdue={false} onOpen={() => {}} floating />
          </div>
        ) : null}
      </DragOverlay>

      {/* Always mounted (so droppable rects are measured) but only visible mid-drag. */}
      <AssignDock visible={!!dragId} currentAssignee={dragging?.assigned_to ?? null} />

      <button
        onClick={() => setAddOpen(true)}
        className={`fixed bottom-[calc(env(safe-area-inset-bottom)+5rem)] right-4 z-30 flex h-14 items-center gap-2 rounded-full bg-brand pl-4 pr-5 text-base font-extrabold text-brand-ink shadow-sheet transition-all active:scale-95 md:bottom-8 md:right-8 ${
          dragId ? "pointer-events-none translate-y-4 opacity-0" : ""
        }`}
      >
        <Icon name="plus" size={24} strokeWidth={2.6} />
        Add Chore
      </button>

      <AddChoreSheet open={addOpen} date={selected} onClose={() => setAddOpen(false)} />
      <CompleteSheet instance={completing} onClose={() => setCompleting(null)} />
      <ConfirmDialog
        open={!!removing}
        title="Remove completed chore?"
        message={removeMessage(removing, state.completions, nameOf)}
        confirmLabel="Remove"
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const inst = removing;
          setRemoving(null);
          if (inst) void actions.removeInstance(inst.id).then((ok) => ok && toast(`Removed ${inst.title}`));
        }}
      />
    </DndContext>
  );
}

function WeekHeader({
  title,
  onPrev,
  onNext,
  onToday,
  isCurrentWeek,
}: {
  title: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  isCurrentWeek: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h1 className="min-w-0 truncate text-xl font-extrabold tracking-tight md:text-2xl">{title}</h1>
      <div className="flex items-center gap-1">
        <button
          onClick={onToday}
          disabled={isCurrentWeek}
          className="min-h-11 rounded-full px-4 text-sm font-extrabold text-brand hover:bg-brand-soft disabled:text-muted disabled:hover:bg-transparent"
        >
          Today
        </button>
        <button
          onClick={onPrev}
          aria-label="Previous week"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-surface shadow-card"
        >
          <Icon name="chevron-left" />
        </button>
        <button
          onClick={onNext}
          aria-label="Next week"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-surface shadow-card"
        >
          <Icon name="chevron-right" />
        </button>
      </div>
    </div>
  );
}

/** Mobile: a compact tappable day that is also a drop target for rescheduling. */
function DayChip({
  date,
  today,
  selected,
  instances,
  onSelect,
}: {
  date: string;
  today: string;
  selected: boolean;
  instances: ChoreInstance[];
  onSelect: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${date}` });
  const open = instances.filter((i) => !i.is_completed).length;
  const done = instances.length - open;
  const isToday = date === today;

  return (
    <button
      ref={setNodeRef}
      role="tab"
      aria-selected={selected}
      aria-label={`${formatLongDay(date)}, ${instances.length} ${instances.length === 1 ? "chore" : "chores"}`}
      onClick={onSelect}
      className={`flex min-h-[4.5rem] flex-col items-center justify-center gap-0.5 rounded-2xl border-2 py-1.5 transition-colors ${
        isOver
          ? "border-brand bg-brand-soft"
          : selected
            ? "border-brand bg-brand text-brand-ink"
            : "border-transparent bg-surface shadow-card"
      }`}
    >
      <span className={`text-[10px] font-extrabold uppercase tracking-wide ${selected && !isOver ? "" : "text-muted"}`}>
        {weekdayShort(date)}
      </span>
      <span className={`text-lg font-extrabold leading-none ${isToday && !selected ? "text-brand" : ""}`}>
        {dayOfMonth(date)}
      </span>
      <span className="flex h-2 items-center gap-0.5" aria-hidden>
        {Array.from({ length: Math.min(open, 3) }, (_, i) => (
          <span key={`o${i}`} className={`h-1.5 w-1.5 rounded-full ${selected && !isOver ? "bg-brand-ink" : "bg-brand"}`} />
        ))}
        {Array.from({ length: Math.min(done, Math.max(0, 3 - Math.min(open, 3))) }, (_, i) => (
          <span key={`d${i}`} className="h-1.5 w-1.5 rounded-full bg-ok" />
        ))}
      </span>
    </button>
  );
}

/** Desktop: one column per day; the whole column is the drop target. */
function DayColumn({
  date,
  today,
  selected,
  instances,
  onSelect,
  onOpen,
  onRemove,
}: {
  date: string;
  today: string;
  selected: boolean;
  instances: ChoreInstance[];
  onSelect: () => void;
  onOpen: (i: ChoreInstance) => void;
  onRemove: (i: ChoreInstance) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${date}` });
  const isToday = date === today;

  return (
    <section
      ref={setNodeRef}
      aria-label={formatLongDay(date)}
      className={`flex min-h-[20rem] flex-col gap-2 rounded-3xl border-2 p-2 transition-colors ${
        isOver ? "border-brand bg-brand-soft" : selected ? "border-brand/50 bg-surface/60" : "border-transparent bg-surface/40"
      }`}
    >
      <button
        onClick={onSelect}
        aria-pressed={selected}
        className={`flex min-h-11 flex-col items-center rounded-2xl py-1.5 ${isToday ? "bg-brand text-brand-ink" : "hover:bg-raised"}`}
      >
        <span className={`text-[11px] font-extrabold uppercase tracking-wide ${isToday ? "" : "text-muted"}`}>
          {weekdayShort(date)}
        </span>
        <span className="text-xl font-extrabold leading-tight">{dayOfMonth(date)}</span>
      </button>
      {instances.length === 0 ? (
        <p className="px-2 pt-4 text-center text-xs font-semibold text-muted">Free day</p>
      ) : (
        instances.map((inst) => (
          <ChoreCard key={inst.id} instance={inst} overdue={inst.scheduled_date < today} onOpen={onOpen} onRemove={onRemove} compact />
        ))
      )}
    </section>
  );
}

/** Appears mid-drag: drop a card on a person to hand the chore to them. */
function AssignDock({ visible, currentAssignee }: { visible: boolean; currentAssignee: string | null }) {
  const { state, tone } = useHousehold();
  return (
    <div
      aria-hidden={!visible}
      className={`pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] z-[45] flex justify-center px-4 transition-opacity md:bottom-6 md:pl-28 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="flex w-full max-w-md gap-3 rounded-[2rem] bg-surface/95 p-2.5 shadow-sheet backdrop-blur">
        {state.members.map((m) => (
          <AssignZone key={m.id} id={m.id} name={m.display_name} tone={tone(m.id)} current={currentAssignee === m.id} />
        ))}
      </div>
    </div>
  );
}

function AssignZone({ id, name, tone, current }: { id: string; name: string; tone: "a" | "b"; current: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `user:${id}` });
  return (
    <div
      ref={setNodeRef}
      className={`flex min-h-16 flex-1 items-center justify-center gap-2.5 rounded-3xl border-2 border-dashed px-3 text-sm font-extrabold transition-all ${
        isOver ? `scale-105 border-transparent ${TONE_SOFT[tone]}` : "border-line text-muted"
      }`}
    >
      <Avatar name={name} tone={tone} size={36} />
      <span className="min-w-0 truncate">
        {current ? `${name} (assigned)` : `Give to ${name}`}
      </span>
    </div>
  );
}

/** Spells out exactly whose points will be taken back before the user confirms. */
function removeMessage(
  inst: ChoreInstance | null,
  completions: Record<string, ChoreCompletion>,
  nameOf: (id: string | null) => string,
): string {
  if (!inst) return "";
  const c = completions[inst.id];
  const takeBack = c
    ? [
        [c.user_a_id, c.user_a_points],
        ...(c.user_b_id !== c.user_a_id ? [[c.user_b_id, c.user_b_points]] : []),
      ]
        .filter(([, pts]) => (pts as number) > 0)
        .map(([id, pts]) => `${nameOf(id as string)} \u2212${pts}`)
    : [];
  return takeBack.length
    ? `"${inst.title}" will be deleted and its points taken back (${takeBack.join(", ")}). It will also disappear from Stats.`
    : `"${inst.title}" will be deleted. It will also disappear from Stats.`;
}
