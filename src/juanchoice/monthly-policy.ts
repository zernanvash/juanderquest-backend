import { createHash } from 'crypto';

export interface MonthlyTheme { name: string; categories: string[] }
export interface MonthlyCandidate {
  id: string; municipality: string; category: string;
  last_nominated_at: string | null; last_won_at: string | null;
  recommendation_suppressed: boolean; crowd_status: 'unknown' | 'quiet' | 'moderate' | 'estimated_busy';
}

export function localMonth(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit' }).formatToParts(now);
  const value = (name: string) => parts.find(part => part.type === name)?.value;
  return `${value('year')}-${value('month')}-01`;
}

export function nextMonth(period: string): string {
  const [year, month] = period.split('-').map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || !/^\d{4}-\d{2}-01$/.test(period)) {
    throw new Error('INVALID_MONTHLY_PERIOD');
  }
  return month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

function zonedMidnightUtc(period: string, timezone: string): Date {
  const target = Date.parse(`${period}T00:00:00Z`);
  if (!Number.isFinite(target)) throw new Error('INVALID_MONTHLY_PERIOD');
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = formatter.formatToParts(new Date(guess));
    const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
    const actualLocalAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    const difference = target - actualLocalAsUtc;
    guess += difference;
    if (difference === 0) return new Date(guess);
  }
  throw new Error('UNSUPPORTED_TIMEZONE_BOUNDARY');
}

export function monthlyWindow(period: string, timezone: string): { opensAt: Date; closesAt: Date } {
  if (!/^\d{4}-\d{2}-01$/.test(period)) throw new Error('INVALID_MONTHLY_PERIOD');
  const opensAt = zonedMidnightUtc(period, timezone);
  const closesAt = zonedMidnightUtc(period.slice(0, 8) + '08', timezone);
  if (closesAt <= opensAt) throw new Error('INVALID_MONTHLY_WINDOW');
  return { opensAt, closesAt };
}

export function themeForPeriod(period: string, themes: MonthlyTheme[], effectivePeriod: string): MonthlyTheme {
  if (!themes.length) throw new Error('EMPTY_MONTHLY_THEMES');
  const [y, m] = period.split('-').map(Number);
  const [startYear, startMonth] = effectivePeriod.split('-').map(Number);
  const distance = (y - startYear) * 12 + m - startMonth;
  if (distance < 0) throw new Error('PERIOD_BEFORE_EFFECTIVE_DATE');
  return themes[distance % themes.length];
}

export function selectMonthlyCandidates(input: {
  candidates: MonthlyCandidate[]; themes: MonthlyTheme[]; primaryTheme: MonthlyTheme;
  period: string; minimum: number; target: number; cooldownMs: number; closesAt: Date;
}): { theme: MonthlyTheme; selected: MonthlyCandidate[] } | null {
  const cycle = [input.primaryTheme, ...input.themes.filter(theme => theme.name !== input.primaryTheme.name)];
  for (const theme of cycle) {
    const eligible = input.candidates.filter(candidate => {
      const won = candidate.last_won_at ? Date.parse(candidate.last_won_at) : NaN;
      return theme.categories.includes(candidate.category) && !candidate.recommendation_suppressed
        && candidate.crowd_status !== 'estimated_busy'
        && !(Number.isFinite(won) && won >= input.closesAt.getTime() - input.cooldownMs);
    });
    const ranked = eligible.sort((a, b) => {
      const aTime = a.last_nominated_at ? Date.parse(a.last_nominated_at) : -Infinity;
      const bTime = b.last_nominated_at ? Date.parse(b.last_nominated_at) : -Infinity;
      if (aTime !== bTime) return aTime - bTime;
      const hash = (id: string) => createHash('sha256').update(`${input.period}:${id}`).digest('hex');
      return hash(a.id).localeCompare(hash(b.id));
    });
    const selected: MonthlyCandidate[] = [];
    const byMunicipality = new Map<string, number>();
    for (const pass of [0, 1]) {
      for (const candidate of ranked) {
        if (selected.some(item => item.id === candidate.id)) continue;
        const count = byMunicipality.get(candidate.municipality) ?? 0;
        if (count !== pass || count >= 2) continue;
        selected.push(candidate);
        byMunicipality.set(candidate.municipality, count + 1);
        if (selected.length >= input.target) break;
      }
      if (selected.length >= input.target) break;
    }
    if (selected.length >= input.minimum) return { theme, selected };
  }
  return null;
}
