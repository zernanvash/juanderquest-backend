import { app } from './app.js';
import { env } from './config/env.js';
import { bootstrap } from './bootstrap.js';
import { closePool } from './db/pool.js';
import { beginServiceShutdown, setServiceReady } from './middleware/readiness.js';
import { stopStandingsJob } from './social/standingsJob.js';
import { stopPushDispatcher } from './push/dispatcher.js';
import { stopWeeklyRecapJob } from './social/weeklyRecapJob.js';
import { stopWeeklyTrailTrendJob } from './trails/jobs/weeklyTrends.js';

const startedAt = Date.now();

// Listen immediately so a restart never becomes Cloudflare 502 HTML: until
// hydration and migrations finish, every API route except health answers
// 503 MAINTENANCE with Retry-After.
setServiceReady(false);
const server = app.listen(env.PORT, env.HOST, () => {
  console.log(`🚀 JuanderQuest REST API backend listening on http://${env.HOST}:${env.PORT} (starting up)`);
  console.log(`📡 Environment: ${env.NODE_ENV}`);
});

bootstrap()
  .then(() => {
    setServiceReady(true);
    console.log(`[boot] ready in ${Date.now() - startedAt} ms`);
  })
  .catch((error) => {
    console.error('[bootstrap] FATAL', error);
    process.exit(1);
  });

let draining = false;

// Graceful shutdown: stop accepting connections, flip readiness so keep-alive
// requests receive 503 MAINTENANCE, drain in-flight work for up to 10 s, then
// end the PostgreSQL pool and exit cleanly. pm2 kill_timeout is 12 s.
function shutdown(signal: NodeJS.Signals): void {
  if (draining) return;
  draining = true;
  stopStandingsJob();
  stopPushDispatcher();
  stopWeeklyRecapJob();
  stopWeeklyTrailTrendJob();
  beginServiceShutdown();
  console.log(`[shutdown] ${signal} received — draining in-flight requests (10 s cap)`);

  const hardExit = setTimeout(() => {
    console.error('[shutdown] drain timeout exceeded — forcing exit');
    process.exit(0);
  }, 10_000);
  hardExit.unref();

  server.close(() => {
    void closePool()
      .catch((error) => console.error('[shutdown] pool close failed', error))
      .finally(() => {
        clearTimeout(hardExit);
        console.log('[shutdown] complete');
        process.exit(0);
      });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
