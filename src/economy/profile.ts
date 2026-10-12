// Economic browser pilot authority: test harnesses or the explicitly marked,
// loopback-only development database. JDQ_ENV=dev alone is not sufficient.
export function isLocalEconomyProfile(): boolean {
  if (process.env.NODE_ENV === 'test') return true;
  if (process.env.NODE_ENV !== 'development' || process.env.JDQ_ENV !== 'dev') return false;
  try {
    const url = new URL(process.env.DATABASE_URL || '');
    return ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '55432' &&
      /^\/jdq_economy_lab_[a-f0-9]{12}_dev$/.test(url.pathname);
  } catch { return false; }
}
