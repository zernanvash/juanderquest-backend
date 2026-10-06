import { execSync } from 'node:child_process';

function queryDb(container, user, db, sql) {
  const prefix = process.platform === 'win32' ? 'wsl ' : '';
  const cmd = `${prefix}docker exec ${container} psql -U ${user} -d ${db} -tAc "${sql}"`;
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function getDatabaseMetrics(target) {
  const isAlpha = target === 'alpha';
  const container = isAlpha ? 'jdq-alpha-postgres' : 'jdq-presentation-postgres';
  const user = isAlpha ? 'jdq_alpha' : 'jdq_presentation';
  const db = isAlpha ? 'juanderquest_alpha' : 'juanderquest_presentation';

  const tables = [
    'users',
    'juanchoice_campaigns',
    'juanchoice_candidates',
    'juanchoice_ballots',
    'juanchoice_ballot_events',
    'juanchoice_participations',
    'progression_totals',
    'progression_events',
    'governance_ledger',
    'schema_migrations',
    'spots',
  ];

  const counts = {};
  for (const tbl of tables) {
    const raw = queryDb(container, user, db, `SELECT count(*) FROM ${tbl};`);
    counts[tbl] = parseInt(raw, 10);
  }

  const sumsRaw = queryDb(
    container,
    user,
    db,
    "SELECT COALESCE(sum(explorer_xp),0) || '|' || COALESCE(sum(civic_xp),0) || '|' || COALESCE(sum(civic_stamps),0) FROM progression_totals;"
  );
  const [explorerXp, civicXp, civicStamps] = sumsRaw.split('|').map(s => parseInt(s, 10));

  return {
    ...counts,
    total_explorer_xp: explorerXp,
    total_civic_xp: civicXp,
    total_civic_stamps: civicStamps,
  };
}

console.log('ALPHA:', JSON.stringify(getDatabaseMetrics('alpha'), null, 2));
console.log('PRESENTATION:', JSON.stringify(getDatabaseMetrics('presentation'), null, 2));
