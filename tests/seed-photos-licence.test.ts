import {
  cleanAuthor,
  isDbAcceptedLicence,
  licenceUrl,
  normaliseLicence,
  stripHtml,
} from '../scripts/seed/photos/licence';

const ok = (raw: string) => {
  const r = normaliseLicence(raw);
  return r.ok ? r.license : `REJECT:${r.reason}`;
};

describe('normaliseLicence', () => {
  it.each([
    ['CC BY-SA 4.0', 'CC BY-SA 4.0'],
    ['cc-by-sa-3.0', 'CC BY-SA 3.0'],
    ['CC BY 2.0', 'CC BY 2.0'],
    ['CC-BY-4.0', 'CC BY 4.0'],
    ['CC BY 2.5 au', 'CC BY 2.5'],
    ['CC BY-SA 2.0 de', 'CC BY-SA 2.0'],
    ['CC BY 3.0 IGO', 'CC BY 3.0'],
    ['CC BY-SA 1.0', 'CC BY-SA 1.0'],
    ['CC0', 'CC0'],
    ['CC0 1.0', 'CC0'],
    ['cc0-1.0', 'CC0'],
    ['Public domain', 'PD'],
    ['pd-self', 'PD'],
    ['Public Domain Mark', 'PDM'],
    ['pdm', 'PDM'],
  ])('%s → %s', (raw, want) => {
    expect(ok(raw)).toBe(want);
    expect(isDbAcceptedLicence(want)).toBe(true);
  });

  it.each([
    ['CC BY-NC-SA 2.0', 'licence_nc'],
    ['CC BY-NC 4.0', 'licence_nc'],
    ['CC BY-ND 4.0', 'licence_nd'],
    ['CC BY-NC-ND 3.0', 'licence_nc'],
    ['GFDL', 'licence_gfdl_only'],
    ['GNU Free Documentation License', 'licence_gfdl_only'],
    ['Attribution', 'licence_unsupported'],
    ['FAL', 'licence_unsupported'],
    ['No restrictions', 'licence_unsupported'],
    ['Fair use', 'licence_nonfree'],
    ['CC BY-SA', 'licence_cc_unversioned'],
    ['', 'licence_missing'],
  ])('rejects %s (%s)', (raw, reason) => {
    expect(ok(raw)).toBe(`REJECT:${reason}`);
  });

  it('only emits strings the DB CHECK accepts', () => {
    expect(isDbAcceptedLicence('CC BY-SA 4.0')).toBe(true);
    expect(isDbAcceptedLicence('CC BY-SA 4.0 de')).toBe(false);
    expect(isDbAcceptedLicence('CC BY-NC 4.0')).toBe(false);
  });

  it('builds canonical deed URLs', () => {
    expect(licenceUrl('CC BY-SA 4.0')).toBe('https://creativecommons.org/licenses/by-sa/4.0/');
    expect(licenceUrl('CC0')).toBe('https://creativecommons.org/publicdomain/zero/1.0/');
  });
});

describe('author cleaning', () => {
  it('strips Commons HTML and entities', () => {
    expect(stripHtml('<a href="//commons.wikimedia.org/wiki/User:Foo" title="User:Foo">Foo&nbsp;Bar</a>')).toBe(
      'Foo Bar',
    );
    expect(stripHtml('Jos&#233; &amp; Co')).toBe('José & Co');
  });
  it('rejects unknown authors and drops User: prefixes', () => {
    expect(cleanAuthor('<span>Unknown author</span>')).toBeNull();
    expect(cleanAuthor('anonymous')).toBeNull();
    expect(cleanAuthor('')).toBeNull();
    expect(cleanAuthor('User:Beltugade')).toBe('Beltugade');
  });
});
