import fs from 'node:fs';
import path from 'node:path';

describe('juanchoice capacity rehearsal dormant read-header wiring static contract', () => {
  const rehearsalPath = path.resolve(__dirname, '..', 'scripts', 'juanchoice-capacity-rehearsal.ts');
  let rehearsalSource: string;

  beforeAll(() => {
    rehearsalSource = fs.readFileSync(rehearsalPath, 'utf8');
  });

  it('verifies readRound request headers spread buildReaderAuthHeaders alongside X-Forwarded-For', () => {
    // Check import
    expect(rehearsalSource).toMatch(
      /import\s*\{\s*[^}]*\bbuildReaderAuthHeaders\b[^}]*\}\s*from\s*['"]\.\/juanchoice-capacity-reader-headers(?:\.js)?['"]/
    );

    // Extract readRound definition
    const readRoundMatch = rehearsalSource.match(
      /const\s+readRound\s*=\s*\([^)]*\)\s*=>[\s\S]*?(?=\n\s*(?:const\s+[a-zA-Z0-9_$]+\s*=|let\s+[a-zA-Z0-9_$]+\s*=|async\s+function|function|\/\*\*))/
    );
    expect(readRoundMatch).not.toBeNull();
    const readRoundBlock = readRoundMatch![0];

    // Verify X-Forwarded-For is present in readRound
    expect(readRoundBlock).toMatch(/['"]X-Forwarded-For['"]\s*:\s*`10\.40\.1\.\$\{i\s*\+\s*1\}`/);

    // Verify buildReaderAuthHeaders is spread in readRound headers with exact arguments
    expect(readRoundBlock).toMatch(
      /\.\.\.buildReaderAuthHeaders\(\s*readerAuthMode\s*,\s*i\s*,\s*readerTokens\s*,\s*readerCount\s*\)/
    );
  });

  it('verifies vote still uses separate tokens[i] and Idempotency-Key', () => {
    // Extract vote definition
    const voteMatch = rehearsalSource.match(
      /const\s+vote\s*=\s*\([^)]*\)\s*=>[\s\S]*?(?=\n\s*(?:const\s+[a-zA-Z0-9_$]+\s*=|let\s+[a-zA-Z0-9_$]+\s*=|async\s+function|function|\/\*\*))/
    );
    expect(voteMatch).not.toBeNull();
    const voteBlock = voteMatch![0];

    // Verify voter headers use tokens[i], not readerTokens
    expect(voteBlock).toMatch(/Authorization:\s*`Bearer \$\{tokens\[i\]\}`/);
    expect(voteBlock).not.toContain('readerTokens');
    expect(voteBlock).toMatch(/['"]X-Forwarded-For['"]\s*:\s*`10\.40\.2\.\$\{i\s*\+\s*1\}`/);
  });

  it('verifies the static parent wiring contract: START includes explicit mode, wallet-only reader tokens, guest omission, and no token logging/env transport', () => {
    // 1. Verify obsolete WALLET_ALPHA_CHILD_NOT_IMPLEMENTED gate is removed
    expect(rehearsalSource).not.toContain('WALLET_ALPHA_CHILD_NOT_IMPLEMENTED');

    // 2. Extract child START message construction block
    const startMsgMatch = rehearsalSource.match(
      /const\s+startMsg:\s*ParentToChildMessage\s*=\s*\{[\s\S]*?child\.send\(startMsg\);/
    );
    expect(startMsgMatch).not.toBeNull();
    const startMsgBlock = startMsgMatch![0];

    // 3. Verify readerAuthMode is explicitly passed in START config
    expect(startMsgBlock).toMatch(/readerAuthMode(?:\s*:\s*readerAuthMode)?,/);

    // 4. Verify readerTokens is conditionally included ONLY for wallet_alpha, and omitted for guest
    expect(startMsgBlock).toMatch(
      /\.\.\.\(\s*readerAuthMode\s*===\s*['"]wallet_alpha['"]\s*\?\s*\{\s*readerTokens\s*\}\s*:\s*\{\}\s*\)/
    );

    // 5. Verify separate voter tokens array is passed unchanged
    expect(startMsgBlock).toMatch(/tokens(?:\s*:\s*tokens)?,/);

    // 6. Verify fork child environment does not transport JWT secret, DB URL, or tokens
    const forkMatch = rehearsalSource.match(/const\s+childEnv:\s*NodeJS\.ProcessEnv\s*=\s*\{[\s\S]*?\};\s*childProcess\s*=\s*fork\(/);
    expect(forkMatch).not.toBeNull();
    const childEnvBlock = forkMatch![0];
    expect(childEnvBlock).not.toContain('JWT_SECRET');
    expect(childEnvBlock).not.toContain('JDQ_REAL_PG_URL');
    expect(childEnvBlock).not.toContain('tokens');
    expect(childEnvBlock).not.toContain('readerTokens');
    expect(childEnvBlock).not.toContain('private');

    // 7. Verify rehearsal source never logs tokens or readerTokens
    expect(rehearsalSource).not.toMatch(/console\.(?:log|warn|error|info)\([^)]*\breaderTokens\b/);
    expect(rehearsalSource).not.toMatch(/process\.stdout\.write\([^)]*\breaderTokens\b/);
    expect(rehearsalSource).not.toMatch(/process\.stderr\.write\([^)]*\breaderTokens\b/);
  });

  it('verifies static source contract: ALPHA_WALLET_SIMULATION_ENABLED flag snapshot, conditional enable, and restoration', () => {
    // Note: This is static source-contract evidence, not a runtime failure-injection test.
    // 1. Verify ALPHA_WALLET_SIMULATION_ENABLED is captured in flags snapshot
    expect(rehearsalSource).toMatch(
      /const\s+flags\s*=\s*\{[\s\S]*?ALPHA_WALLET_SIMULATION_ENABLED:\s*env\.ALPHA_WALLET_SIMULATION_ENABLED[\s\S]*?\};/
    );

    // 2. Verify conditional enable is applied only if readerAuthMode === 'wallet_alpha'
    expect(rehearsalSource).toMatch(
      /Object\.assign\(\s*env\s*,\s*\{[\s\S]*?\.\.\.\(\s*readerAuthMode\s*===\s*['"]wallet_alpha['"]\s*\?\s*\{\s*ALPHA_WALLET_SIMULATION_ENABLED:\s*true\s*\}\s*:\s*\{\}\s*\)[\s\S]*?\}\s*\);/
    );

    // 3. Verify main finally block restores env from flags
    const mainFinallyMatch = rehearsalSource.match(/async\s+function\s+main\s*\(\)[\s\S]*?finally\s*\{([\s\S]*?CAPACITY_FIXTURE_CLOSED[\s\S]*?)\}/);
    expect(mainFinallyMatch).not.toBeNull();
    const finallyBlock = mainFinallyMatch![1];
    expect(finallyBlock).toMatch(/Object\.assign\(\s*env\s*,\s*flags\s*\);/);
  });

  it('verifies successful single and batched wallet lookups are counted and profiling is restored', () => {
    expect(rehearsalSource).toMatch(
      /import\s*\{\s*[^}]*\bisDisposableWalletReaderLookup\b[^}]*\}\s*from\s*['"]\.\/juanchoice-capacity-reader-matcher(?:\.js)?['"]/
    );
    expect(rehearsalSource).toContain('countDisposableWalletReaderBatchChecks');
    expect(rehearsalSource).toContain('installPoolQueryProfile');
    expect(rehearsalSource).toMatch(/let\s+walletDurableLookupCount\s*=\s*0;/);
    expect(rehearsalSource).toMatch(/let\s+walletIdentityQueryCount\s*=\s*0;/);
    expect(rehearsalSource).toMatch(/const\s+disposableReaderIds\s*=\s*new\s+Set<string>\(\);/);
    expect(rehearsalSource).toMatch(/for\s*\(\s*const\s+readerId\s+of\s+readerAssembly\.readerUserIds\s*\)\s*\{\s*disposableReaderIds\.add\(readerId\);\s*\}/);
    expect(rehearsalSource).toMatch(/const\s+restorePoolQuery\s*=\s*installPoolQueryProfile\(fixture\.pool,/);
    expect(rehearsalSource).toMatch(/isWalletLookup:\s*\(query, values\)\s*=>\s*isDisposableWalletReaderLookup\(query, values, disposableReaderIds\)\s*\|\|\s*countDisposableWalletReaderBatchChecks\(query, values, disposableReaderIds\)\s*>\s*0/);
    expect(rehearsalSource).toMatch(/onWalletLookup:\s*\(query, values\)\s*=>\s*\{\s*walletDurableLookupCount\s*\+=\s*isDisposableWalletReaderLookup[\s\S]*?countDisposableWalletReaderBatchChecks\(query, values, disposableReaderIds\);\s*walletIdentityQueryCount\+\+;/);

    // Client transaction queries are profiled separately and must not double-count identity lookups.
    const clientQueryMatch = rehearsalSource.match(
      /fixture\.pool\.on\('acquire'[\s\S]*?client\.query\s*=\s*\(\(\.\.\.args:\s*unknown\[\]\)\s*=>[\s\S]*?\}\)\s*as\s*typeof\s*client\.query;/
    );
    expect(clientQueryMatch).not.toBeNull();
    expect(clientQueryMatch![0]).not.toContain('walletDurableLookupCount');
    const mainFinallyMatch = rehearsalSource.match(/async\s+function\s+main\s*\(\)[\s\S]*?finally\s*\{([\s\S]*?CAPACITY_FIXTURE_CLOSED[\s\S]*?)\}/);
    expect(mainFinallyMatch).not.toBeNull();
    const finallyBlock = mainFinallyMatch![1];
    expect(finallyBlock).toMatch(/restorePoolQuery\(\);/);
  });

  it('verifies wallet_durable_lookup_count is included in CAPACITY_RESULT report', () => {
    expect(rehearsalSource).toMatch(/wallet_durable_lookup_count:\s*walletDurableLookupCount,/);
    expect(rehearsalSource).toMatch(/wallet_identity_query_count:\s*walletIdentityQueryCount,/);
  });

  it('reports request-window event-loop delay before post-workload Git bookkeeping', () => {
    const workloadStart = rehearsalSource.indexOf('const startedAt = Date.now();');
    const measurementStop = rehearsalSource.indexOf('eventLoopDelay.disable();', workloadStart);
    const sourceIdentity = rehearsalSource.indexOf('const sourceIdentity = getSourceIdentity();');
    expect(workloadStart).toBeGreaterThan(-1);
    expect(measurementStop).toBeGreaterThan(workloadStart);
    expect(sourceIdentity).toBeGreaterThan(measurementStop);
    expect(rehearsalSource.slice(measurementStop, sourceIdentity)).toMatch(
      /const requestWindowEventLoopDelay = \{\s*p95Ms: Math\.round\(eventLoopDelay\.percentile\(95\) \/ 1e6\),\s*maxMs: Math\.round\(eventLoopDelay\.max \/ 1e6\),\s*\};/
    );
    expect(rehearsalSource).toMatch(/event_loop_delay_p95_ms:\s*requestWindowEventLoopDelay\.p95Ms,/);
    expect(rehearsalSource).toMatch(/event_loop_delay_max_ms:\s*requestWindowEventLoopDelay\.maxMs,/);
  });

  it('verifies strict acceptance assertions for guest and wallet_alpha modes', () => {
    expect(rehearsalSource).toMatch(
      /if\s*\(\s*readerAuthMode\s*===\s*['"]guest['"]\s*\)\s*\{\s*assert\.equal\(\s*walletDurableLookupCount\s*,\s*0\s*,\s*['"]wallet_durable_lookup_count must be 0 in guest reader mode['"]\s*\);\s*assert\.equal\(\s*walletIdentityQueryCount\s*,\s*0/
    );
    expect(rehearsalSource).toMatch(
      /else\s+if\s*\(\s*readerAuthMode\s*===\s*['"]wallet_alpha['"]\s*\)\s*\{\s*assert\(\s*walletDurableLookupCount\s*>=\s*successfulReads\.length/
    );
    expect(rehearsalSource).toMatch(/walletIdentityQueryCount\s*>\s*0\s*&&\s*walletIdentityQueryCount\s*<=\s*walletDurableLookupCount/);
  });

  it('verifies static wiring contract for ballot admission gate: timer starts before admission, GETs bypass, 0 limit bypasses', () => {
    // 1. Verify ballot admission import and export
    expect(rehearsalSource).toMatch(/import\s*\{[^}]*\bBallotAdmissionController\b[^}]*\}\s*from\s*['"]\.\/juanchoice-capacity-ballot-admission(?:\.js)?['"]/);
    expect(rehearsalSource).toMatch(/export\s*\{\s*[^}]*\bresolveBallotAdmission\b/);
    expect(rehearsalSource).toMatch(/export\s+const\s+ballotAdmissionLimit\s*:\s*number\s*=\s*resolveBallotAdmission\(/);

    // 2. Extract http.createServer block
    const serverBlockMatch = rehearsalSource.match(/server\s*=\s*http\.createServer\(\(req,\s*res\)\s*=>\s*\{([\s\S]*?)\}\);\s*\n\s*server\.listen/);
    expect(serverBlockMatch).not.toBeNull();
    const serverBlock = serverBlockMatch![1];

    // 3. Verify ingress timer starts BEFORE any admission queuing
    const ingressPos = serverBlock.indexOf('const ingressAt = performance.now();');
    const admissionCheckPos = serverBlock.indexOf('if (ballotAdmissionLimit > 0 && isBallotRequest(req.method, req.url))');
    expect(ingressPos).toBeGreaterThan(-1);
    expect(admissionCheckPos).toBeGreaterThan(-1);
    expect(ingressPos).toBeLessThan(admissionCheckPos);

    // 4. Verify GET requests bypass the gate directly into phaseContext.run
    expect(serverBlock).toMatch(
      /\} else \{\s*phaseContext\.run\(validatedPhase,\s*\(\)\s*=>\s*\{\s*app\(req,\s*res\);\s*\}\);/
    );

    // 5. Verify abort controller handles premature close and cleanup
    expect(serverBlock).toMatch(/const abortCtrl = new AbortController\(\);/);
    expect(serverBlock).toMatch(/ballotAdmission\.acquire\(abortCtrl\.signal\)/);
    expect(serverBlock).toMatch(/req\.on\('aborted',\s*onPrematureClose\);/);
    expect(serverBlock).not.toMatch(/req\.on\('close',\s*onPrematureClose\);/);
    expect(serverBlock).toMatch(/req\.aborted\s*\|\|\s*res\.destroyed\s*\|\|\s*res\.writableEnded/);
    expect(serverBlock).toMatch(/res\.on\('finish',\s*safeRelease\);/);
    expect(serverBlock).toMatch(/res\.on\('close',\s*safeRelease\);/);

    // 6. Verify bounded queue rejection / fail closed with 503
    expect(serverBlock).toMatch(/res\.statusCode\s*=\s*503;/);

    // 7. Verify report contains ballot admission fields
    expect(rehearsalSource).toMatch(/ballot_admission_limit:\s*ballotAdmissionStats\.limit,/);
    expect(rehearsalSource).toMatch(/ballot_admission_peak_queue:\s*ballotAdmissionStats\.peakQueue,/);
    expect(rehearsalSource).toMatch(/ballot_admission_queue_wait_p50_ms:\s*ballotAdmissionWaitPercentiles\.p50_ms,/);
    expect(rehearsalSource).toMatch(/ballot_admission_queue_wait_p95_ms:\s*ballotAdmissionWaitPercentiles\.p95_ms,/);
  });
});
