import { localRuntimeSafetyError } from '../src/config/env.js';

describe('local runtime safety', () => {
  const live = 'postgres://jdq_alpha:x@127.0.0.1:55433/juanderquest_alpha';
  const dev = 'postgres://postgres:x@localhost:5432/juanderquest_dev';

  it('lets production use the live database', () => {
    expect(localRuntimeSafetyError('production', undefined, live)).toBeNull();
  });

  it('refuses the live database from development and tests, with or without a profile', () => {
    expect(localRuntimeSafetyError('development', 'dev', live)).toMatch(/live alpha database/);
    expect(localRuntimeSafetyError('development', undefined, live)).toMatch(/live alpha database/);
    expect(localRuntimeSafetyError('test', undefined, live)).toMatch(/live alpha database/);
    expect(localRuntimeSafetyError('development', 'dev', 'postgres://u:x@127.0.0.1:55433/other_dev')).toMatch(/live alpha/);
  });

  it('requires a profile for development runs', () => {
    expect(localRuntimeSafetyError('development', undefined, dev)).toMatch(/requires JDQ_ENV/);
    expect(localRuntimeSafetyError('development', 'dev', dev)).toBeNull();
    expect(localRuntimeSafetyError('test', undefined, dev)).toBeNull();
  });
});
