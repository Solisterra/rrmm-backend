import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../../lib/api";
import { processExpiredAuctions } from "../../../lib/auction-engine";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).end();
  const results = await processExpiredAuctions();
  return res.status(200).json({ processed: results.length, results });
}

export default withErrorHandling(handler);
