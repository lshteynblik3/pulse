/**
 * Local-clock helpers for the agent.
 *
 * The agent owns "what day/hour is it" and sends that to the server, which stores
 * it verbatim. These functions therefore MUST read the machine's LOCAL clock.
 */

/**
 * The local calendar day as "YYYY-MM-DD", built from LOCAL clock components.
 *
 * IMPORTANT: never use `Date.toISOString()` to derive the date — that converts to
 * UTC and would mis-date activity recorded near midnight (the Phase 1 timezone
 * bug, one layer down). We read getFullYear/getMonth/getDate, which are local.
 */
export function localDateString(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** The local hour of day, 0–23. */
export function localHour(d: Date): number {
  return d.getHours();
}
