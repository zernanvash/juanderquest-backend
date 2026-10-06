import { validateAndParseCorsOrigin } from '../src/config/cors';

describe('production origin configuration', () => {
  const withProductionEnv = (corsOrigin: string, host: string | undefined, assertion: () => void) => {
    const prior = {
      NODE_ENV: process.env.NODE_ENV,
      CORS_ORIGIN: process.env.CORS_ORIGIN,
      HOST: process.env.HOST,
      JWT_SECRET: process.env.JWT_SECRET,
      WALLET_AUTH_MODE: process.env.WALLET_AUTH_MODE,
      ALLOW_IN_MEMORY_FALLBACK: process.env.ALLOW_IN_MEMORY_FALLBACK,
      SEED_DEVELOPMENT_DATA: process.env.SEED_DEVELOPMENT_DATA,
    };
    try {
      process.env.NODE_ENV = 'production';
      process.env.CORS_ORIGIN = corsOrigin;
      process.env.JWT_SECRET = 'isolated_test_secret_not_for_deployment';
      process.env.WALLET_AUTH_MODE = 'signature';
      process.env.ALLOW_IN_MEMORY_FALLBACK = 'false';
      process.env.SEED_DEVELOPMENT_DATA = 'false';
      if (host === undefined) delete process.env.HOST;
      else process.env.HOST = host;
      jest.isolateModules(assertion);
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  it('rejects a wildcard when the production environment module initializes', () => {
    withProductionEnv('*', undefined, () => {
      expect(() => require('../src/config/env')).toThrow(/wildcard/i);
    });
  });

  it('defaults production binding to loopback while preserving an explicit reviewed host', () => {
    withProductionEnv('https://juanderquest.app', undefined, () => {
      expect(require('../src/config/env').env.HOST).toBe('127.0.0.1');
    });
    withProductionEnv('https://juanderquest.app', '10.0.0.4', () => {
      expect(require('../src/config/env').env.HOST).toBe('10.0.0.4');
    });
  });

  it('accepts the explicit public alpha HTTPS allowlist', () => {
    expect(validateAndParseCorsOrigin(
      'https://juanderquest.app,https://www.juanderquest.app,https://admin.juanderquest.app',
      'production'
    ).origins).toEqual([
      'https://juanderquest.app',
      'https://www.juanderquest.app',
      'https://admin.juanderquest.app',
    ]);
  });

  it.each([
    undefined,
    '',
    '  ',
    '*',
    'https://juanderquest.app,*',
    'http://juanderquest.app',
    'https://juanderquest.app,',
    ',https://juanderquest.app',
    'https://juanderquest.app,,https://www.juanderquest.app',
    'https://juanderquest.app/path',
    'https://juanderquest.app/',
    'https://juanderquest.app:443',
    'https://juanderquest.app?next=/choice',
    'https://juanderquest.app#choice',
    'https://user:secret@juanderquest.app',
    'https://juanderquest.app,https://juanderquest.app',
  ])('rejects unsafe production origin %s', (value) => {
    expect(() => validateAndParseCorsOrigin(value, 'production')).toThrow();
  });

  it('retains local development wildcard support', () => {
    expect(validateAndParseCorsOrigin('*', 'development').isWildcard).toBe(true);
    expect(validateAndParseCorsOrigin(undefined, 'test').isWildcard).toBe(true);
    expect(validateAndParseCorsOrigin('http://localhost:3000', 'development').origins)
      .toEqual(['http://localhost:3000']);
  });

  it('permits only the isolated presentation HTTP loopback origin when explicitly gated', () => {
    expect(validateAndParseCorsOrigin('http://127.0.0.1:3200', 'production', true).origins)
      .toEqual(['http://127.0.0.1:3200']);
    expect(() => validateAndParseCorsOrigin('http://127.0.0.1:3200', 'production')).toThrow(/HTTPS/);
    expect(() => validateAndParseCorsOrigin('http://localhost:3200', 'production', true)).toThrow(/HTTPS/);
    expect(() => validateAndParseCorsOrigin('http://127.0.0.1:3000', 'production', true)).toThrow(/HTTPS/);
  });

  it('permits exact public presentation HTTPS origin when explicitly gated', () => {
    expect(validateAndParseCorsOrigin('https://presentation.juanderquest.app', 'production', true).origins)
      .toEqual(['https://presentation.juanderquest.app']);
    expect(() => validateAndParseCorsOrigin('https://evil.com', 'production', true))
      .toThrow(/Presentation mode only permits/);
  });
});
