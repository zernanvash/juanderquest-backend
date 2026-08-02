import { app } from './app.js';
import { env } from './config/env.js';
import { bootstrap } from './bootstrap.js';

bootstrap()
  .then(() => {
    app.listen(env.PORT, () => {
      console.log(`🚀 JuanderQuest REST API backend running on http://localhost:${env.PORT}`);
      console.log(`📡 Environment: ${env.NODE_ENV}`);
    });
  })
  .catch((error) => {
    console.error('[bootstrap] FATAL', error);
    process.exit(1);
  });
