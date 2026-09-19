"use client";

/** Quick category filters: "All" plus one chip per category. Hidden when there is nothing to filter between. */
export function CategoryChips({
  categories,
  value,
  onChange,
  className = "",
}: {
  categories: string[];
  /** The selected category, or null for "All". */
  value: string | null;
  onChange: (category: string | null) => void;
  /** Extra classes, typically a negative margin + matching padding so the scrolling row runs edge to edge. */
  className?: string;
}) {
  if (categories.length < 2) return null;
  return (
    <div role="radiogroup" aria-label="Filter by category" className={`no-scrollbar flex gap-2 overflow-x-auto ${className}`}>
      {[null, ...categories].map((c) => {
        const selected = c === value;
        return (
          <button
            key={c ?? "all"}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(c)}
            className={`min-h-11 shrink-0 rounded-full px-4 text-sm font-bold transition-colors ${
              selected ? "bg-brand text-brand-ink" : "bg-raised text-ink"
            }`}
          >
            {c ?? "All"}
          </button>
        );
      })}
    </div>
  );
}
