import { z } from 'zod';

/**
 * An absolute http(s) URL. `z.string().url()` alone accepts any scheme the URL parser knows,
 * including `javascript:` and `data:`, which become live links in the app and dashboard.
 */
export const httpUrl = (max?: number) =>
  (max === undefined ? z.string() : z.string().max(max)).url().refine(
    (value) => {
      try {
        const { protocol } = new URL(value);
        return protocol === 'http:' || protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'URL must start with http:// or https://' },
  );
