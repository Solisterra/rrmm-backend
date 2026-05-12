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

// Wraps a Next.js API handler:
//  - Returns JSON (not HTML) for all unhandled exceptions
//  - Classifies network errors as 503, config errors as 500
//  - Propagates the X-Request-ID injected by middleware into error bodies
export function withErrorHandling(handler) {
  return async (req, res) => {
    const requestId = req.headers["x-request-id"];

    // Echo the request ID on every response so clients can correlate errors
    if (requestId) res.setHeader("X-Request-ID", requestId);

    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[${req.method}] ${req.url} requestId=${requestId}`, err);

      const body = (message) =>
        requestId ? { error: message, requestId } : { error: message };

      if (isNetworkError(err)) {
        return res
          .status(503)
          .json(body("Service temporarily unavailable. Please try again shortly."));
      }

      if (isConfigError(err)) {
        return res.status(500).json(body("Server configuration error."));
      }

      res
        .status(err.status ?? 500)
        .json(body(err.message ?? "Internal server error"));
    }
  };
}
