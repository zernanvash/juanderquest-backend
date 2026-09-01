export type RuntimeEnvironment = 'development' | 'test' | 'production';

export interface DatabaseRuntimePolicy {
  nodeEnv: RuntimeEnvironment;
  allowInMemoryFallback: boolean;
  seedDevelopmentData: boolean;
}

/**
 * PostgreSQL is mandatory in production. Memory mode is only an explicit
 * development/test fixture and can never be enabled for a production process.
 */
export function isInMemoryFallbackAllowed(policy: DatabaseRuntimePolicy): boolean {
  return policy.nodeEnv !== 'production' && policy.allowInMemoryFallback;
}

/** Development fixtures must never enter a production database or process. */
export function isDevelopmentSeedEnabled(policy: DatabaseRuntimePolicy): boolean {
  return policy.nodeEnv !== 'production' && policy.seedDevelopmentData;
}
