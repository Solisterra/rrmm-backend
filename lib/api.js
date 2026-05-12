const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
]);

function isNetworkError(err) {
  if (err.message === "fetch failed") return true;
  if (err.cause && NETWORK_ERROR_CODES.has(err.cause?.code)) return true;
  return false;
}

function isConfigError(err) {
  return err.message?.startsWith("Missing required environment variable");
}

// Wraps a Next.js API handler so unhandled exceptions return JSON instead of HTML
export function withErrorHandling(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[${req.method}] ${req.url}`, err);

      if (isNetworkError(err)) {
        return res
          .status(503)
          .json({ error: "Service temporarily unavailable. Please try again shortly." });
      }

      if (isConfigError(err)) {
        return res.status(500).json({ error: "Server configuration error." });
      }

      res
        .status(err.status ?? 500)
        .json({ error: err.message ?? "Internal server error" });
    }
  };
}
