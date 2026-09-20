import { progressPct } from "@/lib/logic/challenges";
import type { Challenge } from "@/lib/types";

/** Circular SVG progress ring; fills by current_count / target_count and animates between values. */
export function ProgressRing({
  challenge,
  tone,
  size = 96,
  color,
}: {
  challenge: Pick<Challenge, "current_count" | "target_count" | "title" | "status">;
  tone: "a" | "b";
  size?: number;
  /** Overrides the tone's colour, e.g. the warning amber of a forfeit challenge (a CSS colour or variable). */
  color?: string;
}) {
  const stroke = Math.round(size * 0.11);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = progressPct(challenge);
  const done = challenge.status === "completed";

  return (
    <div
      role="progressbar"
      aria-label={`${challenge.title} progress`}
      aria-valuemin={0}
      aria-valuemax={challenge.target_count}
      aria-valuenow={challenge.current_count}
      className="relative shrink-0"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={done ? "var(--ok)" : (color ?? `var(--${tone})`)}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          style={{ transition: "stroke-dashoffset 500ms cubic-bezier(0.22, 1, 0.36, 1), stroke 300ms" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        {done ? (
          <span className="text-2xl" aria-hidden>
            🎉
          </span>
        ) : (
          <>
            <span key={challenge.current_count} className="anim-pop text-xl font-extrabold tabular-nums">
              {challenge.current_count}
            </span>
            <span className="mt-0.5 text-[11px] font-bold text-muted">of {challenge.target_count}</span>
          </>
        )}
      </div>
    </div>
  );
}
