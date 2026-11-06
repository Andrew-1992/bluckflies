/**
 * Time-zone helpers built on Intl, so DST rules (e.g. Egypt, Türkiye) come from
 * the runtime's tz database instead of hard-coded offsets.
 */

function offsetMinutesAt(utc: Date, timeZone: string): number {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(utc)
    .find((p) => p.type === 'timeZoneName')?.value;
  // "GMT+02:00" | "GMT-05:30" | "GMT"
  const m = part?.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/** Converts a wall-clock time in `timeZone` to a UTC instant. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const guess = new Date(`${date}T${time}:00Z`);
  const offset = offsetMinutesAt(new Date(guess.getTime() - offsetMinutesAt(guess, timeZone) * 60_000), timeZone);
  return new Date(guess.getTime() - offset * 60_000);
}

/** Formats a UTC instant as ISO 8601 with the local offset of `timeZone`. */
export function toZonedIso(utc: Date, timeZone: string): string {
  const offset = offsetMinutesAt(utc, timeZone);
  const local = new Date(utc.getTime() + offset * 60_000).toISOString().slice(0, 19);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${local}${sign}${hh}:${mm}`;
}

export const isIsoDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
