/** Turns Postgres / network errors into something a person can act on. */
export function friendlyError(err: { message?: string } | null | undefined): string {
  const m = err?.message ?? "Something went wrong";
  if (/row-level security|permission denied/i.test(m)) return "You don't have permission to do that.";
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(m)) {
    return "You look to be offline. Try again in a moment.";
  }
  if (/duplicate key|unique constraint/i.test(m)) return "That repeating chore is already planned for that day.";
  if (/jwt|not authenticated/i.test(m)) return "Your session expired. Please sign in again.";
  return m;
}
