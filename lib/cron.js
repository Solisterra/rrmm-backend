// Manual cron trigger — node lib/cron.js
import 'dotenv/config';
import { processExpiredAuctions } from './auction-engine.js';

const results = await processExpiredAuctions();
console.log(`[cron] Closed ${results.length} expired auction(s)`);
if (results.length) console.log(results);
