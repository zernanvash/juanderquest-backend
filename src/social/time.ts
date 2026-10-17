export const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8, no DST

/** Internal helper to get Manila date components for a Monday */
function getManilaMondayDate(now: Date): Date {
  const manilaTimeMs = now.getTime() + MANILA_OFFSET_MS;
  const manilaDate = new Date(manilaTimeMs);
  const day = manilaDate.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const daysBack = day === 0 ? 6 : day - 1;

  const year = manilaDate.getUTCFullYear();
  const month = manilaDate.getUTCMonth();
  const date = manilaDate.getUTCDate() - daysBack;

  return new Date(Date.UTC(year, month, date, 0, 0, 0, 0));
}

/** Monday 00:00 Manila of the week containing `now`, returned as a UTC Date. */
export function weekStartUtc(now: Date): Date {
  const manilaMonday = getManilaMondayDate(now);
  return new Date(manilaMonday.getTime() - MANILA_OFFSET_MS);
}

/** 'YYYY-MM-DD' Manila date of that Monday */
export function weekStartDate(now: Date): string {
  const manilaMonday = getManilaMondayDate(now);
  const y = manilaMonday.getUTCFullYear();
  const m = String(manilaMonday.getUTCMonth() + 1).padStart(2, '0');
  const d = String(manilaMonday.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** ISO week of the Manila Monday: 'YYYY-Www' */
export function weekId(now: Date): string {
  const manilaMonday = getManilaMondayDate(now);
  // In ISO week-numbering, Thursday of the current week determines the year and week
  const thursday = new Date(manilaMonday.getTime() + 3 * 24 * 60 * 60 * 1000);
  const isoYear = thursday.getUTCFullYear();

  // January 4 is always in week 1 of isoYear
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = jan4.getUTCDay();
  const jan4DaysBack = jan4Day === 0 ? 6 : jan4Day - 1;
  const week1Monday = new Date(Date.UTC(isoYear, 0, 4 - jan4DaysBack));
  const week1Thursday = new Date(week1Monday.getTime() + 3 * 24 * 60 * 60 * 1000);

  const diffMs = thursday.getTime() - week1Thursday.getTime();
  const weekNum = 1 + Math.round(diffMs / (7 * 24 * 60 * 60 * 1000));

  return `${isoYear}-W${String(weekNum).padStart(2, '0')}`;
}

/** weekStartUtc + 7 days */
export function nextWeekStartUtc(now: Date): Date {
  return new Date(weekStartUtc(now).getTime() + 7 * 24 * 60 * 60 * 1000);
}

/** Manila hour (0–23) */
export function manilaHour(now: Date): number {
  return new Date(now.getTime() + MANILA_OFFSET_MS).getUTCHours();
}

/** Next 08:00 Manila strictly after `now` */
export function next0800ManilaUtc(now: Date): Date {
  const manilaTimeMs = now.getTime() + MANILA_OFFSET_MS;
  const manilaDate = new Date(manilaTimeMs);

  const today08 = new Date(
    Date.UTC(
      manilaDate.getUTCFullYear(),
      manilaDate.getUTCMonth(),
      manilaDate.getUTCDate(),
      8,
      0,
      0,
      0
    )
  );
  const today08Utc = new Date(today08.getTime() - MANILA_OFFSET_MS);

  if (today08Utc.getTime() > now.getTime()) {
    return today08Utc;
  }

  const tomorrow08 = new Date(today08.getTime() + 24 * 60 * 60 * 1000 - MANILA_OFFSET_MS);
  return tomorrow08;
}

/** Midnight Manila of `now`, returned as a UTC Date */
export function manilaDayStartUtc(now: Date): Date {
  const manilaTimeMs = now.getTime() + MANILA_OFFSET_MS;
  const manilaDate = new Date(manilaTimeMs);
  const today00 = new Date(
    Date.UTC(
      manilaDate.getUTCFullYear(),
      manilaDate.getUTCMonth(),
      manilaDate.getUTCDate(),
      0,
      0,
      0,
      0
    )
  );
  return new Date(today00.getTime() - MANILA_OFFSET_MS);
}
