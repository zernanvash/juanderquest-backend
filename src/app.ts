import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import questsRouter from './routes/quests.js';
import submissionsRouter from './routes/submissions.js';
import adminRouter from './routes/admin.js';
import { proposalsRouter } from './routes/proposals.js';
import governanceAdminRouter from './routes/governanceAdmin.js';
import communityQuestsRouter from './routes/communityQuests.js';
import walletRouter from './routes/wallet.js';
import vouchersRouter from './routes/vouchers.js';
import campaignsRouter from './routes/campaigns.js';
import spotsRouter from './routes/spots.js';
import { feedRouter } from './routes/feed.js';
import { searchRouter } from './routes/search.js';
import { usersRouter } from './routes/users.js';
import appVersionRouter from './routes/appVersion.js';
import routesRouter from './routes/routes.js';
import analyticsRouter from './routes/analytics.js';
import { progressionRouter } from './routes/progression.js';
import { juanChoiceRouter } from './routes/juanchoice.js';
import { affiliatesRouter } from './routes/affiliates.js';
import { merchantsRouter } from './routes/merchants.js';
import { trailRouter } from './routes/trail.js';
import { trailsRouter } from './routes/trails.js';
import { leaderboardRouter } from './routes/leaderboard.js';
import { economyAdminRouter } from './routes/economyAdmin.js';
import { economyReadsRouter } from './routes/economyReads.js';
import quizzesRouter from './routes/quizzes.js';
import adminQuizzesRouter from './routes/adminQuizzes.js';
import adminMerchantsRouter from './routes/adminMerchants.js';
import adminSettingsRouter from './routes/adminSettings.js';
import developerRouter from './routes/developer.js';
import { merchantPointsRouter } from './routes/merchantPoints.js';
import { fundingPlansRouter } from './routes/fundingPlans.js';
import { sponsorshipsRouter } from './routes/sponsorships.js';
import { notificationsRouter } from './routes/notifications.js';
import { plazaRouter } from './routes/plaza.js';
import { areasRouter } from './routes/areas.js';
import { chainAdminRouter } from './routes/chainAdmin.js';
import { chainBadgesRouter } from './routes/chainBadges.js';
import { shopRouter } from './routes/shop.js';
import { adminShopRouter } from './routes/adminShop.js';
import { stampsRouter } from './routes/stamps.js';
import { errorHandler } from './middleware/error.js';
import { readinessGate } from './middleware/readiness.js';
import { appVersionGate } from './middleware/appVersionGate.js';
import { publicReadCache } from './middleware/publicReadCache.js';

import path from 'path';
import { requestTracingMiddleware } from './middleware/observability.js';
import { validateAndParseCorsOrigin } from './config/cors.js';

export const app = express();

// Trust loopback proxies (Nginx on 127.0.0.1) while rejecting arbitrary client spoofing
app.set('trust proxy', 'loopback');

// Structured logging & Request ID tracing
app.use(requestTracingMiddleware);

export const parseCorsOrigin = (value: string): string | string[] => {
  const parsed = validateAndParseCorsOrigin(value, env.NODE_ENV, env.JUANCHOICE_PRESENTATION_MODE);
  return parsed.isWildcard ? '*' : parsed.origins;
};

const corsConfig = validateAndParseCorsOrigin(env.CORS_ORIGIN, env.NODE_ENV, env.JUANCHOICE_PRESENTATION_MODE);
app.use(cors({ origin: corsConfig.isWildcard ? true : corsConfig.origins, credentials: true }));
app.use(express.json());

// Cookie-authenticated mutations must originate from an approved web origin.
// Bearer clients (including Flutter) are unaffected; SameSite is defense in depth.
app.use('/api/v1', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.headers.authorization || !req.headers.cookie) return next();
  const origin = req.headers.origin;
  const allowed = env.CORS_ORIGIN === '*'
    ? env.NODE_ENV !== 'production' && (origin === 'http://localhost:3000' || origin === 'http://127.0.0.1:3000')
    : Array.isArray(parseCorsOrigin(env.CORS_ORIGIN)) && (parseCorsOrigin(env.CORS_ORIGIN) as string[]).includes(origin || '');
  if (!allowed) return res.status(403).json({ success: false, error: { code: 'INVALID_ORIGIN', message: 'Cookie-authenticated request origin is not allowed.' } });
  next();
});

// Serve local upload files
const uploadDir = path.resolve(process.cwd(), env.LOCAL_UPLOAD_DIR || 'uploads/spot-photos');
app.use('/api/v1/uploads/spot-photos', express.static(uploadDir));

// Serve local downloads folder if present
const downloadsDir = path.resolve(process.cwd(), 'downloads');
app.use('/downloads', express.static(downloadsDir));

// Routes
// Boot/readiness gate: while hydrating or draining, every API route except
// health returns a JSON 503 MAINTENANCE with Retry-After.
app.use('/api/v1', readinessGate);
// Android build gate: reads always pass; mutations below the manifest's
// supported build return 426 UPGRADE_REQUIRED.
app.use('/api/v1', appVersionGate);
// Anonymous public reads get ETag + public cache headers (C6).
app.use('/api/v1', publicReadCache);
app.use('/api/v1', healthRouter);
app.use('/api/v1', authRouter);
app.use('/api/v1', questsRouter);
app.use('/api/v1', submissionsRouter);
// Internal economy profile gate must run before the broad /admin middleware.
app.use('/api/v1', economyReadsRouter);
app.use('/api/v1', adminRouter);
app.use('/api/v1/proposals', proposalsRouter);
app.use('/api/v1', governanceAdminRouter);
app.use('/api/v1', communityQuestsRouter);
app.use('/api/v1', walletRouter);
app.use('/api/v1', vouchersRouter);
app.use('/api/v1', campaignsRouter);
app.use('/api/v1', spotsRouter);
app.use('/api/v1', feedRouter);
app.use('/api/v1', searchRouter);
app.use('/api/v1', usersRouter);
app.use('/api/v1', appVersionRouter);
app.use('/api/v1', routesRouter);
app.use('/api/v1', analyticsRouter);
app.use('/api/v1', progressionRouter);
app.use('/api/v1', juanChoiceRouter);
app.use('/api/v1', affiliatesRouter);
app.use('/api/v1', merchantsRouter);
app.use('/api/v1', trailRouter);
app.use('/api/v1', trailsRouter);
app.use('/api/v1', leaderboardRouter);
app.use('/api/v1', economyAdminRouter);
app.use('/api/v1', quizzesRouter);
app.use('/api/v1', adminQuizzesRouter);
app.use('/api/v1', adminMerchantsRouter);
app.use('/api/v1', adminSettingsRouter);
app.use('/api/v1', developerRouter);
app.use('/api/v1', merchantPointsRouter);
app.use('/api/v1', fundingPlansRouter);
app.use('/api/v1', sponsorshipsRouter);
app.use('/api/v1', notificationsRouter);
app.use('/api/v1', plazaRouter);
app.use('/api/v1', areasRouter);
app.use('/api/v1', chainBadgesRouter);
app.use('/api/v1', shopRouter);
app.use('/api/v1', adminShopRouter);
app.use('/api/v1', stampsRouter);
app.use('/api/v1/admin/chain', chainAdminRouter);

// JSON parse errors -> 400 instead of 500
app.use((err: Error & { type?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_JSON', message: 'Malformed JSON in request body.' },
    });
  }
  next(err);
});

// API 404 in JSON
app.use('/api/v1', (req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found.` },
  });
});

// Global Error Handler
app.use(errorHandler);
