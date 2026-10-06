import type { Response } from 'express';
import { env, validatePresentationModeConfig } from '../src/config/env.js';
import {
  sessionCookieName,
  setSessionCookie,
  readSessionCookie,
} from '../src/auth/sessionCookie.js';
import { validateAndParseCorsOrigin } from '../src/config/cors.js';

describe('JuanChoice presentation security & profile contracts', () => {
  const originalEnv = {
    NODE_ENV: env.NODE_ENV,
    HOST: env.HOST,
    PORT: env.PORT,
    CORS_ORIGIN: env.CORS_ORIGIN,
    JUANCHOICE_PRESENTATION_MODE: env.JUANCHOICE_PRESENTATION_MODE,
    JDQ_PRESENTATION_PROFILE: env.JDQ_PRESENTATION_PROFILE,
    JUANCHOICE_PRESENTATION_CAMPAIGN_ID: env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID,
    JUANCHOICE_PRESENTATION_DB_NAME: env.JUANCHOICE_PRESENTATION_DB_NAME,
    DATABASE_URL: env.DATABASE_URL,
    WALLET_AUTH_MODE: env.WALLET_AUTH_MODE,
    ALLOW_IN_MEMORY_FALLBACK: env.ALLOW_IN_MEMORY_FALLBACK,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      Reflect.set(env, key, value);
    }
  });

  describe('Presentation Cookie Namespace and Profile-Aware Secure Flag', () => {
    it('sets non-secure jdq_presentation_session in local HTTP presentation profile', () => {
      Reflect.set(env, 'NODE_ENV', 'production');
      Reflect.set(env, 'JUANCHOICE_PRESENTATION_MODE', true);
      Reflect.set(env, 'JDQ_PRESENTATION_PROFILE', 'local');
      Reflect.set(env, 'CORS_ORIGIN', 'http://127.0.0.1:3200');

      expect(sessionCookieName()).toBe('jdq_presentation_session');

      let cookiePayload: any = null;
      const mockRes: any = {
        cookie: (name: string, val: string, options: any) => {
          cookiePayload = { name, val, options };
          return mockRes;
        },
        setHeader: jest.fn(),
      };

      setSessionCookie(mockRes as Response, 'token-local-demo', false);
      expect(cookiePayload).not.toBeNull();
      expect(cookiePayload.name).toBe('jdq_presentation_session');
      expect(cookiePayload.options.httpOnly).toBe(true);
      expect(cookiePayload.options.secure).toBe(false);
      expect(cookiePayload.options.sameSite).toBe('lax');
      expect(cookiePayload.options.path).toBe('/');
    });

    it('sets host-only Secure jdq_presentation_session in public HTTPS presentation profile', () => {
      Reflect.set(env, 'NODE_ENV', 'production');
      Reflect.set(env, 'JUANCHOICE_PRESENTATION_MODE', true);
      Reflect.set(env, 'JDQ_PRESENTATION_PROFILE', 'public');
      Reflect.set(env, 'CORS_ORIGIN', 'https://presentation.juanderquest.app');

      expect(sessionCookieName()).toBe('jdq_presentation_session');

      let cookiePayload: any = null;
      const mockRes: any = {
        cookie: (name: string, val: string, options: any) => {
          cookiePayload = { name, val, options };
          return mockRes;
        },
        setHeader: jest.fn(),
      };

      setSessionCookie(mockRes as Response, 'token-public-demo', true);
      expect(cookiePayload).not.toBeNull();
      expect(cookiePayload.name).toBe('jdq_presentation_session');
      expect(cookiePayload.options.httpOnly).toBe(true);
      expect(cookiePayload.options.secure).toBe(true);
      expect(cookiePayload.options.sameSite).toBe('lax');
      expect(cookiePayload.options.path).toBe('/');
      expect(cookiePayload.options.maxAge).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('sets __Host-jdq_session in ordinary alpha production mode and isolates from demo cookie', () => {
      Reflect.set(env, 'NODE_ENV', 'production');
      Reflect.set(env, 'JUANCHOICE_PRESENTATION_MODE', false);
      Reflect.set(env, 'CORS_ORIGIN', 'https://juanderquest.app');

      expect(sessionCookieName()).toBe('__Host-jdq_session');

      // Presentation cookie sent to alpha request is not read
      const mockReq: any = {
        headers: {
          cookie: 'jdq_presentation_session=demo-guest-jwt-token',
        },
      };
      expect(readSessionCookie(mockReq)).toBeNull();
    });
  });

  describe('CORS and Origin Guarding in Presentation Mode', () => {
    it('accepts exact HTTPS presentation origin and rejects other origins in public presentation mode', () => {
      const allowed = validateAndParseCorsOrigin('https://presentation.juanderquest.app', 'production', true);
      expect(allowed.origins).toEqual(['https://presentation.juanderquest.app']);

      expect(() => validateAndParseCorsOrigin('https://juanderquest.app', 'production', true))
        .toThrow(/Presentation mode only permits/);
      expect(() => validateAndParseCorsOrigin('https://evil.com', 'production', true))
        .toThrow(/Presentation mode only permits/);
      expect(() => validateAndParseCorsOrigin('*', 'production', true))
        .toThrow(/Production cannot use wildcard/);
    });

    it('accepts exact HTTP loopback origin in local presentation mode', () => {
      const allowed = validateAndParseCorsOrigin('http://127.0.0.1:3200', 'production', true);
      expect(allowed.origins).toEqual(['http://127.0.0.1:3200']);
    });
  });

  describe('Presentation Environment Validation & Profile Guardrails', () => {
    const validBaseConfig = {
      ...env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: 4200,
      JUANCHOICE_PRESENTATION_MODE: true,
      JUANCHOICE_PRESENTATION_CAMPAIGN_ID: 'e73f5869-797c-4e28-8bab-2c0b2d38eb20',
      JUANCHOICE_PRESENTATION_DB_NAME: 'juanderquest_presentation',
      DATABASE_URL: 'postgresql://jdq_presentation:pwd@127.0.0.1:55434/juanderquest_presentation',
      WALLET_AUTH_MODE: 'signature',
      ALLOW_IN_MEMORY_FALLBACK: false,
    };

    it('validates clean local profile config', () => {
      const localConfig = {
        ...validBaseConfig,
        JDQ_PRESENTATION_PROFILE: 'local',
        CORS_ORIGIN: 'http://127.0.0.1:3200',
      };
      expect(() => validatePresentationModeConfig(localConfig as any)).not.toThrow();
    });

    it('validates clean public profile config with loopback API bind', () => {
      const publicConfig = {
        ...validBaseConfig,
        JDQ_PRESENTATION_PROFILE: 'public',
        CORS_ORIGIN: 'https://presentation.juanderquest.app',
      };
      expect(() => validatePresentationModeConfig(publicConfig as any)).not.toThrow();
    });

    it('rejects public profile with loopback CORS_ORIGIN', () => {
      const mismatchedConfig = {
        ...validBaseConfig,
        JDQ_PRESENTATION_PROFILE: 'public',
        CORS_ORIGIN: 'http://127.0.0.1:3200',
      };
      expect(() => validatePresentationModeConfig(mismatchedConfig as any)).toThrow(
        /requires dedicated loopback API port 4200 and web origin https:\/\/presentation\.juanderquest\.app/
      );
    });

    it('rejects local profile with public HTTPS CORS_ORIGIN', () => {
      const mismatchedConfig = {
        ...validBaseConfig,
        JDQ_PRESENTATION_PROFILE: 'local',
        CORS_ORIGIN: 'https://presentation.juanderquest.app',
      };
      expect(() => validatePresentationModeConfig(mismatchedConfig as any)).toThrow(
        /requires dedicated loopback API port 4200 and web origin http:\/\/127\.0\.0\.1:3200/
      );
    });

    it('rejects public profile with ordinary alpha origin', () => {
      const alphaOriginConfig = {
        ...validBaseConfig,
        JDQ_PRESENTATION_PROFILE: 'public',
        CORS_ORIGIN: 'https://juanderquest.app',
      };
      expect(() => validatePresentationModeConfig(alphaOriginConfig as any)).toThrow(
        /requires dedicated loopback API port 4200 and web origin https:\/\/presentation\.juanderquest\.app/
      );
    });

    it('rejects invalid profile name', () => {
      const invalidProfileConfig = {
        ...validBaseConfig,
        JDQ_PRESENTATION_PROFILE: 'stage',
        CORS_ORIGIN: 'http://127.0.0.1:3200',
      };
      expect(() => validatePresentationModeConfig(invalidProfileConfig as any)).toThrow(
        /JDQ_PRESENTATION_PROFILE must be "local" or "public"/
      );
    });

    it('rejects public profile exposing API to 0.0.0.0', () => {
      const exposedApiConfig = {
        ...validBaseConfig,
        HOST: '0.0.0.0',
        JDQ_PRESENTATION_PROFILE: 'public',
        CORS_ORIGIN: 'https://presentation.juanderquest.app',
      };
      expect(() => validatePresentationModeConfig(exposedApiConfig as any)).toThrow(
        /requires dedicated loopback API port 4200/
      );
    });

    it('rejects public profile with test database override outside test harness scope', () => {
      const origFlag = process.env.JDQ_ALLOW_PRESENTATION_TEST_DB;
      const origScope = process.env.JDQ_TEST_HARNESS_SCOPE;
      try {
        process.env.JDQ_ALLOW_PRESENTATION_TEST_DB = 'true';
        delete process.env.JDQ_TEST_HARNESS_SCOPE;

        const testDbConfig = {
          ...validBaseConfig,
          JDQ_PRESENTATION_PROFILE: 'public',
          CORS_ORIGIN: 'https://presentation.juanderquest.app',
          JUANCHOICE_PRESENTATION_DB_NAME: 'juanderquest_presentation_test',
          DATABASE_URL: 'postgresql://jdq_presentation:pwd@127.0.0.1:55434/juanderquest_presentation_test',
        };

        expect(() => validatePresentationModeConfig(testDbConfig as any)).toThrow(
          /JDQ_ALLOW_PRESENTATION_TEST_DB is forbidden in public presentation profile outside isolated script drill harness/
        );
      } finally {
        if (origFlag !== undefined) process.env.JDQ_ALLOW_PRESENTATION_TEST_DB = origFlag;
        else delete process.env.JDQ_ALLOW_PRESENTATION_TEST_DB;
        if (origScope !== undefined) process.env.JDQ_TEST_HARNESS_SCOPE = origScope;
        else delete process.env.JDQ_TEST_HARNESS_SCOPE;
      }
    });

    it('permits test database override in public profile when explicitly scoped to isolated_script_drill', () => {
      const origFlag = process.env.JDQ_ALLOW_PRESENTATION_TEST_DB;
      const origScope = process.env.JDQ_TEST_HARNESS_SCOPE;
      try {
        process.env.JDQ_ALLOW_PRESENTATION_TEST_DB = 'true';
        process.env.JDQ_TEST_HARNESS_SCOPE = 'isolated_script_drill';

        const testDbConfig = {
          ...validBaseConfig,
          JDQ_PRESENTATION_PROFILE: 'public',
          CORS_ORIGIN: 'https://presentation.juanderquest.app',
          JUANCHOICE_PRESENTATION_DB_NAME: 'juanderquest_presentation_test',
          DATABASE_URL: 'postgresql://jdq_presentation:pwd@127.0.0.1:55434/juanderquest_presentation_test',
        };

        expect(() => validatePresentationModeConfig(testDbConfig as any)).not.toThrow();
      } finally {
        if (origFlag !== undefined) process.env.JDQ_ALLOW_PRESENTATION_TEST_DB = origFlag;
        else delete process.env.JDQ_ALLOW_PRESENTATION_TEST_DB;
        if (origScope !== undefined) process.env.JDQ_TEST_HARNESS_SCOPE = origScope;
        else delete process.env.JDQ_TEST_HARNESS_SCOPE;
      }
    });
  });
});
