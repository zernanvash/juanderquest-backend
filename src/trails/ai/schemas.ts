import { z } from 'zod';

const shortString = (max: number) => z.string().trim().min(1).max(max);
const stringList = (maxItems: number, maxLength: number) => z.array(shortString(maxLength)).max(maxItems);

export const trendDigestSchema = z.object({
  themes: z.array(z.object({
    label: shortString(40),
    categories: stringList(12, 50),
    good_for: stringList(12, 60),
    weight: z.number().min(0).max(1),
  }).strict()).min(1).max(6),
  hooks: stringList(4, 80),
  cautions: stringList(4, 80),
}).strict();

export const parsePreferencesSchema = z.object({
  themes: stringList(12, 80),
  good_for: stringList(12, 80),
  municipalities: stringList(48, 100),
  budget_min: z.number().int().min(60).max(600),
  max_leg_min: z.number().int().min(15).max(120),
  pace: z.enum(['relaxed', 'balanced', 'packed']),
  with_kids: z.boolean(),
}).strict();

export const tellStorySchema = z.object({
  title: shortString(60).refine(value => value.length >= 3),
  tagline: z.string().trim().max(120),
  intro: z.string().trim().min(1).max(400),
  stops: z.array(z.object({
    spot_id: shortString(200),
    narration: z.string().trim().max(280),
  }).strict()).min(1).max(12),
}).strict();

export type TrendDigest = z.infer<typeof trendDigestSchema>;
export type ParsedTrailPreferences = z.infer<typeof parsePreferencesSchema>;
export type TrailStory = z.infer<typeof tellStorySchema>;
