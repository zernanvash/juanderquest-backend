# Local-only wrapper for the disposable PostgreSQL reliability container.
# The password stays in process memory; the URL is never printed.
param(
  [ValidateRange(30000, 600000)][int]$DurationMs = 600000,
  [ValidateRange(1, 50)][int]$PoolMax = 5,
  [ValidateSet('capacity', 'pilot', 'lifecycle', 'scheduler', 'retention', 'upgrade')][string]$Mode = 'capacity'
)
$ErrorActionPreference = 'Stop'
$container = 'jdq-reliability-pg-20260910'
$ports = @(& wsl -e docker port $container 5432)
if ($LASTEXITCODE -ne 0 -or $ports.Count -ne 1 -or $ports[0].Trim() -ne '127.0.0.1:55432') {
  throw "Expected the exact loopback reliability PostgreSQL port 127.0.0.1:55432; observed $($ports.Count) line(s): $($ports -join ', ')."
}
$dbName = (& wsl -e docker exec $container printenv POSTGRES_DB).Trim()
$dbUser = (& wsl -e docker exec $container printenv POSTGRES_USER).Trim()
$dbPassword = (& wsl -e docker exec $container printenv POSTGRES_PASSWORD).Trim()
if ($LASTEXITCODE -ne 0 -or $dbName -ne 'jdq_reliability_test' -or -not $dbUser -or -not $dbPassword) {
  throw 'Reliability PostgreSQL identity did not match the isolated test database.'
}
$previousUrl = [Environment]::GetEnvironmentVariable('JDQ_REAL_PG_URL', 'Process')
$previousNodeEnv = [Environment]::GetEnvironmentVariable('NODE_ENV', 'Process')
$previousDuration = [Environment]::GetEnvironmentVariable('JDQ_CAPACITY_DURATION_MS', 'Process')
$previousPoolMax = [Environment]::GetEnvironmentVariable('JDQ_CAPACITY_POOL_MAX', 'Process')
$encodedUser = [Uri]::EscapeDataString($dbUser)
$encodedPassword = [Uri]::EscapeDataString($dbPassword)
$env:JDQ_REAL_PG_URL = "postgresql://${encodedUser}:${encodedPassword}@127.0.0.1:55432/jdq_reliability_test"
$env:NODE_ENV = 'test'
$env:JDQ_CAPACITY_DURATION_MS = [string]$DurationMs
$env:JDQ_CAPACITY_POOL_MAX = [string]$PoolMax
$result = 1
try {
  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    if ($Mode -eq 'pilot') {
      & rtk npm test -- --runInBand tests/juanchoice-pilot.test.ts
    } elseif ($Mode -eq 'lifecycle') {
      & rtk npm test -- --runInBand tests/juanchoice-monthly-lifecycle-realpg.test.ts
    } elseif ($Mode -eq 'scheduler') {
      & rtk npm test -- --runInBand tests/juanchoice-scheduler-operations.test.ts
    } elseif ($Mode -eq 'retention') {
      & rtk npm test -- --runInBand tests/juanchoice-retention.test.ts
    } elseif ($Mode -eq 'upgrade') {
      & rtk npm test -- --runInBand tests/juanchoice-monthly-upgrade.test.ts
    } else {
      & rtk npm run test:juanchoice-capacity
    }
    $result = $LASTEXITCODE
  } finally {
    Pop-Location
  }
} finally {
  [Environment]::SetEnvironmentVariable('JDQ_REAL_PG_URL', $previousUrl, 'Process')
  [Environment]::SetEnvironmentVariable('NODE_ENV', $previousNodeEnv, 'Process')
  [Environment]::SetEnvironmentVariable('JDQ_CAPACITY_DURATION_MS', $previousDuration, 'Process')
  [Environment]::SetEnvironmentVariable('JDQ_CAPACITY_POOL_MAX', $previousPoolMax, 'Process')
  $dbPassword = $null
}
exit $result
