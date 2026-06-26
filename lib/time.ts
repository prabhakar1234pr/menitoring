// Timezone helpers. Hour slots and the daily grid are in the user's IANA tz,
// while pg_cron / events are UTC. These bridge the two.

// "YYYY-MM-DD" for *now* in the given tz.
export function currentLocalDate(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// 0 = Sunday ... 6 = Saturday for a calendar date string (tz-independent).
export function weekdayOfDate(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Local (date, hour) bucket for a UTC instant, in the given tz.
export function localParts(
  instantISO: string,
  tz: string,
): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date(instantISO));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // some runtimes emit "24" for midnight
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour };
}

// The UTC instant for the start of a local (date, hour) in the given tz.
// Uses the standard offset-diff trick; good enough across DST for this app.
export function zonedHourToUtc(date: string, hour: number, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const asUTC = Date.UTC(y, m - 1, d, hour, 0, 0);
  const local = new Date(
    new Date(asUTC).toLocaleString("en-US", { timeZone: tz }),
  );
  const utc = new Date(
    new Date(asUTC).toLocaleString("en-US", { timeZone: "UTC" }),
  );
  const offset = utc.getTime() - local.getTime();
  return new Date(asUTC + offset);
}

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
