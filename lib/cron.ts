import "dotenv/config";
import { processExpiredAuctions } from "./auction-engine";

const results = await processExpiredAuctions();
console.log(`[cron] Closed ${results.length} expired auction(s)`);
if (results.length) console.log(results);
