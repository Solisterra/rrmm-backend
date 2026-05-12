import { withErrorHandling } from "../../lib/api.js";

function handler(req, res) {
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });
  res.status(200).json({
    service: "Rocket Ranch Media Marketplace API",
    version: "1.0.0",
    status: "ok",
  });
}

export default withErrorHandling(handler);
