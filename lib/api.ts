import type { NextApiRequest, NextApiResponse } from "next";
import { getAllowedOrigin } from "./cors";

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
]);

function applyCors(req: NextApiRequest, res: NextApiResponse) {
  // Same allowlist as proxy.ts (lib/cors.ts). Reflect the origin only when it
  // matches — echoing a fallback origin for unknown callers would stamp the
  // wrong Access-Control-Allow-Origin on responses the proxy already vetted.
  const allowed = getAllowedOrigin(req.headers.origin);
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", allowed);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PATCH,DELETE,OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization,Content-Type,X-Request-ID",
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "X-Request-ID,X-RateLimit-Limit,X-RateLimit-Remaining",
    );
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-store");
}

interface NodeError extends Error {
  code?: string;
  cause?: { code?: string };
  status?: number;
}

function isNetworkError(err: NodeError): boolean {
  if (err.message === "fetch failed") return true;
  if (err.cause && NETWORK_ERROR_CODES.has(err.cause?.code ?? "")) return true;
  return false;
}

function isConfigError(err: NodeError): boolean {
  return err.message?.startsWith("Missing required environment variable");
}

export function withErrorHandling(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>,
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    applyCors(req, res);
    if (req.method === "OPTIONS") return res.status(200).end();

    const requestId = req.headers["x-request-id"] as string | undefined;

    if (requestId) res.setHeader("X-Request-ID", requestId);

    try {
      await handler(req, res);
    } catch (err) {
      const e = err as NodeError;
      console.error(`[${req.method}] ${req.url} requestId=${requestId}`, e);

      const body = (message: string) =>
        requestId ? { error: message, requestId } : { error: message };

      if (isNetworkError(e)) {
        return res
          .status(503)
          .json(
            body("Service temporarily unavailable. Please try again shortly."),
          );
      }

      if (isConfigError(e)) {
        return res.status(500).json(body("Server configuration error."));
      }

      res
        .status(e.status ?? 500)
        .json(body(e.message ?? "Internal server error"));
    }
  };
}
