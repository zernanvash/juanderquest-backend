/**
 * Validation and parsing for CORS origins in backend configuration.
 */

export interface ParsedCorsOrigins {
  raw: string;
  isWildcard: boolean;
  origins: string[];
}

export function validateAndParseCorsOrigin(
  rawOrigin: string | undefined,
  nodeEnv: string,
  allowPresentationLoopback = false
): ParsedCorsOrigins {
  const isProduction = nodeEnv === 'production';
  const trimmed = rawOrigin?.trim() ?? '';

  if (isProduction) {
    if (!trimmed) {
      throw new Error('Production requires an explicit CORS_ORIGIN setting.');
    }
    if (trimmed === '*') {
      throw new Error('Production cannot use wildcard (*) CORS_ORIGIN.');
    }
  } else {
    if (!trimmed || trimmed === '*') {
      return {
        raw: trimmed || '*',
        isWildcard: true,
        origins: ['*'],
      };
    }
  }

  // Parse comma-separated list
  const rawList = trimmed.split(',').map((o) => o.trim());

  if (rawList.some((origin) => !origin)) {
    throw new Error('CORS_ORIGIN contains an empty origin.');
  }

  if (rawList.length === 0) {
    if (isProduction) {
      throw new Error('Production requires an explicit, non-empty CORS_ORIGIN setting.');
    }
    return {
      raw: trimmed,
      isWildcard: true,
      origins: ['*'],
    };
  }

  const seen = new Set<string>();
  const validatedOrigins: string[] = [];

  for (const item of rawList) {
    if (item === '*') {
      if (isProduction) {
        throw new Error('Production cannot contain wildcard (*) in CORS_ORIGIN.');
      }
      return {
        raw: trimmed,
        isWildcard: true,
        origins: ['*'],
      };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(item);
    } catch {
      throw new Error('CORS_ORIGIN contains an invalid URL.');
    }

    if (isProduction) {
      const isAllowedPresentationOrigin = allowPresentationLoopback &&
        (item === 'http://127.0.0.1:3200' || item === 'https://presentation.juanderquest.app');

      if (parsedUrl.protocol !== 'https:' && !isAllowedPresentationOrigin) {
        throw new Error(
          'Production CORS origins must use HTTPS.'
        );
      }

      if (allowPresentationLoopback && !isAllowedPresentationOrigin) {
        throw new Error(
          `Presentation mode only permits http://127.0.0.1:3200 or https://presentation.juanderquest.app, got '${item}'.`
        );
      }

      if (parsedUrl.username || parsedUrl.password) {
        throw new Error(
          'CORS origin cannot contain user credentials.'
        );
      }
      if (parsedUrl.pathname !== '/' && parsedUrl.pathname !== '') {
        throw new Error(
          'CORS origin cannot contain a path.'
        );
      }
      if (parsedUrl.search) {
        throw new Error(
          'CORS origin cannot contain query parameters.'
        );
      }
      if (parsedUrl.hash) {
        throw new Error(
          'CORS origin cannot contain a fragment.'
        );
      }
    }

    const canonicalOrigin = parsedUrl.origin;

    if (isProduction && item !== canonicalOrigin) {
      throw new Error('Production CORS origins must use canonical origin syntax.');
    }

    if (isProduction && seen.has(canonicalOrigin)) {
      throw new Error(
        `Duplicate CORS origin detected in production configuration: '${canonicalOrigin}'`
      );
    }

    seen.add(canonicalOrigin);
    validatedOrigins.push(canonicalOrigin);
  }

  return {
    raw: trimmed,
    isWildcard: false,
    origins: validatedOrigins,
  };
}
