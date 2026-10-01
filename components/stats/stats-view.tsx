"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { todayISO } from "@/lib/logic/dates";
import { formatMinutes } from "@/lib/logic/split";
import {
  computeStats,
  DEFAULT_TIMEFRAME,
  splitPercents,
  TIMEFRAMES,
  timeframeStart,
  type StatsResult,
  type Timeframe,
} from "@/lib/logic/stats";
import { useHousehold, type StatsData } from "@/lib/store/household-store";
import { Icon } from "../icons";
import { EmptyState, TONE_BAR } from "../ui/controls";

export function StatsView() {
  const { state, actions } = useHousehold();
  const [tf, setTf] = useState<Timeframe>(DEFAULT_TIMEFRAME);
  const [today] = useState(() => todayISO());
  const [data, setData] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const start = timeframeStart(tf, today);
  const caption = TIMEFRAMES.find((t) => t.id === tf)!.caption;

  useEffect(() => {
    let stale = false;
    setLoading(true);
    void actions.loadStats(start).then((d) => {
      if (stale) return;
      if (d) setData(d);
      setLoading(false);
    });
    return () => {
      stale = true;
    };
  }, [actions, start]);

  const stats = useMemo(
    () =>
      data &&
      computeStats({
        memberIds: state.members.map((m) => m.id),
        completions: data.completions,
        instances: data.instances,
        library: state.library,
        challenges: state.challenges,
        redemptions: state.redemptions,
        start,
      }),
    [data, state.members, state.library, state.challenges, state.redemptions, start],
  );

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-extrabold tracking-tight">Stats &amp; insights</h1>

      {/* One filter row above everything it scopes. */}
      <div
        role="tablist"
        aria-label="Timeframe"
        className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:px-0"
      >
        {TIMEFRAMES.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tf === t.id}
            onClick={() => setTf(t.id)}
            className={`min-h-11 shrink-0 rounded-full px-4 text-sm font-extrabold transition-colors ${
              tf === t.id ? "bg-brand text-brand-ink" : "bg-surface text-muted shadow-card"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Refetch keeps the frame: previous render stays, dimmed, until new data lands. */}
      <div className={`flex flex-col gap-4 transition-opacity ${loading ? "opacity-50" : ""}`} aria-busy={loading}>
        {!stats ? (
          loading ? null : (
            <EmptyState icon={<Icon name="chart" size={26} />} title="Couldn't load stats">
              Check your connection and try another timeframe.
            </EmptyState>
          )
        ) : stats.completionCount === 0 && stats.perUser && Object.values(stats.perUser).every((u) => u.earned + u.spent === 0) ? (
          <EmptyState icon={<Icon name="chart" size={26} />} title="Nothing logged yet">
            {caption}: complete a chore and your effort split, time and points will appear here.
          </EmptyState>
        ) : (
          <Charts stats={stats} caption={caption} />
        )}
      </div>
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
      <h2 className="text-base font-extrabold">{title}</h2>
      {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Charts({ stats, caption }: { stats: StatsResult; caption: string }) {
  const { state, tone } = useHousehold();
  const members = state.members.map((m) => ({ id: m.id, name: m.display_name, tone: tone(m.id) }));
  const memberIds = members.map((m) => m.id);
  const catMax = Math.max(1, ...stats.categories.map((c) => c.minutes));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Effort split" subtitle={`Share of time logged · ${caption}`}>
        {stats.split ? (
          <>
            <StackedBar
              label="Effort split"
              segments={members.map((m) => ({
                key: m.id,
                value: stats.perUser[m.id].minutes,
                className: TONE_BAR[m.tone],
                title: `${m.name}: ${stats.split![m.id]}% (${formatMinutes(stats.perUser[m.id].minutes)})`,
              }))}
            />
            <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
              {members.map((m) => (
                <li key={m.id} className="flex items-center gap-2 text-sm">
                  <span className={`h-2.5 w-2.5 rounded-full ${TONE_BAR[m.tone]}`} aria-hidden />
                  <span className="font-bold">{m.name}</span>
                  <span className="font-extrabold tabular-nums">{stats.split![m.id]}%</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-muted">No time logged in this period.</p>
        )}
      </Card>

      <Card title="Time logged" subtitle={caption}>
        <div className="grid grid-cols-2 gap-3">
          {members.map((m) => (
            <div key={m.id} className="rounded-2xl bg-raised p-4">
              <p className="flex items-center gap-2 text-sm font-bold text-muted">
                <span className={`h-2.5 w-2.5 rounded-full ${TONE_BAR[m.tone]}`} aria-hidden />
                {m.name}
              </p>
              <p className="mt-1 text-3xl font-extrabold leading-tight">{formatMinutes(stats.perUser[m.id].minutes)}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-sm text-muted">
          Together: <span className="font-extrabold text-ink">{formatMinutes(stats.totalMinutes)}</span> across{" "}
          {stats.completionCount} {stats.completionCount === 1 ? "chore" : "chores"}
        </p>
      </Card>

      <Card title="Where the time goes" subtitle={`Hours by chore type · ${caption}`}>
        {stats.categories.length === 0 ? (
          <p className="text-sm text-muted">No time logged in this period.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {stats.categories.map((c) => (
              <HBar
                key={c.category}
                label={c.category}
                value={c.minutes}
                max={catMax}
                text={formatMinutes(c.minutes)}
                className="bg-brand"
              />
            ))}
          </div>
        )}
      </Card>

      <Card title="Time split by category" subtitle={`Each partner's share of every chore type · ${caption}`}>
        {stats.categories.length === 0 ? (
          <p className="text-sm text-muted">No time logged in this period.</p>
        ) : (
          <>
            {/* The key (colour + name) is stated once here, not on every row below. */}
            <ul className="mb-3 flex flex-wrap gap-x-6 gap-y-2">
              {members.map((m) => (
                <li key={m.id} className="flex items-center gap-2 text-sm">
                  <span className={`h-2.5 w-2.5 rounded-full ${TONE_BAR[m.tone]}`} aria-hidden />
                  <span className="font-bold">{m.name}</span>
                </li>
              ))}
            </ul>
            <div className="flex flex-col gap-3">
              {stats.categories.map((c) => {
                const pct = splitPercents(c.perUser, memberIds);
                const segments = members
                  .map((m) => ({
                    key: m.id,
                    name: m.name,
                    value: c.perUser[m.id] ?? 0,
                    pct: pct?.[m.id] ?? 0,
                    barClassName: TONE_BAR[m.tone],
                  }))
                  .filter((s) => s.value > 0);
                // The headline is whoever did more of this one — never both, and never when it's a
                // tie or there is only one person in the household (nothing to compare against).
                const [first, second] = [...segments].sort((a, b) => b.value - a.value);
                const dominant = members.length > 1 && first && first.value !== second?.value ? first : null;
                return (
                  <CategorySplitRow
                    key={c.category}
                    label={c.category}
                    total={c.minutes}
                    max={catMax}
                    segments={segments}
                    dominant={dominant}
                  />
                );
              })}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

/** Thin (20px) stacked bar: 2px surface gaps, rounded data-ends. Labels live in the legend, so none can overflow a segment. */
function StackedBar({
  segments,
  label,
}: {
  label: string;
  segments: { key: string; value: number; className: string; title: string }[];
}) {
  const visible = segments.filter((s) => s.value > 0);
  return (
    <div role="img" aria-label={label} className="flex h-5 w-full gap-0.5">
      {visible.map((s, i) => (
        <div
          key={s.key}
          title={s.title}
          style={{ flexGrow: s.value, flexBasis: 0 }}
          className={`min-w-1 ${s.className} ${i === 0 ? "rounded-l-[4px]" : ""} ${i === visible.length - 1 ? "rounded-r-[4px]" : ""}`}
        />
      ))}
    </div>
  );
}

/** Horizontal bar with its value at the tip. Bar never exceeds 68% of the row so the label always fits. */
function HBar({ label, value, max, text, className }: { label: string; value: number; max: number; text: string; className: string }) {
  const width = Math.max(value > 0 ? 1.5 : 0, (value / max) * 68);
  return (
    <div className="grid min-h-9 grid-cols-[5.5rem_1fr] items-center gap-3">
      <span className="truncate text-sm font-bold text-muted">{label}</span>
      <div className="flex items-center gap-2" title={`${label}: ${text}`}>
        <div className={`h-3.5 rounded-r-[4px] ${className}`} style={{ width: `${width}%` }} />
        <span className="whitespace-nowrap text-sm font-extrabold tabular-nums">{text}</span>
      </div>
    </div>
  );
}

/**
 * One category of "Time split by category": a header line (category + total, so the total is read
 * once per category rather than requiring a trip back to "Where the time goes"), then the split bar
 * with a single label — whoever did more of it — at its tip. Never both percentages and never the
 * absolute minutes inline: that's one number telling the one story this row is about, not a flood of
 * them. Identity on that label comes from a small dot, not from colouring the number itself, so the
 * text itself stays plain and legible. The full breakdown (both people, exact minutes) is still a
 * hover/long-press away via the row's title.
 */
function CategorySplitRow({
  label,
  total,
  max,
  segments,
  dominant,
}: {
  label: string;
  total: number;
  max: number;
  segments: { key: string; name: string; value: number; pct: number; barClassName: string }[];
  dominant: { name: string; pct: number; barClassName: string } | null;
}) {
  const width = Math.min(100, Math.max(total > 0 ? 1.5 : 0, (total / max) * 100));
  const title = `${label}: ${segments.map((s) => `${s.name} ${s.pct}% (${formatMinutes(s.value)})`).join(", ")}`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-sm font-extrabold">{label}</span>
        <span className="text-sm font-extrabold tabular-nums">{formatMinutes(total)}</span>
      </div>
      {/* The label column is a fixed width, present or not, so the bar's percentage always scales
          against the same track — a row with no label can't end up reading longer than one that has it. */}
      <div className="grid grid-cols-[1fr_3.5rem] items-center gap-2" title={title}>
        <div className="flex h-3.5 gap-0.5" style={{ width: `${width}%` }}>
          {segments.map((s, i) => (
            <div
              key={s.key}
              style={{ flexGrow: s.value, flexBasis: 0 }}
              className={`min-w-1 ${s.barClassName} ${i === segments.length - 1 ? "rounded-r-[4px]" : ""}`}
            />
          ))}
        </div>
        <span className="flex items-center justify-end gap-1.5 whitespace-nowrap text-sm font-bold text-muted">
          {dominant && (
            <>
              <span className={`h-2 w-2 rounded-full ${dominant.barClassName}`} aria-hidden />
              {dominant.pct}%
            </>
          )}
        </span>
      </div>
    </div>
  );
}

