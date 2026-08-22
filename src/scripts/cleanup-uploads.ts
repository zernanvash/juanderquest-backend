import { assetStore } from '../spots/asset-store.js';

export async function runCleanupScript(expirationHours = 24) {
  console.log(`[cleanup-uploads] Running abandoned spot photos cleanup (expiration: ${expirationHours}h)...`);
  const cleanedCount = await assetStore.cleanupAbandonedSpotPhotos(expirationHours);
  console.log(`[cleanup-uploads] Cleanup complete. Removed ${cleanedCount} abandoned pending upload(s).`);
  return cleanedCount;
}

if (process.argv[1] && (process.argv[1].endsWith('cleanup-uploads.ts') || process.argv[1].endsWith('cleanup-uploads.js'))) {
  runCleanupScript()
    .then((count) => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('[cleanup-uploads] Cleanup error:', err);
      process.exit(1);
    });
}
