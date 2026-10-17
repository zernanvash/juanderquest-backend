import {
  MANILA_OFFSET_MS,
  weekStartUtc,
  weekStartDate,
  weekId,
  nextWeekStartUtc,
  manilaHour,
  next0800ManilaUtc,
  manilaDayStartUtc,
} from '../src/social/time';

describe('Plaza time math (Manila UTC+8)', () => {
  it('identifies Sunday 23:59 Manila as belonging to previous Monday', () => {
    // 2026-10-18 23:59:00 Manila is Sunday
    // UTC is 2026-10-18 15:59:00
    const sundayNight = new Date('2026-10-18T15:59:00.000Z');
    const start = weekStartUtc(sundayNight);
    expect(weekStartDate(sundayNight)).toBe('2026-10-12');
    // Monday 00:00 Manila is 2026-10-11 16:00:00 UTC
    expect(start.toISOString()).toBe('2026-10-11T16:00:00.000Z');
    expect(weekId(sundayNight)).toBe('2026-W42');
  });

  it('identifies Monday 00:00 Manila as starting that same day', () => {
    // 2026-10-19 00:00:00 Manila is 2026-10-18 16:00:00 UTC
    const mondayMidnight = new Date('2026-10-18T16:00:00.000Z');
    const start = weekStartUtc(mondayMidnight);
    expect(weekStartDate(mondayMidnight)).toBe('2026-10-19');
    expect(start.toISOString()).toBe('2026-10-18T16:00:00.000Z');
    expect(weekId(mondayMidnight)).toBe('2026-W43');
  });

  it('correctly maps Manila Monday 03:00 to Sunday 19:00 UTC', () => {
    // Sunday 19:00 UTC is Monday 03:00 Manila
    const date = new Date('2026-10-18T19:00:00.000Z');
    expect(manilaHour(date)).toBe(3);
    expect(weekStartDate(date)).toBe('2026-10-19');
    expect(weekId(date)).toBe('2026-W43');
  });

  it('handles ISO week at a year boundary correctly', () => {
    // 2026-12-28 Manila (Monday) -> 2026-W53
    // In UTC: 2026-12-28 00:00 Manila is 2026-12-27 16:00 UTC
    const dateW53 = new Date('2026-12-27T16:00:00.000Z');
    expect(weekStartDate(dateW53)).toBe('2026-12-28');
    expect(weekId(dateW53)).toBe('2026-W53');

    // 2027-01-04 Manila (Monday) -> 2027-W01
    // In UTC: 2027-01-04 00:00 Manila is 2027-01-03 16:00 UTC
    const dateW01 = new Date('2027-01-03T16:00:00.000Z');
    expect(weekStartDate(dateW01)).toBe('2027-01-04');
    expect(weekId(dateW01)).toBe('2027-W01');
  });

  it('calculates nextWeekStartUtc as exactly 7 days after weekStartUtc', () => {
    const now = new Date('2026-10-17T03:00:00.000Z'); // Saturday 11:00 Manila
    const thisWeek = weekStartUtc(now);
    const nextWeek = nextWeekStartUtc(now);
    expect(nextWeek.getTime() - thisWeek.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('calculates next 08:00 Manila correctly', () => {
    // 05:00 Manila (21:00 prev day UTC) -> next 08:00 Manila is today at 00:00 UTC
    const earlyMorning = new Date('2026-10-17T21:00:00.000Z'); // 2026-10-18 05:00 Manila
    const next08Early = next0800ManilaUtc(earlyMorning);
    expect(next08Early.toISOString()).toBe('2026-10-18T00:00:00.000Z'); // 08:00 Manila

    // 09:00 Manila (01:00 UTC) -> next 08:00 Manila is tomorrow at 00:00 UTC
    const lateMorning = new Date('2026-10-18T01:00:00.000Z'); // 2026-10-18 09:00 Manila
    const next08Late = next0800ManilaUtc(lateMorning);
    expect(next08Late.toISOString()).toBe('2026-10-19T00:00:00.000Z'); // 08:00 Manila next day
  });

  it('calculates manilaDayStartUtc correctly', () => {
    const midday = new Date('2026-10-18T04:00:00.000Z'); // 12:00 Manila
    const startOfDay = manilaDayStartUtc(midday);
    expect(startOfDay.toISOString()).toBe('2026-10-17T16:00:00.000Z'); // 00:00 Manila on 2026-10-18
  });
});
