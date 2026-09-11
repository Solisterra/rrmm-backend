import type { NextApiRequest, NextApiResponse } from "next";
import { withErrorHandling } from "../../lib/api";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  return res.status(200).json({ items: [] });
}

export default withErrorHandling(handler);
