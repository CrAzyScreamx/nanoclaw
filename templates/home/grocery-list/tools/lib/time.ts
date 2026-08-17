/**
 * Every reading of the clock the CLI does, in the container's timezone.
 *
 * The local-calendar helpers are deliberately not exported: outside this file
 * the only questions worth asking are "which week are we in", "what timestamp
 * do I store", and "what date goes on the sheet", and each has exactly one
 * answer below. A command that formats a date itself is a command that can
 * disagree with the others about what day it is.
 *
 * THE TIMEZONE IS NOT CONFIGURATION HERE
 * --------------------------------------
 * It comes from the container's `TZ`, which NanoClaw already resolves per
 * group. Nothing in this template stores one: a second copy in `config.json`
 * would be a second thing to keep in step with the host, and the failure is
 * silent — a week that rolls over an hour early for months.
 */

const TZ = process.env.TZ || 'UTC';

/** Local calendar date (YYYY-MM-DD) in the container timezone. */
function localYmd(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Local day of week, 0 = Sunday. */
function localDow(d: Date = new Date()): number {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(w);
}

/** Local hour of day, 0-23, in the container timezone. */
function localHour(d: Date = new Date()): number {
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    hour12: false,
  }).format(d);
  return Number(h) % 24; // en-GB renders midnight as "24"
}

/** When the shopping week turns over. Day 0 = Sunday. */
export interface WeekStart {
  day: number;
  hour: number;
}

/**
 * The date of the most recent week boundary, as YYYY-MM-DD.
 *
 * The boundary day BEFORE the boundary hour still belongs to the week that
 * opened a week earlier — that is the whole point of the hour check. It is what
 * gives the pre-rotation review a window to run in, and it is why a scheduled
 * announcement must not fire early.
 *
 * Day arithmetic is done on a UTC-anchored calendar date so DST transitions
 * cannot shift the result. The hour is read in local time, which is safe for
 * any boundary hour outside the small hours: a zone that shifts at 02:00 has
 * one date a year on which 02:00 does not exist, so pick a working-hours
 * boundary rather than a nocturnal one.
 *
 * `weekStart` is passed in rather than read here, because reading it means
 * reading `config.json` and this file must stay free of that dependency —
 * `lib/weeks.ts` owns the config lookup and is the only caller.
 */
export function weekStartDate(weekStart: WeekStart, at: Date = new Date()): string {
  const dow = localDow(at);
  const [y, m, d] = localYmd(at).split('-').map(Number) as [number, number, number];
  let back = (dow - weekStart.day + 7) % 7;
  if (back === 0 && localHour(at) < weekStart.hour) back = 7;
  const start = new Date(Date.UTC(y, m - 1, d) - back * 86400000);
  return start.toISOString().slice(0, 10);
}

/** The stored timestamp shape: ISO-8601 UTC, everywhere, no exceptions. */
export function now(): string {
  return new Date().toISOString();
}

/**
 * The date printed on a sheet, dd.MM.yyyy.
 *
 * Built from the parts rather than left to a locale's default, which drops the
 * leading zeros ("27.7.2026"). It also names the output file, so it has to be
 * stable — and stable across LOCALES too, which is why the order does not
 * follow the pack: the same day must produce the same filename whichever
 * language the group speaks.
 */
export function sheetDate(d: Date = new Date()): string {
  const [y, m, day] = localYmd(d).split('-') as [string, string, string];
  return `${day}.${m}.${y}`;
}
