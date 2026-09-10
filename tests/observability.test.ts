import request from 'supertest';
import { app } from '../src/app.js';
import { redactSensitiveData } from '../src/middleware/observability.js';

describe('Phase 6: Observability, Tracing, and Redaction', () => {
  describe('Request ID Tracing', () => {
    it('generates a UUID X-Request-Id header when incoming request has none', async () => {
      const res = await request(app).get('/api/v1/health/live');
      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).toBeDefined();
      // Validate UUID v4 structure
      expect(res.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('preserves an existing X-Request-Id provided by upstream reverse proxy or client', async () => {
      const customTraceId = 'trace-client-abc-12345';
      const res = await request(app)
        .get('/api/v1/health/live')
        .set('X-Request-Id', customTraceId);

      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).toBe(customTraceId);
    });

    it('returns /api/v1/ready alias matching /api/v1/health/ready contract', async () => {
      const resReady = await request(app).get('/api/v1/ready');
      const resHealthReady = await request(app).get('/api/v1/health/ready');

      expect(resReady.status).toBe(resHealthReady.status);
      expect(resReady.body.service).toBe('juanderquest-backend');
      expect(resReady.body.dependencies).toBeDefined();
    });
  });

  describe('Sensitive Payload and Credential Redaction', () => {
    it('redacts sensitive auth headers and tokens', () => {
      const sensitiveInput = {
        headers: {
          authorization: 'Bearer secret-jwt-token-123',
          cookie: 'session_id=abcdef',
          'x-qa-auth': 'juanderquest-qa-authorized',
          'content-type': 'application/json',
        },
        body: {
          email: 'traveler@test.com',
          password: 'SuperSecretPassword!',
          token: 'jwt-payload-abc',
        },
      };

      const redacted = redactSensitiveData(sensitiveInput);

      expect(redacted.headers.authorization).toBe('[REDACTED]');
      expect(redacted.headers.cookie).toBe('[REDACTED]');
      expect(redacted.headers['x-qa-auth']).toBe('[REDACTED]');
      expect(redacted.headers['content-type']).toBe('application/json');
      expect(redacted.body.password).toBe('[REDACTED]');
      expect(redacted.body.token).toBe('[REDACTED]');
      expect(redacted.body.email).toBe('traveler@test.com');
    });

    it('redacts precise GPS coordinates from observability payloads', () => {
      const interactionPayload = {
        type: 'visit',
        captured_lat: 16.035412,
        captured_lng: 120.334189,
        spot_id: 'spot-123',
        gps_lat: 16.0355,
        gps_lng: 120.3342,
      };

      const redacted = redactSensitiveData(interactionPayload);

      expect(redacted.type).toBe('visit');
      expect(redacted.spot_id).toBe('spot-123');
      expect(redacted.captured_lat).toBe('[REDACTED]');
      expect(redacted.captured_lng).toBe('[REDACTED]');
      expect(redacted.gps_lat).toBe('[REDACTED]');
      expect(redacted.gps_lng).toBe('[REDACTED]');
    });
  });
});
