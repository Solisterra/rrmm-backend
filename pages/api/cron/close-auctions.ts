import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import {
  processExpiredAuctions,
  processStaleMarketplaceListings,
} from "../../../lib/auction-engine";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).end();
  // Two independent, idempotent sweeps per run: close expired auctions, then
  // archive stale marketplace listings (B3). Neither depends on the other.
  const closed = await processExpiredAuctions();
  const swept = await processStaleMarketplaceListings();
  return res.status(200).json({
    processed: closed.length,
    results: closed,
    archived: swept.filter((r) => r.archived).length,
    archiveResults: swept,
  });
}

export default withErrorHandling(handler);
