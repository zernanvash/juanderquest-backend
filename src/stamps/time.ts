export const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

export { weekId, weekStartDate } from '../social/time.js';

/** Manila calendar date ('YYYY-MM-DD') of an instant. */
export function manilaDateString(now: Date = new Date()): string {
  return new Date(now.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Manila month key ('YYYY-MM') of a calendar date. */
export function manilaMonthKey(date: string): string {
  return date.slice(0, 7);
}

export function addManilaDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to` (to - from). */
export function daysBetweenManila(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** Next Manila midnight strictly after `now`, as a UTC instant. */
export function nextManilaMidnightUtc(now: Date = new Date()): Date {
  const [year, month, day] = manilaDateString(now).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1) - MANILA_OFFSET_MS);
}

/** Monday-Sunday bounds ('YYYY-MM-DD') of the Manila week containing `date`. */
export function manilaWeekBounds(date: string): { start: string; end: string } {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const daysBack = weekday === 0 ? 6 : weekday - 1;
  const start = addManilaDays(date, -daysBack);
  return { start, end: addManilaDays(start, 6) };
}

/** ISO week id ('YYYY-Www', Monday-based) for a Manila calendar date. */
export function manilaWeekId(date: string): string {
  return weekIdFromDate(date);
}

function weekIdFromDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1, day));
  const thursday = new Date(target.getTime() + (3 - ((target.getUTCDay() + 6) % 7)) * 86_400_000);
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week1Monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86_400_000);
  const weekNum = 1 + Math.round((thursday.getTime() - (week1Monday.getTime() + 3 * 86_400_000)) / (7 * 86_400_000));
  return `${isoYear}-W${String(weekNum).padStart(2, '0')}`;
}
