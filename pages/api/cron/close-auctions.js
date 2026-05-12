import { withErrorHandling } from "../../../lib/api.js";
import { processExpiredAuctions } from "../../../lib/auction-engine.js";
async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).end();
  const results = await processExpiredAuctions();
  return res.status(200).json({ processed: results.length, results });
}

export default withErrorHandling(handler);
