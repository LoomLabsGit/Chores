"use client";

import { calculateBasePoints, calculatePoints, clampTax, MAX_MINUTES, MAX_TAX, MIN_MINUTES, snapMinutes, TAX_CHIPS } from "@/lib/logic/points";
import type { Profile } from "@/lib/types";
import { Icon } from "../icons";
import { Avatar, fieldClass, Segmented, type Tone } from "./controls";

/**
 * Duration in whole 5-minute steps (minimum 5). The number is directly editable and snaps to the
 * nearest multiple of 5 when you leave the field; the pads add or remove `steps` minutes.
 */
export function DurationField({
  value,
  onChange,
  steps,
  label = "Duration",
  inputId,
}: {
  value: number;
  onChange: (minutes: number) => void;
  steps: readonly number[];
  label?: string;
  inputId?: string;
}) {
  const commit = (raw: string) => onChange(snapMinutes(raw.trim() === "" ? value : Number(raw)));
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3">
        <input
          id={inputId}
          key={value /* re-sync the field whenever a pad changes the value */}
          type="number"
          inputMode="numeric"
          min={MIN_MINUTES}
          max={MAX_MINUTES}
          step={5}
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
          className={`${fieldClass} w-28 text-center text-2xl font-extrabold tabular-nums`}
        />
        <span className="text-base font-bold text-muted">minutes</span>
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }} role="group" aria-label="Subtract minutes">
        {steps.map((n) => (
          <button
            key={`m${n}`}
            type="button"
            onClick={() => onChange(snapMinutes(value - n))}
            disabled={value <= MIN_MINUTES}
            aria-label={`Subtract ${n} minutes`}
            className="min-h-12 rounded-2xl bg-raised text-base font-extrabold text-ink active:scale-95 disabled:opacity-40"
          >
            &minus;{n}
          </button>
        ))}
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }} role="group" aria-label="Add minutes">
        {steps.map((n) => (
          <button
            key={`p${n}`}
            type="button"
            onClick={() => onChange(snapMinutes(value + n))}
            disabled={value >= MAX_MINUTES}
            aria-label={`Add ${n} minutes`}
            className="min-h-12 rounded-2xl bg-brand-soft text-base font-extrabold text-brand active:scale-95 disabled:opacity-40"
          >
            +{n}
          </button>
        ))}
      </div>
    </div>
  );
}

/** "Chore Tax / Annoyance Bonus": one-tap chips plus a custom number. */
export function TaxField({ value, onChange }: { value: number; onChange: (tax: number) => void }) {
  const isChip = (TAX_CHIPS as readonly number[]).includes(value);
  return (
    <div className="flex flex-col gap-2">
      <div>
        <p id="tax-label" className="text-sm font-extrabold">
          Chore Tax / Annoyance Bonus
        </p>
        <p className="text-xs font-semibold text-muted">Extra flat points awarded for dirty or unpleasant jobs.</p>
      </div>
      <div role="radiogroup" aria-labelledby="tax-label" className="flex flex-wrap items-center gap-2">
        {TAX_CHIPS.map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={value === t}
            onClick={() => onChange(t)}
            className={`min-h-11 min-w-14 rounded-full px-4 text-sm font-extrabold transition-colors ${
              value === t ? "bg-brand text-brand-ink" : "bg-raised text-ink"
            }`}
          >
            +{t}
          </button>
        ))}
        <label className="flex min-h-11 items-center gap-2 rounded-full bg-raised pl-4 pr-2 text-sm font-bold text-muted">
          Custom
          <input
            key={value}
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_TAX}
            defaultValue={isChip ? "" : value}
            placeholder="0–50"
            aria-label="Custom chore tax"
            onFocus={(e) => e.target.select()}
            onBlur={(e) => e.target.value !== "" && onChange(clampTax(Number(e.target.value)))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            className="h-9 w-16 rounded-full bg-surface text-center font-extrabold tabular-nums text-ink placeholder:font-medium placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-brand/40"
          />
        </label>
      </div>
    </div>
  );
}

/** Live "Est. Reward: 15 mins (3 pts) + Tax (5 pts) = 8 pts" badge. */
export function RewardPreview({ minutes, tax }: { minutes: number; tax: number }) {
  return (
    <div
      className="flex items-center gap-2.5 rounded-2xl bg-gold-soft px-4 py-3 text-gold"
      role="status"
      aria-label={`Estimated reward ${calculatePoints(minutes, tax)} points`}
    >
      <Icon name="bolt" size={18} />
      <p className="text-sm font-extrabold leading-snug" aria-live="polite">
        Est. Reward: {minutes} mins ({calculateBasePoints(minutes)} pts) + Tax ({tax} pts) ={" "}
        <span className="whitespace-nowrap text-base">{calculatePoints(minutes, tax)} pts</span>
      </p>
    </div>
  );
}

/** [ Me ] [ Partner ] [ Unassigned ]. `null` means the open pool. */
export function AssigneeField({
  value,
  onChange,
  me,
  partner,
  tone,
  label = "Assigned to",
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  me: Profile;
  partner: Profile | undefined;
  tone: (id: string) => Tone;
  label?: string;
}) {
  const people = partner ? [me, partner] : [me];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-extrabold">{label}</span>
      <Segmented
        label={label}
        value={value ?? ""}
        onChange={(v) => onChange(v === "" ? null : v)}
        options={[
          ...people.map((m) => ({
            value: m.id,
            label: (
              <>
                <Avatar name={m.display_name} tone={tone(m.id)} size={22} />
                {m.id === me.id ? "Me" : m.display_name}
              </>
            ),
          })),
          { value: "", label: <>Unassigned</> },
        ]}
      />
      {value === null && (
        <p className="text-xs font-semibold text-muted">Anyone can claim it from the calendar, or just complete it.</p>
      )}
    </div>
  );
}
