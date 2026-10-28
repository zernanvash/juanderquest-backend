export type SettingValue = string | number | boolean;

export interface SettingDefinition {
  key: string;
  label: string;
  category: 'branding_support' | 'quiz_defaults' | 'quest_funding' | 'trail_economy' | 'stamps';
  type: 'email' | 'url' | 'text' | 'integer' | 'boolean' | 'string';
  defaultValue: SettingValue;
  min?: number;
  max?: number;
  maxLength?: number;
  allowedValues?: string[];
  restartRequired: boolean;
  description: string;
}

// Explicit, low-risk allowlist. Adding a key here is an intentional product
// decision; secrets, deployment configuration, tokens and credentials are
// structurally excluded and can never be stored through this schema.
export const SETTINGS_DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: 'support_contact_email',
    label: 'Public support contact email',
    category: 'branding_support',
    type: 'email',
    defaultValue: '',
    maxLength: 255,
    restartRequired: false,
    description: 'Shown on approved support surfaces. Leave empty to hide.',
  },
  {
    key: 'support_help_url',
    label: 'Approved help link',
    category: 'branding_support',
    type: 'url',
    defaultValue: '',
    maxLength: 500,
    restartRequired: false,
    description: 'HTTPS link to the approved traveler help page. Leave empty to hide.',
  },
  {
    key: 'announcement_message',
    label: 'Operator announcement',
    category: 'branding_support',
    type: 'text',
    defaultValue: '',
    maxLength: 280,
    restartRequired: false,
    description: 'Plain-text announcement for approved surfaces. HTML is rejected.',
  },
  {
    key: 'quiz_default_language',
    label: 'Default quiz language',
    category: 'quiz_defaults',
    type: 'string',
    defaultValue: 'en',
    allowedValues: ['en', 'fil', 'ilo', 'pag'],
    restartRequired: false,
    description: 'Applies to new quiz drafts only; active quizzes and earned XP are never rewritten.',
  },
  {
    key: 'quiz_default_radius_meters',
    label: 'Default quiz start radius (m)',
    category: 'quiz_defaults',
    type: 'integer',
    defaultValue: 200,
    min: 100,
    max: 1000,
    restartRequired: false,
    description: 'Applies to new quiz drafts only.',
  },
  {
    key: 'quiz_default_time_limit_minutes',
    label: 'Default quiz time limit (minutes)',
    category: 'quiz_defaults',
    type: 'integer',
    defaultValue: 30,
    min: 5,
    max: 120,
    restartRequired: false,
    description: 'Applies to new quiz drafts only.',
  },
  {
    key: 'quiz_default_cooldown_hours',
    label: 'Default quiz cooldown after failure (hours)',
    category: 'quiz_defaults',
    type: 'integer',
    defaultValue: 24,
    min: 1,
    max: 168,
    restartRequired: false,
    description: 'Applies to new quiz drafts only.',
  },
  {
    key: 'quiz_default_xp_reward',
    label: 'Default quiz XP reward',
    category: 'quiz_defaults',
    type: 'integer',
    defaultValue: 25,
    min: 1,
    max: 500,
    restartRequired: false,
    description: 'Applies to new quiz drafts only; existing XP is never changed.',
  },
  {
    key: 'quest_funding_fee_bps', label: 'Quest funding platform fee (basis points)', category: 'quest_funding',
    type: 'integer', defaultValue: 500, min: 0, max: 1000, restartRequired: false,
    description: 'Snapshotted when a funding plan is submitted; does not change active plans.',
  },
  {
    key: 'merchant_purchase_daily_cap', label: 'Merchant simulated-purchase daily cap (points)', category: 'quest_funding',
    type: 'integer', defaultValue: 5000, min: 0, max: 100000, restartRequired: false,
    description: 'Maximum simulated merchant points issuance per merchant per UTC day.',
  },
  {
    key: 'merchant_purchase_monthly_cap', label: 'Merchant simulated-purchase monthly cap (points)', category: 'quest_funding',
    type: 'integer', defaultValue: 20000, min: 0, max: 1000000, restartRequired: false,
    description: 'Maximum simulated merchant points issuance per merchant per UTC month.',
  },
  {
    key: 'sponsorship_deadline_days', label: 'Quest sponsorship deadline (days)', category: 'quest_funding',
    type: 'integer', defaultValue: 7, min: 1, max: 30, restartRequired: false,
    description: 'Snapshotted when a plan is submitted.',
  },
  {
    key: 'funding_hold_ttl_hours', label: 'Quest reward hold duration (hours)', category: 'quest_funding',
    type: 'integer', defaultValue: 48, min: 1, max: 168, restartRequired: false,
    description: 'Snapshotted when a plan is submitted; hold cannot outlive the plan grace window.',
  },
  {
    key: 'funding_window_min_days', label: 'Minimum funding window (days)', category: 'quest_funding',
    type: 'integer', defaultValue: 1, min: 1, max: 365, restartRequired: false,
    description: 'Minimum permitted duration for new funding plans.',
  },
  {
    key: 'funding_window_max_days', label: 'Maximum funding window (days)', category: 'quest_funding',
    type: 'integer', defaultValue: 90, min: 1, max: 365, restartRequired: false,
    description: 'Maximum permitted duration for new funding plans.',
  },
  {
    key: 'max_open_sponsorship_requests_per_plan', label: 'Open sponsor requests per plan', category: 'quest_funding',
    type: 'integer', defaultValue: 10, min: 1, max: 50, restartRequired: false,
    description: 'Caps outstanding sponsorship requests for each funding plan.',
  },
  {
    key: 'voucher_income_enabled', label: 'Enable merchant voucher income', category: 'quest_funding',
    type: 'boolean', defaultValue: false, restartRequired: false,
    description: 'Optional future prototype accounting path; no real money is involved.',
  },
  { key: 'trail_starter_reward_points', label: 'Starter trail completion reward', category: 'trail_economy', type: 'integer', defaultValue: 50, min: 0, max: 10000, restartRequired: false, description: 'Off-chain mJDQ points awarded once after all trail stops are verified.' },
  { key: 'trail_explorer_min_level', label: 'Explorer trail minimum level', category: 'trail_economy', type: 'integer', defaultValue: 5, min: 1, max: 100, restartRequired: false, description: 'Minimum Explorer level required to unlock Explorer trails.' },
  { key: 'trail_explorer_reward_points', label: 'Explorer trail completion reward', category: 'trail_economy', type: 'integer', defaultValue: 100, min: 0, max: 10000, restartRequired: false, description: 'Off-chain mJDQ points awarded once after all trail stops are verified.' },
  { key: 'trail_signature_unlock_points', label: 'Signature trail unlock price', category: 'trail_economy', type: 'integer', defaultValue: 300, min: 1, max: 100000, restartRequired: false, description: 'mJDQ points sunk when a traveler unlocks a Signature trail.' },
  { key: 'trail_signature_reward_points', label: 'Signature trail completion reward', category: 'trail_economy', type: 'integer', defaultValue: 200, min: 0, max: 10000, restartRequired: false, description: 'Off-chain mJDQ points awarded once after all trail stops are verified.' },
  { key: 'trail_legendary_unlock_points', label: 'Legendary trail unlock price', category: 'trail_economy', type: 'integer', defaultValue: 500, min: 1, max: 100000, restartRequired: false, description: 'mJDQ points sunk when a traveler unlocks a Legendary trail.' },
  { key: 'trail_legendary_reward_points', label: 'Legendary trail completion reward', category: 'trail_economy', type: 'integer', defaultValue: 350, min: 0, max: 10000, restartRequired: false, description: 'Off-chain mJDQ points awarded once after all trail stops are verified.' },
  { key: 'trail_personal_free_per_week', label: 'Free tailored trails per week', category: 'trail_economy', type: 'integer', defaultValue: 0, min: 0, max: 10, restartRequired: false, description: 'Weekly free personal trail generation allowance.' },
  { key: 'trail_personal_generation_enabled', label: 'Tailored trails (traveler-generated)', category: 'trail_economy', type: 'boolean', defaultValue: false, restartRequired: false, description: 'Allow travelers to generate personal trails. Admin-created and reviewed trails remain available when this is off.' },
  { key: 'trail_personal_generation_points', label: 'Tailored trail price', category: 'trail_economy', type: 'integer', defaultValue: 150, min: 1, max: 10000, restartRequired: false, description: 'mJDQ points charged after the free weekly allowance.' },
  { key: 'trail_personal_reward_points', label: 'Tailored trail completion reward', category: 'trail_economy', type: 'integer', defaultValue: 50, min: 0, max: 10000, restartRequired: false, description: 'Off-chain mJDQ points awarded once after all trail stops are verified.' },
  {
    key: 'stamps_weekly_cap', label: 'Weekly stamp cap', category: 'stamps',
    type: 'integer', defaultValue: 250, min: 0, max: 10000, restartRequired: false,
    description: 'Hard maximum stamps earned per Manila week across every source.',
  },
  {
    key: 'stamps_daily_claim_stamps', label: 'Daily claim stamps (days 1-6)', category: 'stamps',
    type: 'integer', defaultValue: 5, min: 0, max: 100, restartRequired: false,
    description: 'Stamps granted for each of the first six days of the forgiving calendar.',
  },
  {
    key: 'stamps_daily_claim_day7_stamps', label: 'Daily claim stamps (day 7)', category: 'stamps',
    type: 'integer', defaultValue: 25, min: 0, max: 100, restartRequired: false,
    description: 'Stamps granted for the seventh day of the forgiving calendar.',
  },
  {
    key: 'stamps_weekly_chest_required', label: 'Weekly chest missions required', category: 'stamps',
    type: 'integer', defaultValue: 5, min: 1, max: 21, restartRequired: false,
    description: 'Completed daily missions needed to open the weekly chest.',
  },
  {
    key: 'stamps_weekly_chest_stamps', label: 'Weekly chest stamps', category: 'stamps',
    type: 'integer', defaultValue: 30, min: 0, max: 500, restartRequired: false,
    description: 'Stamps granted once per Manila week when the chest requirement is met.',
  },
  {
    key: 'stamps_streak_shield_price', label: 'Streak shield price (stamps)', category: 'stamps',
    type: 'integer', defaultValue: 100, min: 0, max: 10000, restartRequired: false,
    description: 'Stamp price of one streak shield.',
  },
  {
    key: 'stamps_streak_shields_max', label: 'Maximum streak shields held', category: 'stamps',
    type: 'integer', defaultValue: 2, min: 0, max: 10, restartRequired: false,
    description: 'Shields a traveler may hold at once. Shields never grant stamps.',
  },
];

export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingDefinition> = new Map(
  SETTINGS_DEFINITIONS.map((definition) => [definition.key, definition])
);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SettingValidation = { ok: true; value: SettingValue } | { ok: false; message: string };

export function validateSettingValue(definition: SettingDefinition, raw: unknown): SettingValidation {
  switch (definition.type) {
    case 'email': {
      if (typeof raw !== 'string') return { ok: false, message: `${definition.label} must be text.` };
      const value = raw.trim();
      if (!value) return { ok: true, value: '' };
      if (value.length > (definition.maxLength ?? 255)) return { ok: false, message: `${definition.label} is too long.` };
      if (!EMAIL_PATTERN.test(value)) return { ok: false, message: `${definition.label} must be a valid email address.` };
      return { ok: true, value };
    }
    case 'url': {
      if (typeof raw !== 'string') return { ok: false, message: `${definition.label} must be text.` };
      const value = raw.trim();
      if (!value) return { ok: true, value: '' };
      if (value.length > (definition.maxLength ?? 500)) return { ok: false, message: `${definition.label} is too long.` };
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          return { ok: false, message: `${definition.label} must use http or https.` };
        }
      } catch {
        return { ok: false, message: `${definition.label} must be a valid URL.` };
      }
      return { ok: true, value };
    }
    case 'text': {
      if (typeof raw !== 'string') return { ok: false, message: `${definition.label} must be text.` };
      const value = raw.trim();
      if (value.length > (definition.maxLength ?? 280)) return { ok: false, message: `${definition.label} is too long.` };
      if (/[<>]/.test(value)) return { ok: false, message: `${definition.label} must be plain text without HTML.` };
      return { ok: true, value };
    }
    case 'string': {
      if (typeof raw !== 'string') return { ok: false, message: `${definition.label} must be text.` };
      if (definition.allowedValues && !definition.allowedValues.includes(raw)) {
        return { ok: false, message: `${definition.label} must be one of: ${definition.allowedValues.join(', ')}.` };
      }
      return { ok: true, value: raw };
    }
    case 'integer': {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) {
        return { ok: false, message: `${definition.label} must be a whole number.` };
      }
      if (definition.min !== undefined && raw < definition.min) {
        return { ok: false, message: `${definition.label} must be at least ${definition.min}.` };
      }
      if (definition.max !== undefined && raw > definition.max) {
        return { ok: false, message: `${definition.label} must be at most ${definition.max}.` };
      }
      return { ok: true, value: raw };
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') return { ok: false, message: `${definition.label} must be true or false.` };
      return { ok: true, value: raw };
    }
    default:
      return { ok: false, message: `${definition.label} has an unsupported type.` };
  }
}

export function canonicalSettings(stored: Record<string, unknown> | null | undefined): Record<string, SettingValue> {
  const values: Record<string, SettingValue> = {};
  for (const definition of SETTINGS_DEFINITIONS) {
    const raw = stored ? stored[definition.key] : undefined;
    if (raw === undefined) {
      values[definition.key] = definition.defaultValue;
      continue;
    }
    const validation = validateSettingValue(definition, raw);
    values[definition.key] = validation.ok ? validation.value : definition.defaultValue;
  }
  return values;
}
