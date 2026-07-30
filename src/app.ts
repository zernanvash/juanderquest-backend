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
import { errorHandler } from './middleware/error.js';

export const app = express();

app.use(cors({ origin: env.CORS_ORIGIN }));
app.use(express.json());

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

// Global Error Handler
app.use(errorHandler);
