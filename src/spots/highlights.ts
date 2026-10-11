import { createHash } from 'crypto';
import type { SpotStore } from './store.js';

// Editorial exclusions for the pilot, not a global popularity database.
const establishedLandmarks = new Set(['hundred-islands-national-park', 'patar-white-beach', 'minor-basilica-of-manaoag']);
/** Low in-app exposure is a discovery proxy, not measured real-world popularity. */
export function hiddenGemHighlights(store: SpotStore, userId?: string, now = Date.now()) {
  const prefs = userId ? store.getPreferences(userId) : undefined;
  const interests = new Set([...(prefs?.categories || []), ...(prefs?.tags || []), ...(prefs?.occasions || [])]);
  const affinity = new Set(store.spots.filter(s => !s.is_test && s.status === 'published' &&
    (store.isSaved(userId, s.id) || store.isLiked(userId, s.id))).map(s => s.category));
  const day = new Date(now).toISOString().slice(0, 10);
  return store.spots.filter(s => s.status === 'published' && !s.is_test && !s.recommendation_suppressed &&
    !establishedLandmarks.has(s.slug) && s.id !== 'spot-hundred-islands' && (['editorial', 'lgu_verified'].includes(s.trust_level) ||
      Boolean(s.reviewed_by && s.reviewed_at)))
    .map(s => {
      const crowd = store.crowd(s, now);
      const explicit = interests.has(s.category) || s.tags.some(tag => interests.has(tag));
      const behavioral = affinity.has(s.category);
      return { id: s.id, name: s.name, municipality: s.municipality, image_url: s.image_url,
        crowd_status: crowd.crowd_status,
        reason: explicit ? 'Matches your travel interests' : behavioral ? 'Inspired by places you saved or liked' : 'Discover somewhere different',
        score: (explicit ? 4 : 0) + (behavioral ? 2 : 0) + 1 / (1 + Math.max(0, store.trend(s.id))),
        rotation: createHash('sha256').update(`${day}:${userId || 'guest'}:${s.id}`).digest('hex') };
    }).filter(s => s.crowd_status !== 'estimated_busy')
    .sort((a, b) => b.score - a.score || a.rotation.localeCompare(b.rotation) || a.id.localeCompare(b.id))
    .slice(0, 3).map(({ score, rotation, ...spot }) => spot);
}
