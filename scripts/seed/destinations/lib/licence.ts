// Plan 116 destinations: licence strings → the forms migration 111 accepts
// ('CC0', 'PD', 'PDM', 'CC BY 2.0', 'CC BY-SA 4.0', ...). Anything else (NC, ND, GFDL-only, FAL,
// "Attribution", unknown) returns null = not usable for a photo.

export function normaliseLicence(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const lower = s.toLowerCase();
  if (!lower) return null;
  if (/\b(nc|nd|noncommercial|non-commercial|noderivs|no derivatives)\b/.test(lower)) return null;
  if (/^(cc0|cc-0|cc zero|cc0 1\.0)\b/.test(lower) || lower.includes('public domain dedication')) return 'CC0';
  if (/^pdm\b|public domain mark/.test(lower)) return 'PDM';
  if (/^(public domain|pd\b|pd-|no restrictions)/.test(lower)) return 'PD';
  const m = lower.match(/^cc[- ]by(-sa)?[- ]?(\d(?:\.\d)?)?(?:[- ]([a-z]{2,3}))?$/);
  if (m) {
    const version = m[2] ? (m[2].includes('.') ? m[2] : `${m[2]}.0`) : null;
    if (!version) return null; // a bare "CC BY" has no version: ask the photo pass to resolve it
    return `CC BY${m[1] ? '-SA' : ''} ${version}`;
  }
  return null;
}

export function isAllowedLicence(raw: string | null | undefined): boolean {
  return normaliseLicence(raw) !== null;
}
