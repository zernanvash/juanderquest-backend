import { z } from 'zod';

// Multipart form fields arrive as strings. Blank values mean absent; in
// particular, an empty coordinate must never silently become the equator.
const blankToUndefined = (value: unknown) =>
  value === '' || value === null || value === undefined ? undefined : Number(value);

export const optionalLat = z.preprocess(blankToUndefined, z.number().finite().min(-90).max(90).optional());
export const optionalLng = z.preprocess(blankToUndefined, z.number().finite().min(-180).max(180).optional());
export const optionalAccuracy = z.preprocess(blankToUndefined, z.number().finite().nonnegative().max(10_000).optional());
