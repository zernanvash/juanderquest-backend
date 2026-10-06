#!/usr/bin/env bash
# ==============================================================================
# stage-versioned-ext4-candidate.sh
# 
# Stages an isolated, unprivileged, versioned backend ext4 release candidate
# from a captured local Git ref into /home/kaizo/.local/share/juanderquest-alpha/releases/.
#
# Handout & Security Specification:
#   docs/07-testing/2026-10-03-agy-versioned-ext4-candidate-staging.md
#
# BOUNDARY INVARIANTS:
#   - Runs ONLY under WSL Linux as unprivileged user 'kaizo'.
#   - Source repository MUST strictly resolve to /mnt/c/Users/HP/Desktop/Code/JuanderQuest/backend.
#   - Does NOT read .env files, production secrets, or live credentials.
#   - Does NOT overwrite any existing candidate directory.
#   - Uses git archive of the explicit captured ref (no dirty worktree, node_modules, or uploads).
#   - Enforces package-lock.json and all 23 numbered migrations present in exported tree.
#   - On failure, leaves failed directory marked (e.g. .failed) for inspection; NO broad deletion.
#   - Never modifies master, production ports, systemd/pm2, Cloudflare tunnel, or live DB.
# ==============================================================================

set -euo pipefail
umask 077

EXPECTED_USER="kaizo"
EXPECTED_SOURCE_CANONICAL="/mnt/c/Users/HP/Desktop/Code/JuanderQuest/backend"
DEFAULT_REF="refs/backup/codex-alpha-2026-10-03-post-origin-hardening"
EXPECTED_COMMIT="00d783730b5aeaf02c9e71e571efebaecd8eafac"
EXPECTED_TREE="1b0cc3a2675fba9de26e1da807aa5a1f21ce53c2"
RELEASES_ROOT="/home/kaizo/.local/share/juanderquest-alpha/releases"
REQUIRED_MIGRATIONS_COUNT=23

# --- 1. Environment & Preflight Invariants ---

# Platform & WSL check
if [[ "$(uname -s)" != "Linux" ]] || [[ -z "${WSL_DISTRO_NAME:-}" ]]; then
  echo "[ERROR] stage-candidate: Must run under WSL Linux." >&2
  exit 1
fi

# Unprivileged user check
CURRENT_USER="$(id -un)"
if [[ "${CURRENT_USER}" != "${EXPECTED_USER}" ]]; then
  echo "[ERROR] stage-candidate: Must run as unprivileged user '${EXPECTED_USER}', got '${CURRENT_USER}'." >&2
  exit 1
fi

# Tooling check
for tool in git tar node npm sha256sum diff; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "[ERROR] stage-candidate: Required tool '${tool}' is not installed or not in PATH." >&2
    exit 1
  fi
done

# Node version check (requires Node 22+)
NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+)\..*/\1/')"
if [[ -z "${NODE_MAJOR}" ]] || (( NODE_MAJOR < 22 )); then
  echo "[ERROR] stage-candidate: Node 22+ is required. Found: $(node -v)" >&2
  exit 1
fi

# Repository boundary check
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"

if [[ "${REPO_ROOT}" != "${EXPECTED_SOURCE_CANONICAL}" ]]; then
  echo "[ERROR] stage-candidate: Source repository must strictly be '${EXPECTED_SOURCE_CANONICAL}', got '${REPO_ROOT}'." >&2
  exit 1
fi

# Verify it is a valid git repository
GIT_TOPLEVEL="$(git -C "${REPO_ROOT}" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ "${GIT_TOPLEVEL}" != "${EXPECTED_SOURCE_CANONICAL}" ]]; then
  echo "[ERROR] stage-candidate: Git toplevel must be '${EXPECTED_SOURCE_CANONICAL}', got '${GIT_TOPLEVEL}'." >&2
  exit 1
fi

# This stager is intentionally pinned to one captured source tree.
if (( $# != 0 )); then
  echo "[ERROR] stage-candidate: Positional ref or target overrides are prohibited." >&2
  exit 1
fi
TARGET_REF="${DEFAULT_REF}"
if ! git -C "${REPO_ROOT}" rev-parse --verify --quiet "${TARGET_REF}^{commit}" >/dev/null; then
  echo "[ERROR] stage-candidate: Target ref '${TARGET_REF}' does not exist or is not a commit." >&2
  exit 1
fi

COMMIT_ID="$(git -C "${REPO_ROOT}" rev-parse --verify "${TARGET_REF}^{commit}")"
TREE_ID="$(git -C "${REPO_ROOT}" rev-parse --verify "${TARGET_REF}^{tree}")"
SHORT_COMMIT="$(git -C "${REPO_ROOT}" rev-parse --short=8 "${TARGET_REF}^{commit}")"
if [[ "${COMMIT_ID}" != "${EXPECTED_COMMIT}" || "${TREE_ID}" != "${EXPECTED_TREE}" ]]; then
  echo "[ERROR] stage-candidate: Pinned recovery ref identity changed." >&2
  exit 1
fi
RUN_SMOKE="${RUN_SMOKE:-0}"
if [[ "${RUN_SMOKE}" != "0" && "${RUN_SMOKE}" != "1" ]]; then
  echo "[ERROR] stage-candidate: RUN_SMOKE must be 0 or 1." >&2
  exit 1
fi

# Inspect ref contents before export: package-lock.json, no secret files, 23 migrations
TREE_FILES="$(git -C "${REPO_ROOT}" ls-tree -r --name-only "${TARGET_REF}")"

if ! echo "${TREE_FILES}" | grep -Fxq "package-lock.json"; then
  echo "[ERROR] stage-candidate: Ref '${TARGET_REF}' is missing required package-lock.json." >&2
  exit 1
fi

# Secret/ignored file scan in ref tree (only .env.example allowed among .env*)
SUSPICIOUS_SECRETS="$(echo "${TREE_FILES}" | grep -Ei '(^|/)(\.env($|\.)|[^/]*\.(jks|pem|key|p12|pfx|dump|bak|sqlite|db)$|id_rsa($|\.)|credentials?($|\.)|secrets?($|\.))' | grep -v '^\.env\.example$' || true)"
if [[ -n "${SUSPICIOUS_SECRETS}" ]]; then
  echo "[ERROR] stage-candidate: Ref contains forbidden secret or private environment files:" >&2
  echo "${SUSPICIOUS_SECRETS}" >&2
  exit 1
fi

# Migration count verification in ref tree
MIGRATION_COUNT="$(echo "${TREE_FILES}" | grep -E '^migrations/[0-9]{3}_.*\.sql$' | wc -l)"
if (( MIGRATION_COUNT != REQUIRED_MIGRATIONS_COUNT )); then
  echo "[ERROR] stage-candidate: Ref contains ${MIGRATION_COUNT} numbered migrations; expected exactly ${REQUIRED_MIGRATIONS_COUNT}." >&2
  exit 1
fi
for migration_number in $(seq 1 "${REQUIRED_MIGRATIONS_COUNT}"); do
  printf -v migration_prefix '%03d' "${migration_number}"
  if ! echo "${TREE_FILES}" | grep -Eq "^migrations/${migration_prefix}_[^/]+[.]sql$"; then
    echo "[ERROR] stage-candidate: Migration ${migration_prefix} is missing." >&2
    exit 1
  fi
done
if git -C "${REPO_ROOT}" ls-tree -r "${TARGET_REF}" | grep -q '^120000 '; then
  echo "[ERROR] stage-candidate: Symlinks are prohibited in the captured tree." >&2
  exit 1
fi

# --- 2. Release Directory & Safety Boundary ---

# Canonical release root check
if [[ ! -d "${RELEASES_ROOT}" ]]; then
  mkdir -p "${RELEASES_ROOT}"
  chmod 0700 "${RELEASES_ROOT}"
fi

RESOLVED_RELEASES_ROOT="$(cd "${RELEASES_ROOT}" && pwd -P)"
if [[ "${RESOLVED_RELEASES_ROOT}" != "${RELEASES_ROOT}" ]]; then
  echo "[ERROR] stage-candidate: Releases root resolved to unexpected path '${RESOLVED_RELEASES_ROOT}'." >&2
  exit 1
fi

# Unique timestamped directory name
DATE_STAMP="$(date -u +%Y%m%d%H%M%S)"
CANDIDATE_NAME="backend-${SHORT_COMMIT}-${DATE_STAMP}"
TARGET_DIR="${RELEASES_ROOT}/${CANDIDATE_NAME}"

# Ensure candidate does not already exist
if [[ -e "${TARGET_DIR}" ]]; then
  echo "[ERROR] stage-candidate: Target candidate directory '${TARGET_DIR}' already exists. Aborting." >&2
  exit 1
fi

# Path safety invariant: Target directory must remain strictly under RELEASES_ROOT
case "${TARGET_DIR}" in
  "${RELEASES_ROOT}"/*) ;;
  *)
    echo "[ERROR] stage-candidate: Target directory '${TARGET_DIR}' is not inside '${RELEASES_ROOT}'." >&2
    exit 1
    ;;
esac

# Create candidate directory mode 0700
mkdir -m 0700 "${TARGET_DIR}"
STAGE_FAILED=1

cleanup_on_failure() {
  if [[ "${STAGE_FAILED}" -eq 1 ]]; then
    echo "[WARN] stage-candidate: Staging did not complete successfully." >&2
    if [[ -d "${TARGET_DIR}" ]]; then
      printf 'Staging failed at %s UTC; inspect this directory before reuse.\n' "$(date -u +%Y-%m-%dT%H:%M:%S)" > "${TARGET_DIR}/STAGING_FAILED" || true
      chmod 0600 "${TARGET_DIR}/STAGING_FAILED" 2>/dev/null || true
      echo "[WARN] stage-candidate: Preserved failed directory '${TARGET_DIR}' for inspection (no move or deletion)." >&2
    fi
  fi
}
trap cleanup_on_failure EXIT

# --- 3. Export Tree Only (git archive) ---

echo "[INFO] stage-candidate: Exporting Git tree (${SHORT_COMMIT}) into '${TARGET_DIR}'..."
git -C "${REPO_ROOT}" archive "${TARGET_REF}" | tar -x -C "${TARGET_DIR}"

# Ensure permissions on exported tree are owner-only. Symlinks were rejected above.
chmod -R u=rwX,go= "${TARGET_DIR}"

# Verify the extracted inventory exactly equals the pinned Git tree before npm writes files.
if ! diff -u <(printf '%s\n' "${TREE_FILES}" | LC_ALL=C sort) <(find "${TARGET_DIR}" -type f -printf '%P\n' | LC_ALL=C sort); then
  echo "[ERROR] stage-candidate: Extracted file inventory differs from the pinned Git tree." >&2
  exit 1
fi

# Verify exported tree structure
if [[ ! -f "${TARGET_DIR}/package.json" ]] || [[ ! -f "${TARGET_DIR}/package-lock.json" ]]; then
  echo "[ERROR] stage-candidate: Exported directory lacks package manifests." >&2
  exit 1
fi

EXPORTED_MIGRATIONS="$(find "${TARGET_DIR}/migrations" -maxdepth 1 -name '[0-9][0-9][0-9]_*.sql' | wc -l)"
if (( EXPORTED_MIGRATIONS != REQUIRED_MIGRATIONS_COUNT )); then
  echo "[ERROR] stage-candidate: Exported directory contains ${EXPORTED_MIGRATIONS} migrations; expected exactly ${REQUIRED_MIGRATIONS_COUNT}." >&2
  exit 1
fi

# Verify no .env or private files leaked into target
if find "${TARGET_DIR}" -maxdepth 1 -name '.env*' ! -name '.env.example' | grep -q .; then
  echo "[ERROR] stage-candidate: Found forbidden .env file in exported candidate." >&2
  exit 1
fi

# --- 4. Install Locked Dependencies & Build ---

echo "[INFO] stage-candidate: Running npm ci in candidate directory..."
(
  cd "${TARGET_DIR}"
  npm ci --ignore-scripts --no-audit --no-fund --silent
)

echo "[INFO] stage-candidate: Compiling TypeScript (npm run build)..."
(
  cd "${TARGET_DIR}"
  npm run build
)

if [[ ! -f "${TARGET_DIR}/dist/server.js" ]]; then
  echo "[ERROR] stage-candidate: Build artifact '${TARGET_DIR}/dist/server.js' was not produced." >&2
  exit 1
fi

DIST_SERVER_HASH="$(sha256sum "${TARGET_DIR}/dist/server.js" | awk '{print $1}')"

# --- 5. Optional Production Smoke against Disposable Reliability DB ---

SMOKE_STATUS="not_run"
if [[ "${RUN_SMOKE}" == "1" ]]; then
  echo "[INFO] stage-candidate: RUN_SMOKE=1 requested. Executing isolated smoke test..."
  SMOKE_SCRIPT="${TARGET_DIR}/scripts/run-alpha-production-smoke-wsl.mjs"
  if [[ ! -f "${SMOKE_SCRIPT}" ]]; then
    echo "[ERROR] stage-candidate: Smoke script '${SMOKE_SCRIPT}' not found." >&2
    exit 1
  fi
  (
    cd "${TARGET_DIR}"
    node "${SMOKE_SCRIPT}"
  )
  SMOKE_STATUS="passed"
  echo "[INFO] stage-candidate: Isolated production smoke completed successfully."
else
  echo "[INFO] stage-candidate: Isolated smoke omitted (RUN_SMOKE=0). Staging complete."
fi

# Write the manifest only after every requested check has passed.
MANIFEST_FILE="${TARGET_DIR}/candidate-manifest.json"
cat > "${MANIFEST_FILE}" <<EOF
{
  "candidate": "${CANDIDATE_NAME}",
  "ref": "${TARGET_REF}",
  "commit": "${COMMIT_ID}",
  "tree": "${TREE_ID}",
  "staged_at_utc": "$(date -u -Iseconds)",
  "node_version": "$(node -v)",
  "npm_version": "$(npm -v)",
  "dist_server_sha256": "${DIST_SERVER_HASH}",
  "migrations_count": ${EXPORTED_MIGRATIONS},
  "smoke_status": "${SMOKE_STATUS}",
  "status": "staged_candidate_only"
}
EOF
chmod 0600 "${MANIFEST_FILE}"
STAGE_FAILED=0
echo "[INFO] stage-candidate: Candidate successfully staged at '${TARGET_DIR}'."
echo "[INFO] stage-candidate: Manifest created at '${MANIFEST_FILE}'."
echo "[INFO] stage-candidate: dist/server.js SHA-256: ${DIST_SERVER_HASH}"
