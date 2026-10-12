import { isLocalEconomyProfile } from '../src/economy/profile.js';

describe('local economy profile boundary', () => {
  const original = {
    node: process.env.NODE_ENV,
    jdq: process.env.JDQ_ENV,
    database: process.env.DATABASE_URL,
  };
  afterAll(() => {
    if (original.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original.node;
    if (original.jdq === undefined) delete process.env.JDQ_ENV; else process.env.JDQ_ENV = original.jdq;
    if (original.database === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = original.database;
  });

  it('refuses production even if JDQ_ENV is accidentally dev', () => {
    process.env.NODE_ENV = 'production'; process.env.JDQ_ENV = 'dev';
    process.env.DATABASE_URL = 'postgresql://127.0.0.1:55432/jdq_economy_lab_123456789abc_dev';
    expect(isLocalEconomyProfile()).toBe(false);
  });

  it('refuses an unmarked database and a non-loopback database in development', () => {
    process.env.NODE_ENV = 'development'; process.env.JDQ_ENV = 'dev';
    process.env.DATABASE_URL = 'postgresql://127.0.0.1:55432/juanderquest_alpha';
    expect(isLocalEconomyProfile()).toBe(false);
    process.env.DATABASE_URL = 'postgresql://example.invalid:55432/jdq_economy_lab_123456789abc_dev';
    expect(isLocalEconomyProfile()).toBe(false);
  });

  it('permits only an exact local marked fixture in development', () => {
    process.env.NODE_ENV = 'development'; process.env.JDQ_ENV = 'dev';
    process.env.DATABASE_URL = 'postgresql://127.0.0.1:55432/jdq_economy_lab_123456789abc_dev';
    expect(isLocalEconomyProfile()).toBe(true);
  });
});
