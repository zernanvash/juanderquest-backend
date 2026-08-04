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
import spotsRouter from './routes/spots.js';
import { errorHandler } from './middleware/error.js';

import path from 'path';

export const app = express();

export const parseCorsOrigin = (value: string) =>
  value === '*' ? value : value.split(',').map((origin) => origin.trim()).filter(Boolean);

app.use(cors({ origin: parseCorsOrigin(env.CORS_ORIGIN) }));
app.use(express.json());

// Serve local upload files
const uploadDir = path.resolve(process.cwd(), env.LOCAL_UPLOAD_DIR || 'uploads/spot-photos');
app.use('/api/v1/uploads/spot-photos', express.static(uploadDir));

// Routes
app.use('/api/v1', healthRouter);
app.use('/api/v1', authRouter);
app.use('/api/v1', questsRouter);
app.use('/api/v1', submissionsRouter);
app.use('/api/v1', adminRouter);
app.use('/api/v1/proposals', proposalsRouter);
app.use('/api/v1', governanceAdminRouter);
app.use('/api/v1', communityQuestsRouter);
app.use('/api/v1', walletRouter);
app.use('/api/v1', vouchersRouter);
app.use('/api/v1', spotsRouter);

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
