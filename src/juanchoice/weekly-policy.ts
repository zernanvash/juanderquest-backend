// Plan 65: weekly JuanChoice rounds. Every Manila week (Monday 00:00 – next Monday 00:00)
// has an open election booth; its winners reign the following week.

const DAY_MS = 86_400_000;

function localDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = (name: string) => parts.find(part => part.type === name)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The Monday (YYYY-MM-DD, local calendar) of the week containing `now`. */
export function localWeek(now: Date, timezone: string): string {
  const today = localDate(now, timezone);
  const isoDow = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
  return addDays(today, 1 - isoDow);
}

export function nextWeek(period: string): string {
  if (!isMonday(period)) throw new Error('INVALID_WEEKLY_PERIOD');
  return addDays(period, 7);
}

export function isMonday(period: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(period) && Number.isFinite(Date.parse(`${period}T00:00:00Z`))
    && new Date(`${period}T00:00:00Z`).getUTCDay() === 1;
}

/** Monday 00:00 to the next Monday 00:00 in the schedule's timezone. */
export function weeklyWindow(period: string, timezone: string): { opensAt: Date; closesAt: Date } {
  if (!isMonday(period)) throw new Error('INVALID_WEEKLY_PERIOD');
  const opensAt = zonedMidnight(period, timezone);
  const closesAt = zonedMidnight(addDays(period, 7), timezone);
  return { opensAt, closesAt };
}

function zonedMidnight(date: string, timezone: string): Date {
  // Same DST-safe local-midnight resolution as monthly-policy, for any calendar date.
  const target = Date.parse(`${date}T00:00:00Z`);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = formatter.formatToParts(new Date(guess));
    const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
    const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    const difference = target - local;
    guess += difference;
    if (difference === 0) return new Date(guess);
  }
  throw new Error('UNSUPPORTED_TIMEZONE_BOUNDARY');
}

/** ISO-8601 week key, e.g. 2026-W44, for the Monday `period`. */
export function isoWeekKey(period: string): string {
  if (!isMonday(period)) throw new Error('INVALID_WEEKLY_PERIOD');
  const thursday = new Date(Date.parse(`${period}T00:00:00Z`) + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstMonday = new Date(firstThursday.getTime() - ((firstThursday.getUTCDay() || 7) - 1) * DAY_MS);
  const week = Math.round((Date.parse(`${period}T00:00:00Z`) - firstMonday.getTime()) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Round number counted from the schedule's first Monday (1-based). */
export function weeklyRoundNumber(period: string, effectivePeriod: string): number {
  const weeks = Math.round((Date.parse(`${period}T00:00:00Z`) - Date.parse(`${effectivePeriod}T00:00:00Z`)) / (7 * DAY_MS));
  if (weeks < 0) throw new Error('PERIOD_BEFORE_EFFECTIVE_DATE');
  return weeks + 1;
}

export interface FestivalRow { name: string; starts_on: string | Date; ends_on: string | Date; boost_multiplier: number | string }

/** Every Nth round, or any week overlapping a calendar festival, is a special festival round. */
export function roundTier(input: { roundNumber: number; intervalWeeks: number; period: string; festivals: FestivalRow[] }):
  { tier: 'standard' | 'special_festival'; festivalName: string | null; multiplier: number } {
  const weekEnd = addDays(input.period, 6);
  const day = (value: string | Date) => (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
  const festival = input.festivals.find(f => day(f.starts_on) <= weekEnd && day(f.ends_on) >= input.period);
  if (festival) return { tier: 'special_festival', festivalName: festival.name, multiplier: Number(festival.boost_multiplier) || 1.5 };
  if (input.roundNumber % input.intervalWeeks === 0) return { tier: 'special_festival', festivalName: null, multiplier: 1.5 };
  return { tier: 'standard', festivalName: null, multiplier: 1 };
}
