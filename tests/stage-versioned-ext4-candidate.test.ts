import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const scriptPath = resolve(__dirname, '../scripts/stage-versioned-ext4-candidate.sh');
const script = readFileSync(scriptPath, 'utf8');

describe('versioned ext4 candidate stager safety contract', () => {
  it('pins the exact local recovery ref and its captured commit and tree', () => {
    expect(script).toContain('DEFAULT_REF="refs/backup/codex-alpha-2026-10-03-post-origin-hardening"');
    expect(script).toContain('EXPECTED_COMMIT="00d783730b5aeaf02c9e71e571efebaecd8eafac"');
    expect(script).toContain('EXPECTED_TREE="1b0cc3a2675fba9de26e1da807aa5a1f21ce53c2"');
    expect(script).toContain('if (( $# != 0 )); then');
  });

  it('restricts the owner, source repository, release root, and runtime tooling', () => {
    expect(script).toContain('EXPECTED_USER="kaizo"');
    expect(script).toContain('EXPECTED_SOURCE_CANONICAL="/mnt/c/Users/HP/Desktop/Code/JuanderQuest/backend"');
    expect(script).toContain('RELEASES_ROOT="/home/kaizo/.local/share/juanderquest-alpha/releases"');
    expect(script).toContain('WSL_DISTRO_NAME');
    expect(script).toContain('NODE_MAJOR');
    expect(script).toContain('GIT_TOPLEVEL');
  });

  it('exports only the pinned Git tree and requires the exact migration ledger', () => {
    expect(script).toContain('git -C "${REPO_ROOT}" archive "${TARGET_REF}"');
    expect(script).toContain('REQUIRED_MIGRATIONS_COUNT=23');
    expect(script).toContain('MIGRATION_COUNT != REQUIRED_MIGRATIONS_COUNT');
    expect(script).toContain('SUSPICIOUS_SECRETS');
    expect(script).toContain("grep -q '^120000 '");
    expect(script).toContain('npm ci --ignore-scripts --no-audit --no-fund --silent');
  });

  it('never overwrites, recursively deletes, or moves a candidate on failure', () => {
    expect(script).toContain('if [[ -e "${TARGET_DIR}" ]]; then');
    expect(script).toContain('STAGING_FAILED');
    expect(script).not.toMatch(/\brm\s+-[a-z]*r/);
    expect(script).not.toMatch(/^\s*mv\s/m);
    expect(script).toContain('STAGE_FAILED=0');
  });

  it('does not hard-depend on the workstation-only recovery ref during this portable test', () => {
    // The script validates the ref at execution; normal CI only verifies the script contract.
    expect(script).toContain('rev-parse --verify --quiet "${TARGET_REF}^{commit}"');
  });

  const linuxIt = process.platform === 'linux' ? it : it.skip;
  linuxIt('passes bash syntax check on Linux', () => {
    execFileSync('bash', ['-n', scriptPath], { stdio: 'pipe' });
  });
});
