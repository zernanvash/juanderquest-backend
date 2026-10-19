import type { Pool, PoolClient } from 'pg';
import { cachedTrailAi } from './cache.js';
import { createNimClient, type AiFallbackReason } from './client.js';
import { parsePreferencesSchema, tellStorySchema, trendDigestSchema, type ParsedTrailPreferences, type TrailStory, type TrendDigest } from './schemas.js';
import type { TrailAiPurpose } from './prompts.js';
import { templateTrailStory } from '../story.js';
import type { TrailNode, TrailSolution } from '../types.js';

export interface WeeklyTrendFacts {
  week_id: string;
  period_start: string;
  period_end: string;
  calendar_hint: string;
  top_categories: Array<{ category: string; count: number }>;
  top_good_for: Array<{ good_for: string; count: number }>;
  top_spots: Array<{ name: string; municipality: string; category: string; count: number }>;
}

export async function createTrendDigest(queryable: Pool | PoolClient, facts: WeeklyTrendFacts, client?: ReturnType<typeof createNimClient>) {
  return cachedTrailAi({
    queryable, purpose: 'trend_digest' as TrailAiPurpose, input: facts, schema: trendDigestSchema,
    fallback: () => fallbackTrendDigest(facts),
    client,
  });
}

export async function parseTrailPreferences(queryable: Pool | PoolClient, facts: {
  text: string; categories: string[]; good_for: string[]; municipalities: string[];
}, client?: ReturnType<typeof createNimClient>) {
  const boundedFacts = {
    text: facts.text.slice(0, 300), categories: facts.categories.slice(0, 100),
    good_for: facts.good_for.slice(0, 100), municipalities: facts.municipalities.slice(0, 48),
  };
  return cachedTrailAi({
    queryable, purpose: 'parse_preferences' as TrailAiPurpose, input: boundedFacts, schema: parsePreferencesSchema,
    fallback: () => ({ themes: [], good_for: [], municipalities: [], budget_min: 240, max_leg_min: 60, pace: 'balanced', with_kids: false } satisfies ParsedTrailPreferences),
    client,
  });
}

export interface TrailStoryFacts {
  theme: string;
  municipalities: string[];
  total_minutes: number;
  stops: Array<{ spot_id: string; name: string; municipality: string; category: string; description: string }>;
  /** Local validator only; deliberately not sent to NIM. */
  known_catalog_places?: string[];
}

export async function writeTrailStory(
  queryable: Pool | PoolClient,
  facts: TrailStoryFacts,
  template: { nodes: TrailNode[]; solution: TrailSolution },
  client?: ReturnType<typeof createNimClient>,
) {
  const input = {
    theme: facts.theme,
    municipalities: facts.municipalities,
    total_minutes: facts.total_minutes,
    stops: facts.stops.map(({ spot_id, name, municipality, category, description }) => ({
      spot_id, name, municipality, category, description: description.slice(0, 600),
    })),
  };
  const result = await cachedTrailAi({
    queryable, purpose: 'tell_story' as TrailAiPurpose, input, schema: tellStorySchema,
    validate: value => validStoryPlaces(value, facts.stops, facts.municipalities, facts.known_catalog_places ?? []),
    fallback: () => templateStory(facts.theme, template.nodes, template.solution, facts.municipalities),
    client,
  });
  return {
    value: { ...result.value, source: result.aiUsed ? 'ai' : 'template', ...(result.model ? { model: result.model } : {}) },
    aiUsed: result.aiUsed,
    model: result.model,
    fallbackReason: result.fallbackReason,
  };
}

export function fallbackTrendDigest(facts: Pick<WeeklyTrendFacts, 'top_categories' | 'top_good_for'>): TrendDigest {
  const themes = facts.top_categories.slice(0, 3).map((item, index) => ({
    label: item.category.slice(0, 40), categories: [item.category], good_for: [],
    weight: Math.max(0.25, 1 - index * 0.2),
  }));
  if (!themes.length) themes.push({ label: 'local-discovery', categories: [], good_for: facts.top_good_for.slice(0, 3).map(item => item.good_for), weight: 0.5 });
  return { themes, hooks: [], cautions: [] };
}

export function validStoryPlaces(
  story: TrailStory,
  selected: Array<{ spot_id: string; name: string; municipality: string }>,
  municipalities: string[],
  knownCatalogPlaces: string[],
): boolean {
  const expectedIds = selected.map(stop => stop.spot_id).sort();
  const actualIds = story.stops.map(stop => stop.spot_id).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds) || new Set(actualIds).size !== actualIds.length) return false;

  const allowedTerms = [...selected.map(stop => stop.name), ...municipalities].map(normalizePlace).filter(Boolean);
  const rawText = [story.title, story.tagline, story.intro, ...story.stops.map(stop => stop.narration)].join(' ');
  const text = rawText.toLocaleLowerCase();
  for (const known of knownCatalogPlaces) {
    const term = normalizePlace(known);
    if (!term || allowedTerms.includes(term)) continue;
    if (containsPlace(text, term)) return false;
  }

  // Catch place-like proper names introduced after common geographic cues,
  // including names not currently in the local catalog. Ordinary sentence
  // starts are not treated as locations unless they follow one of these cues.
  const cuePattern = /\b(?:in|at|near|through|around|visit|from|toward|towards)\s+([A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*){0,3})/gu;
  for (const match of rawText.matchAll(cuePattern)) {
    const candidate = normalizePlace(match[1]);
    if (candidate && !allowedTerms.some(term => term === candidate || term.includes(candidate) || candidate.includes(term))) return false;
  }
  return true;
}

function templateStory(theme: string, nodes: TrailNode[], solution: TrailSolution, municipalities: string[]) {
  const story = templateTrailStory(theme, nodes, solution, municipalities);
  const title = story.intro.split(':')[0].slice(0, 80);
  const stops = solution.stops.map((stop, index) => ({
    spot_id: stop.spotId,
    narration: story.stops[index]?.narration ?? '',
  }));
  return { title: title.length >= 3 ? title : 'Local discoveries', tagline: '', intro: story.intro, stops };
}

function normalizePlace(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function containsPlace(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
}
