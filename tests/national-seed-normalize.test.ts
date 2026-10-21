import { isAutoPublishCandidate, normalizeOsmFeature, representativePoint } from '../src/seed/normalize';

describe('national OSM destination normalization', () => {
  it('uses a point inside a polygon and outside its interior holes', () => {
    const point = representativePoint({ type: 'Polygon', coordinates: [
      [[0,0],[10,0],[10,10],[0,10],[0,0]],
      [[1,1],[9,1],[9,9],[1,9],[1,1]],
    ] });
    expect(point).not.toBeNull();
    expect(point![0]).toBeGreaterThan(0);
    expect(point![0]).toBeLessThan(1);
    expect(point![1]).toBeGreaterThan(0);
    expect(point![1]).toBeLessThan(1);
  });

  it('normalizes a named OSM attraction with stable provenance and no invented description', () => {
    const candidate = normalizeOsmFeature({
      type: 'Feature', id: 'node/12345', properties: { name: 'Test Falls', tourism: 'attraction', wikidata: 'Q123' },
      geometry: { type: 'Point', coordinates: [120.1, 16.1] },
    }, 'w0-pangasinan');
    expect(candidate).toMatchObject({ name: 'Test Falls', description: '', category: 'activities_wellness',
      subcategory: 'attraction', external_refs: { osm: 'node/12345', wikidata: 'Q123' }, import_wave: 'w0-pangasinan' });
    expect(candidate?.field_sources).toHaveProperty('osm_tags');
    expect(candidate?.import_confidence).toBe(0.5);
    expect(isAutoPublishCandidate(candidate!)).toBe(false);
  });

  it('rejects generic worship buildings without heritage or wikidata evidence', () => {
    expect(normalizeOsmFeature({ type: 'Feature', id: 'node/8', properties: { name: 'Church', amenity: 'place_of_worship' },
      geometry: { type: 'Point', coordinates: [120,16] } }, 'w0')).toBeNull();
  });

  it('accepts high-confidence candidates without requiring a Commons photo', () => {
    const candidate = normalizeOsmFeature({ type: 'Feature', id: 'node/1', properties: { name: 'Specific Shrine', tourism: 'attraction', wikidata: 'Q1', opening_hours: 'Mo-Su 09:00-17:00' },
      geometry: { type: 'Point', coordinates: [120,16] } }, 'w0')!;
    candidate.import_confidence = 0.8;
    expect(isAutoPublishCandidate(candidate)).toBe(true);
    expect(isAutoPublishCandidate({ ...candidate, review_only: true })).toBe(false);
    expect(isAutoPublishCandidate({ ...candidate, import_confidence: 0.59 })).toBe(false);
    expect(isAutoPublishCandidate({ ...candidate, field_sources: { ...candidate.field_sources, scraped_pending: { contact_number: { reviewed: false } } } })).toBe(false);
  });
});
