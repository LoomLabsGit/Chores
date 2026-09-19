// All calendar maths uses LOCAL dates as "YYYY-MM-DD" strings, matching the
// Postgres `date` column. Never round-trip through toISOString() for a date:
// it converts to UTC and shifts the day for anyone east/west of Greenwich.

const pad = (n: number) => String(n).padStart(2, "0");

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function todayISO(now: Date = new Date()): string {
  return toISODate(now);
}

export function addDays(iso: string, n: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

/** Monday of the week containing `iso` (weeks run Monday-Sunday). */
export function startOfWeek(iso: string): string {
  const daysSinceMonday = (parseISODate(iso).getDay() + 6) % 7;
  return addDays(iso, -daysSinceMonday);
}

export function weekDays(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** Local calendar date of a timestamptz string. */
export function isoOfTimestamp(ts: string): string {
  return toISODate(new Date(ts));
}

// Static names (not Intl): ICU abbreviations differ between Node and browsers
// ("Sept" vs "Sep"), which would cause hydration mismatches.
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const monthShort = (d: Date) => MONTHS[d.getMonth()].slice(0, 3);

/** "September 2026", "Sep \u2013 Oct 2026" or "Dec 2026 \u2013 Jan 2027" for a week. */
export function formatWeekTitle(weekStart: string): string {
  const a = parseISODate(weekStart);
  const b = parseISODate(addDays(weekStart, 6));
  if (a.getMonth() === b.getMonth()) return `${MONTHS[a.getMonth()]} ${a.getFullYear()}`;
  if (a.getFullYear() === b.getFullYear()) {
    return `${monthShort(a)} \u2013 ${monthShort(b)} ${a.getFullYear()}`;
  }
  return `${monthShort(a)} ${a.getFullYear()} \u2013 ${monthShort(b)} ${b.getFullYear()}`;
}

export const weekdayShort = (iso: string) => WEEKDAYS[parseISODate(iso).getDay()].slice(0, 3);
export const dayOfMonth = (iso: string) => parseISODate(iso).getDate();
/** "Saturday 19 Sep" */
export function formatLongDay(iso: string): string {
  const d = parseISODate(iso);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${monthShort(d)}`;
}

/** "just now", "5m ago", "3h ago", "2d ago", then "12 Sep". */
export function timeAgo(ts: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(ts)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const d = new Date(ts);
  return `${d.getDate()} ${monthShort(d)}`;
}
