/**
 * Pure import-safe SQL matcher for disposable wallet reader authentication lookups.
 *
 * Requirements:
 * - Recognizes ONLY the exact normalized SQL shape: `SELECT * FROM users WHERE id = $1`
 * - Bound-value array must have exactly one element: [id]
 * - Bound ID must belong to caller-provided `ReadonlySet<string>` of disposable reader IDs.
 * - Accepts query as a SQL string or an object `{ text: string }`.
 * - Returns false for:
 *   - ballot voter IDs
 *   - other user SQL (e.g. projection subsets, additional WHERE clauses, joins)
 *   - malformed values (non-array, empty array, >1 elements, non-string id)
 *   - empty reader-ID set
 *   - unknown query forms
 * - Does not log SQL parameters or IDs.
 */

export interface QueryLikeObject {
  readonly text: string;
}

export type QueryInput = unknown;

/**
 * Normalizes query text by:
 * - Trimming leading/trailing whitespace
 * - Collapsing multiple consecutive whitespace characters into a single space
 * - Stripping a single trailing semicolon if present
 */
function normalizeQueryText(query: unknown): string | null {
  let rawText: string | null = null;
  if (typeof query === 'string') {
    rawText = query;
  } else if (
    query !== null &&
    typeof query === 'object' &&
    'text' in query &&
    typeof (query as { text: unknown }).text === 'string'
  ) {
    rawText = (query as { text: string }).text;
  } else {
    return null;
  }

  const trimmed = rawText.trim();
  const withoutTrailingSemicolon = trimmed.endsWith(';')
    ? trimmed.slice(0, -1).trim()
    : trimmed;

  return withoutTrailingSemicolon.replace(/\s+/g, ' ');
}

const TARGET_SQL_NORMALIZED = 'SELECT * FROM users WHERE id = $1';
const TARGET_BATCH_SQL_NORMALIZED = 'SELECT id, seed_id, is_test FROM users WHERE id = ANY($1::text[])';

/** Count only exact disposable reader IDs in a successful bounded alpha batch query. */
export function countDisposableWalletReaderBatchChecks(
  query: unknown,
  values: unknown,
  allowedReaderIds: ReadonlySet<string>
): number {
  if (!allowedReaderIds || allowedReaderIds.size === 0 || normalizeQueryText(query) !== TARGET_BATCH_SQL_NORMALIZED) {
    return 0;
  }
  if (!Array.isArray(values) || values.length !== 1 || !Array.isArray(values[0])) return 0;
  const ids: unknown[] = values[0];
  if (ids.length < 1 || ids.length > 100) return 0;
  const unique = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || id.trim().length === 0 || id.length > 128 ||
      !allowedReaderIds.has(id) || unique.has(id)) return 0;
    unique.add(id);
  }
  return unique.size;
}

/**
 * Checks whether a given SQL query and bound parameters represent an exact
 * lookup of a disposable wallet reader user by ID.
 */
export function isDisposableWalletReaderLookup(
  query: unknown,
  values: unknown,
  allowedReaderIds: ReadonlySet<string>
): boolean {
  if (!allowedReaderIds || allowedReaderIds.size === 0) {
    return false;
  }

  if (!Array.isArray(values) || values.length !== 1) {
    return false;
  }

  const boundId = values[0];
  if (typeof boundId !== 'string' || boundId.length === 0) {
    return false;
  }

  const normalized = normalizeQueryText(query);
  if (normalized !== TARGET_SQL_NORMALIZED) {
    return false;
  }

  return allowedReaderIds.has(boundId);
}
