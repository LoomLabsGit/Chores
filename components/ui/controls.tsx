"use client";

import type { ReactNode } from "react";
import { Icon } from "../icons";

export type Tone = "a" | "b";

const TONE_BG: Record<Tone, string> = { a: "bg-a text-white", b: "bg-b text-white" };
export const TONE_SOFT: Record<Tone, string> = { a: "bg-a-soft text-a", b: "bg-b-soft text-b" };
export const TONE_TEXT: Record<Tone, string> = { a: "text-a", b: "text-b" };
export const TONE_BAR: Record<Tone, string> = { a: "bg-a", b: "bg-b" };

export function Avatar({
  name,
  tone,
  size = 32,
  ring,
}: {
  name: string;
  tone: Tone;
  size?: number;
  ring?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-full font-extrabold ${TONE_BG[tone]} ${ring ? "ring-2 ring-surface" : ""}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-2xl bg-raised p-1">
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.value)}
            className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl px-3 text-sm font-bold transition-colors ${
              selected ? "bg-surface text-ink shadow-card" : "text-muted"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** +/- counter whose number is also directly editable (commits on blur / Enter). */
export function Stepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  unit,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  label: string;
  unit?: string;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  const commit = (raw: string) => {
    const n = Number(raw);
    onChange(raw.trim() === "" || Number.isNaN(n) ? value : clamp(n));
  };
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1">
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        disabled={value <= min}
        onClick={() => onChange(clamp(value - step))}
        className="flex h-11 w-11 items-center justify-center rounded-full bg-raised text-ink disabled:opacity-40"
      >
        <Icon name="minus" />
      </button>
      <span className="flex min-w-12 items-baseline justify-center">
        {/* key re-syncs the uncontrolled field whenever the value changes from outside */}
        <input
          key={value}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          defaultValue={value}
          aria-label={label}
          onFocus={(e) => e.target.select()}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(e.currentTarget.value);
            }
          }}
          className="w-12 rounded-lg bg-transparent text-center text-lg font-extrabold tabular-nums [appearance:textfield] focus:bg-raised focus:outline-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        {unit && <span className="text-xs font-bold text-muted">{unit}</span>}
      </span>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        disabled={value >= max}
        onClick={() => onChange(clamp(value + step))}
        className="flex h-11 w-11 items-center justify-center rounded-full bg-raised text-ink disabled:opacity-40"
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-3xl border border-dashed border-line px-6 py-10 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-soft text-brand">{icon}</div>
      <p className="text-base font-extrabold">{title}</p>
      {children && <div className="max-w-xs text-sm text-muted">{children}</div>}
    </div>
  );
}

export const primaryButton =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-brand px-5 font-extrabold text-brand-ink shadow-card transition-transform active:scale-[0.98] disabled:opacity-50";
export const secondaryButton =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-line bg-surface px-5 font-bold text-ink transition-transform active:scale-[0.98] disabled:opacity-50";
export const fieldClass =
  "min-h-12 w-full rounded-2xl border border-line bg-surface px-4 text-base font-semibold text-ink placeholder:font-medium placeholder:text-muted/70 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30";
