/**
 * Perk resolution for the Juander Pass (Phase 2).
 *
 * Phase 1 ships this stub deliberately: no traveler owns a pass yet, so every
 * perk is false. Phase 2 will read vip_memberships and the settings allowlist
 * without changing this call signature.
 */
export type PerkKey =
  | 'vip_weekly_shield'
  | 'vip_early_access'
  | 'vip_shop_discount'
  | 'vip_profile_frame';

export async function hasPerk(_userId: string, _key: PerkKey | string): Promise<boolean> {
  return false;
}
