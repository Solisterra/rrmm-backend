import "dotenv/config";
import {
  processExpiredAuctions,
  processStaleMarketplaceListings,
} from "./auction-engine";

const closed = await processExpiredAuctions();
console.log(`[cron] Closed ${closed.length} expired auction(s)`);
if (closed.length) console.log(closed);

const swept = await processStaleMarketplaceListings();
const archivedCount = swept.filter((r) => r.archived).length;
console.log(
  `[cron] Archived ${archivedCount} stale marketplace listing(s) (${swept.length} swept)`,
);
if (swept.length) console.log(swept);
