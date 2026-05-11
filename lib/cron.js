// Manual cron trigger — node lib/cron.js
require('dotenv').config({ path: '.env.local' });

(async () => {
  const { processExpiredAuctions } = await import('./auction-engine.js');
  const results = await processExpiredAuctions();
  console.log(`[cron] Closed ${results.length} expired auction(s)`);
  if (results.length) console.log(results);
  process.exit(0);
})().catch(err => {
  console.error('[cron] Error:', err.message);
  process.exit(1);
});
