import { dayOfMonth, weekdayLong } from "./dates";

export type Frequency = "daily" | "weekly" | "biweekly" | "monthly";
export type RepeatChoice = Frequency | "none";

export const REPEAT_OPTIONS: { value: RepeatChoice; label: string }[] = [
  { value: "none", label: "Doesn't repeat" },
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "monthly", label: "Every month" },
];

/** Reads the RRULE-style text stored on chore_instances.recurrence_rule. */
export function frequencyFromRule(rule: string | null | undefined): RepeatChoice {
  switch (rule) {
    case "FREQ=DAILY":
      return "daily";
    case "FREQ=WEEKLY":
      return "weekly";
    case "FREQ=WEEKLY;INTERVAL=2":
      return "biweekly";
    case "FREQ=MONTHLY":
      return "monthly";
    default:
      return "none";
  }
}

export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** One line of plain English for the edit sheet, e.g. "Repeats every Saturday". */
export function describeRepeat(choice: RepeatChoice, dateISO: string): string {
  switch (choice) {
    case "none":
      return "Happens once";
    case "daily":
      return "Repeats every day";
    case "weekly":
      return `Repeats every ${weekdayLong(dateISO)}`;
    case "biweekly":
      return `Repeats every other ${weekdayLong(dateISO)}`;
    case "monthly": {
      const day = dayOfMonth(dateISO);
      return day > 28
        ? `Repeats on the ${ordinal(day)} of each month (the last day in shorter months)`
        : `Repeats on the ${ordinal(day)} of each month`;
    }
  }
}
