import { getPool } from '../db/pool.js';
import { PANGASINAN_MUNICIPALITIES } from '../routes/affiliates.js';

// Home town (owner 2026-11-08): the town the traveler says they are from,
// chosen by them, because travelers do most quests away from home. It decides
// the My Town board; null means not set or not from Pangasinan.

const memoryHomeTowns = new Map<string, string | null>();

/** The canonical spelling of a Pangasinan town, or undefined if it is not one. */
export function canonicalTown(input: string): string | undefined {
  const key = input.trim().toLowerCase();
  return PANGASINAN_MUNICIPALITIES.find((t) => t.toLowerCase() === key);
}

export async function getHomeTown(userId: string): Promise<string | null> {
  const pool = getPool();
  if (!pool) return memoryHomeTowns.get(userId) ?? null;
  const { rows } = await pool.query<{ home_municipality: string | null }>(
    'SELECT home_municipality FROM users WHERE id = $1',
    [userId],
  );
  return rows[0]?.home_municipality ?? null;
}

export async function setHomeTown(userId: string, town: string | null): Promise<void> {
  const pool = getPool();
  if (!pool) {
    memoryHomeTowns.set(userId, town);
    return;
  }
  await pool.query('UPDATE users SET home_municipality = $2 WHERE id = $1', [userId, town]);
}
