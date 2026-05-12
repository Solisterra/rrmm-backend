// Wraps a Next.js API handler so unhandled exceptions return JSON instead of HTML
export function withErrorHandling(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[${req.method}] ${req.url}`, err);
      res
        .status(err.status ?? 500)
        .json({ error: err.message ?? "Internal server error" });
    }
  };
}
