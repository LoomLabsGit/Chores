"use client";

import type { ReactNode } from "react";

/**
 * A single-choice row of chips (one is always selected), scrolling sideways when it does not fit.
 * The same look as the category chips, for filters that are not categories.
 */
export function FilterChips<T extends string | number | null>({
  label,
  options,
  value,
  onChange,
  className = "",
}: {
  /** What the row filters by, read out by screen readers. */
  label: string;
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  /** Extra classes, typically a negative margin + matching padding so the row runs edge to edge. */
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`no-scrollbar flex gap-2 overflow-x-auto ${className}`}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.value)}
            className={`flex min-h-11 shrink-0 items-center gap-2 rounded-full px-3.5 text-sm font-bold transition-colors ${
              selected ? "bg-brand text-brand-ink" : "bg-raised text-ink"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
