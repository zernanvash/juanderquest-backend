import assert from 'node:assert/strict';

export type BallotMode = 'batch' | 'sequential';
export type ClientMode = 'inprocess' | 'child_process';
export type ReaderAuthMode = 'guest' | 'wallet_alpha';

export function resolveBallotMode(envValue?: string): BallotMode {
  const mode = envValue ?? 'sequential';
  assert(
    mode === 'batch' || mode === 'sequential',
    'JDQ_CAPACITY_BALLOT_MODE must be "batch" or "sequential"'
  );
  return mode;
}

export function resolveClientMode(envValue?: string): ClientMode {
  const mode = envValue ?? 'inprocess';
  assert(
    mode === 'inprocess' || mode === 'child_process',
    'JDQ_CAPACITY_CLIENT_MODE must be "inprocess" or "child_process"'
  );
  return mode;
}

export function resolveReaderAuthMode(envValue?: string): ReaderAuthMode {
  const mode = envValue ?? 'guest';
  assert(
    mode === 'guest' || mode === 'wallet_alpha',
    'JDQ_CAPACITY_READER_AUTH must be "guest" or "wallet_alpha"'
  );
  return mode;
}
