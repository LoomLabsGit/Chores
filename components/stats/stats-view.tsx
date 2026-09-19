"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { todayISO } from "@/lib/logic/dates";
import { formatMinutes } from "@/lib/logic/split";
import {
  computeStats,
  DEFAULT_TIMEFRAME,
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
  const max = Math.max(1, ...members.flatMap((m) => [stats.perUser[m.id].earned, stats.perUser[m.id].spent]));
  const catMax = Math.max(1, ...stats.categories.map((c) => c.minutes));
  const { onTime, delayed, onTimePct } = stats.consistency;

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

      <Card title="Points earned vs spent" subtitle={`Chores and challenges against redemptions · ${caption}`}>
        <div className="flex flex-col gap-5">
          {members.map((m) => {
            const u = stats.perUser[m.id];
            return (
              <div key={m.id}>
                <p className="mb-2 flex items-center gap-2 text-sm font-extrabold">
                  <span className={`h-2.5 w-2.5 rounded-full ${TONE_BAR[m.tone]}`} aria-hidden />
                  {m.name}
                  <span className="ml-auto text-xs font-bold text-muted">
                    Net {u.earned - u.spent >= 0 ? "+" : "−"}
                    {Math.abs(u.earned - u.spent)}
                  </span>
                </p>
                <HBar label="Earned" value={u.earned} max={max} text={`${u.earned}`} className={TONE_BAR[m.tone]} />
                <HBar label="Spent" value={u.spent} max={max} text={`${u.spent}`} className="bg-muted/50" />
              </div>
            );
          })}
        </div>
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

      <Card title="Completion consistency" subtitle={`Done on the scheduled day or earlier · ${caption}`}>
        {onTime + delayed === 0 ? (
          <p className="text-sm text-muted">Nothing completed in this period.</p>
        ) : (
          <>
            <p className="text-4xl font-extrabold leading-none">
              {onTimePct}%<span className="ml-2 text-base font-bold text-muted">on time</span>
            </p>
            <div className="mt-4">
              <StackedBar
                label="On time versus delayed"
                segments={[
                  { key: "on", value: onTime, className: "bg-ok", title: `On time: ${onTime}` },
                  { key: "late", value: delayed, className: "bg-warn", title: `Delayed: ${delayed}` },
                ]}
              />
            </div>
            <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <li className="flex items-center gap-1.5">
                <span className="text-ok">
                  <Icon name="check" size={16} strokeWidth={3} />
                </span>
                <span className="font-bold">On time</span>
                <span className="font-extrabold tabular-nums">{onTime}</span>
              </li>
              <li className="flex items-center gap-1.5">
                <span className="text-warn">
                  <Icon name="clock" size={16} />
                </span>
                <span className="font-bold">Delayed</span>
                <span className="font-extrabold tabular-nums">{delayed}</span>
              </li>
            </ul>
          </>
        )}
      </Card>

      <details className="group rounded-3xl border border-line bg-surface p-5 shadow-card lg:col-span-2">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-base font-extrabold [&::-webkit-details-marker]:hidden">
          View as table
          <Icon name="chevron-down" className="text-muted transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[26rem] text-left text-sm">
            <caption className="sr-only">Stats by partner for {caption}</caption>
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                <th className="py-2 pr-3 font-bold">Partner</th>
                <th className="py-2 pr-3 text-right font-bold">Time</th>
                <th className="py-2 pr-3 text-right font-bold">Share</th>
                <th className="py-2 pr-3 text-right font-bold">Earned</th>
                <th className="py-2 text-right font-bold">Spent</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="border-b border-line/60">
                  <th scope="row" className="py-2 pr-3 font-bold">
                    {m.name}
                  </th>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatMinutes(stats.perUser[m.id].minutes)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{stats.split ? `${stats.split[m.id]}%` : "–"}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{stats.perUser[m.id].earned}</td>
                  <td className="py-2 text-right tabular-nums">{stats.perUser[m.id].spent}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="mt-5 w-full min-w-[26rem] text-left text-sm">
            <caption className="sr-only">Time by chore type</caption>
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                <th className="py-2 pr-3 font-bold">Chore type</th>
                <th className="py-2 text-right font-bold">Time</th>
              </tr>
            </thead>
            <tbody>
              {stats.categories.map((c) => (
                <tr key={c.category} className="border-b border-line/60">
                  <th scope="row" className="py-2 pr-3 font-bold">
                    {c.category}
                  </th>
                  <td className="py-2 text-right tabular-nums">{formatMinutes(c.minutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-4 text-sm text-muted">
            Completion consistency: {onTime} on time, {delayed} delayed
            {onTimePct !== null && ` (${onTimePct}% on time)`}. Points earned include challenge rewards.
          </p>
        </div>
      </details>
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

