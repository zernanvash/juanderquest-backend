import type { Pool, PoolClient } from 'pg';
import { canonicalSettings } from '../settings/schema.js';

export interface TrailEconomyConfig {
  personalGenerationEnabled: boolean;
  starterRewardPoints: number;
  explorerMinLevel: number;
  explorerRewardPoints: number;
  signatureUnlockPoints: number;
  signatureRewardPoints: number;
  legendaryUnlockPoints: number;
  legendaryRewardPoints: number;
  personalFreePerWeek: number;
  personalGenerationPoints: number;
  personalRewardPoints: number;
}

const defaults: TrailEconomyConfig = {
  personalGenerationEnabled: false,
  starterRewardPoints: 50,
  explorerMinLevel: 5,
  explorerRewardPoints: 100,
  signatureUnlockPoints: 300,
  signatureRewardPoints: 200,
  legendaryUnlockPoints: 500,
  legendaryRewardPoints: 350,
  personalFreePerWeek: 0,
  personalGenerationPoints: 150,
  personalRewardPoints: 50,
};

const keys: Record<Exclude<keyof TrailEconomyConfig, 'personalGenerationEnabled'>, string> = {
  starterRewardPoints: 'trail_starter_reward_points',
  explorerMinLevel: 'trail_explorer_min_level',
  explorerRewardPoints: 'trail_explorer_reward_points',
  signatureUnlockPoints: 'trail_signature_unlock_points',
  signatureRewardPoints: 'trail_signature_reward_points',
  legendaryUnlockPoints: 'trail_legendary_unlock_points',
  legendaryRewardPoints: 'trail_legendary_reward_points',
  personalFreePerWeek: 'trail_personal_free_per_week',
  personalGenerationPoints: 'trail_personal_generation_points',
  personalRewardPoints: 'trail_personal_reward_points',
};

type SettingsClient = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/** Read the validated, allowlisted trail settings; the plan defaults apply to older settings rows. */
export async function loadTrailEconomy(client: SettingsClient): Promise<TrailEconomyConfig> {
  const { rows } = await client.query('SELECT values FROM system_settings_document WHERE id=1');
  const stored = canonicalSettings(rows[0]?.values ?? {});
  const result = { ...defaults };
  result.personalGenerationEnabled = stored.trail_personal_generation_enabled === true;
  for (const [property, key] of Object.entries(keys) as Array<[Exclude<keyof TrailEconomyConfig, 'personalGenerationEnabled'>, string]>) {
    const value = Number(stored[key]);
    if (Number.isInteger(value) && value >= 0 && Number.isSafeInteger(value)) result[property] = value;
  }
  return result;
}

export function trailEconomyDefaults(): TrailEconomyConfig {
  return { ...defaults };
}

