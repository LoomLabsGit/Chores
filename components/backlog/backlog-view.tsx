"use client";

import { useMemo, useState } from "react";
import {
  describeCount,
  filterBacklog,
  groupByPriority,
  isFiltering,
  NO_FILTER,
  PRIORITIES,
  priorityLabel,
  type BacklogFilter,
  type BacklogWho,
} from "@/lib/logic/backlog";
import { estimatePoints } from "@/lib/logic/points";
import { formatMinutes } from "@/lib/logic/split";
import { useHousehold } from "@/lib/store/household-store";
import type { BacklogItem, BacklogPriority } from "@/lib/types";
import { Icon } from "../icons";
import { Avatar, EmptyState, fieldClass, primaryButton } from "../ui/controls";
import { FilterChips } from "../ui/filter-chips";
import { JobSheet } from "./job-sheet";
import { PriorityDot } from "./priority";
import { ScheduleJobSheet } from "./schedule-job-sheet";

/**
 * The shared backlog: jobs that need doing, most pressing first, waiting for a free hour. Tap a job to edit it,
 * or "Schedule" to put it on the calendar (where it becomes an ordinary one-off chore and leaves this list).
 */
export function BacklogView() {
  const { state, me, partner } = useHousehold();
  const [filter, setFilter] = useState<BacklogFilter>(NO_FILTER);
  const [editing, setEditing] = useState<BacklogItem | "new" | null>(null);
  const [planning, setPlanning] = useState<BacklogItem | null>(null);

  const total = state.backlog.length;
  const shown = useMemo(() => filterBacklog(state.backlog, filter, me.id), [state.backlog, filter, me.id]);
  const groups = useMemo(() => groupByPriority(shown), [shown]);
  const filtering = isFiltering(filter);

  const whoOptions: { value: BacklogWho; label: string }[] = [
    { value: "all", label: "Anyone" },
    { value: "mine", label: "Mine" },
    ...(partner ? [{ value: "partner" as const, label: partner.display_name }] : []),
    { value: "open", label: "Unassigned" },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Backlog</h1>
          <p className="mt-1 max-w-prose text-sm font-semibold text-muted">
            Jobs that need doing, most pressing first. Pick one up when you have a free hour and put it on the calendar.
          </p>
        </div>
        <button onClick={() => setEditing("new")} className={`${primaryButton} min-h-11 shrink-0 px-4`}>
          <Icon name="plus" size={20} strokeWidth={2.6} />
          Add
        </button>
      </div>

      {total === 0 ? (
        <EmptyState icon={<Icon name="list" size={26} />} title="Nothing waiting">
          Log the jobs that need doing, like fixing the tap or clearing the gutters. Then schedule them whenever you have time.
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <input
              type="search"
              value={filter.query}
              onChange={(e) => setFilter({ ...filter, query: e.target.value })}
              placeholder="Search the backlog"
              aria-label="Search the backlog"
              className={fieldClass}
            />
            <FilterChips<BacklogPriority | null>
              label="Filter by priority"
              value={filter.priority}
              onChange={(priority) => setFilter({ ...filter, priority })}
              className="-mx-4 px-4 md:mx-0 md:flex-wrap md:px-0"
              options={[
                { value: null, label: "All" },
                ...PRIORITIES.map((p) => ({
                  value: p.value as BacklogPriority | null,
                  label: (
                    <>
                      <PriorityDot priority={p.value} />
                      {p.label}
                    </>
                  ),
                })),
              ]}
            />
            <FilterChips<BacklogWho>
              label="Filter by who it is for"
              value={filter.who}
              onChange={(who) => setFilter({ ...filter, who })}
              className="-mx-4 px-4 md:mx-0 md:flex-wrap md:px-0"
              options={whoOptions}
            />
            <div className="flex min-h-6 items-center justify-between gap-3">
              <p className="text-xs font-extrabold uppercase tracking-wide text-muted" aria-live="polite">
                {describeCount(shown.length, total)}
              </p>
              {filtering && (
                <button
                  onClick={() => setFilter(NO_FILTER)}
                  className="-my-2 min-h-11 rounded-full px-3 text-sm font-bold text-brand hover:bg-brand-soft"
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>

          {shown.length === 0 ? (
            <EmptyState icon={<Icon name="list" size={26} />} title="No jobs match">
              Try a different search, or clear the filters to see everything.
            </EmptyState>
          ) : (
            groups.map((g) => (
              <section key={g.priority} aria-label={`${priorityLabel(g.priority)} priority`} className="flex flex-col gap-2.5">
                <h2 className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wide text-muted">
                  <PriorityDot priority={g.priority} />
                  {priorityLabel(g.priority)} priority
                  <span className="font-bold">{g.items.length}</span>
                </h2>
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {g.items.map((job) => (
                    <JobRow key={job.id} job={job} onEdit={() => setEditing(job)} onPlan={() => setPlanning(job)} />
                  ))}
                </ul>
              </section>
            ))
          )}
        </>
      )}

      <JobSheet target={editing} onClose={() => setEditing(null)} />
      <ScheduleJobSheet job={planning} onClose={() => setPlanning(null)} />
    </div>
  );
}

function JobRow({ job, onEdit, onPlan }: { job: BacklogItem; onEdit: () => void; onPlan: () => void }) {
  const { tone, nameOf } = useHousehold();
  const points = estimatePoints(job);
  const bounty = job.pricing_type === "fixed_bounty";

  return (
    <li className="flex items-center gap-1 rounded-3xl border border-line bg-surface p-2 pl-4 shadow-card">
      <button onClick={onEdit} aria-label={`Edit ${job.title}`} className="min-h-12 min-w-0 flex-1 py-2 text-left">
        <span className="line-clamp-2 break-words text-base font-extrabold leading-tight">{job.title}</span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-bold text-muted">
          {job.assigned_to ? (
            <span className="flex items-center gap-1">
              <Avatar name={nameOf(job.assigned_to)} tone={tone(job.assigned_to)} size={18} />
              {nameOf(job.assigned_to)}
            </span>
          ) : (
            <span className="rounded-full px-2 py-0.5 text-[11px] font-extrabold uppercase tracking-wide text-muted ring-1 ring-inset ring-muted/40">
              Unassigned
            </span>
          )}
          <span
            className="flex items-center gap-0.5 rounded-full bg-gold-soft px-1.5 py-0.5 text-gold"
            aria-label={bounty ? `Fixed bounty of ${points} points` : `Worth about ${points} points`}
          >
            <Icon name="bolt" size={11} />
            {points} pts
          </span>
          {!bounty && <span>{formatMinutes(job.estimated_duration)}</span>}
        </span>
      </button>
      <button
        onClick={onPlan}
        aria-label={`Add ${job.title} to the calendar`}
        className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-brand-soft px-3.5 text-sm font-extrabold text-brand active:scale-95"
      >
        <Icon name="calendar" size={16} />
        Schedule
      </button>
    </li>
  );
}
