export interface LevelProgression {
  level: number;
  title: string;
  xp: number;
  next_level_xp: number;
  current_tier_base_xp: number;
}

export function getExplorerLevel(xp: number): LevelProgression {
  const safeXp = Math.max(0, Math.floor(xp));
  // Quadratic threshold: Level L requires 50 * (L - 1) * L XP
  // L=1: 0, L=2: 100, L=3: 300, L=4: 600, L=5: 1000, L=6: 1500, etc.
  let level = 1;
  while (50 * level * (level + 1) <= safeXp) {
    level++;
  }
  const currentBase = 50 * (level - 1) * level;
  const nextXp = 50 * level * (level + 1);

  const titles: Record<number, string> = {
    1: 'Novice Pathfinder',
    2: 'Trail Wanderer',
    3: 'Island Roamer',
    4: 'Provincial Explorer',
    5: 'Pangasinan Pioneer',
    6: 'Coastal Navigator',
    7: 'Heritage Vanguard',
    8: 'Master Pathfinder',
  };

  const title = titles[level] || `Pangasinan Legend — Lv. ${level}`;

  return {
    level,
    title,
    xp: safeXp,
    next_level_xp: nextXp,
    current_tier_base_xp: currentBase,
  };
}

export function getCivicLevel(xp: number, stamps: number): LevelProgression {
  const safeXp = Math.max(0, Math.floor(xp));
  // Civic thresholds:
  // L1: 0, L2: 50, L3: 125, L4: 250, L5: 450, L6: 700...
  let level = 1;
  while (25 * level * (level + 1) <= safeXp) {
    level++;
  }
  const currentBase = 25 * (level - 1) * level;
  const nextXp = 25 * level * (level + 1);

  const titles: Record<number, string> = {
    1: 'Local Citizen',
    2: 'Community Observer',
    3: 'Civic Contributor',
    4: 'Community Pathfinder',
    5: 'Voice of Pangasinan',
    6: 'Civic Guardian',
  };

  const title = titles[level] || `Civic Pillar — Lv. ${level}`;

  return {
    level,
    title,
    xp: safeXp,
    next_level_xp: nextXp,
    current_tier_base_xp: currentBase,
  };
}

export function getScoutLevel(reputation: number): { level: number; title: string; reputation: number } {
  const safeRep = Math.max(0, Math.floor(reputation));
  let level = 1;
  let title = 'Community Scout';

  if (safeRep >= 500) {
    level = 5;
    title = 'Regional Guardian';
  } else if (safeRep >= 250) {
    level = 4;
    title = 'Veteran Scout';
  } else if (safeRep >= 100) {
    level = 3;
    title = 'Trusted Local';
  } else if (safeRep >= 50) {
    level = 2;
    title = 'Active Scout';
  }

  return {
    level,
    title,
    reputation: safeRep,
  };
}
