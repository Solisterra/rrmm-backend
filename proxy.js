import { NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Rate limit store — fixed-window counter, in-memory per isolate
//
// This works well for single-server and for Vercel (warm Edge functions share
// state within a node). For true distributed limiting across multiple regions
// swap `_store` for Upstash Redis using @upstash/ratelimit.
// ---------------------------------------------------------------------------
const _store = new Map();

// Route-specific rules, evaluated top-to-bottom (first match wins)
const RULES = [
  // Public submission endpoints: very tight window to block bots/spam
  { id: "apply",    re: /^\/api\/access\/apply$/,    windowMs: 15 * 60_000, max: 5   },
  { id: "register", re: /^\/api\/users\/register$/,  windowMs: 15 * 60_000, max: 5   },
  // Bidding: competitive but must not be automatable
  { id: "bid",      re: /\/bid$/,                    windowMs:      60_000, max: 30  },
  // File uploads: signing is cheap but abuse is expensive on storage
  { id: "uploads",  re: /^\/api\/uploads/,           windowMs:      60_000, max: 20  },
  // Cron: guarded by secret, but still cap it
  { id: "cron",     re: /^\/api\/cron/,              windowMs:      60_000, max: 10  },
  // Admin panel: humans make bursts; keep generous but bounded
  { id: "admin",    re: /^\/api\/admin/,             windowMs:      60_000, max: 120 },
  // General API fallback
  { id: "api",      re: /^\/api/,                    windowMs:      60_000, max: 100 },
];

function getIp(req) {
  // Vercel sets x-forwarded-for; take only the first (client) IP
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "127.0.0.1";
}

function checkRateLimit(ip, pathname) {
  const rule = RULES.find((r) => r.re.test(pathname));
  if (!rule) return { exceeded: false };

  const bucket = Math.floor(Date.now() / rule.windowMs);
  const key = `${ip}|${rule.id}|${bucket}`;

  const count = (_store.get(key) ?? 0) + 1;
  _store.set(key, count);

  // Trim oldest entries when the store grows too large (Map preserves insertion order)
  if (_store.size > 20_000) {
    let pruned = 0;
    for (const k of _store.keys()) {
      _store.delete(k);
      if (++pruned >= 5_000) break;
    }
  }

  const remaining = Math.max(0, rule.max - count);
  return {
    exceeded: count > rule.max,
    limit: rule.max,
    remaining,
    retryAfter: Math.ceil(rule.windowMs / 1000),
  };
}

// ---------------------------------------------------------------------------
// Security headers added to every API response
// ---------------------------------------------------------------------------
const SEC_HEADERS = {
  "X-Content-Type-Options":     "nosniff",
  "X-Frame-Options":            "DENY",
  "X-XSS-Protection":           "0",
  "Referrer-Policy":            "strict-origin-when-cross-origin",
  "Permissions-Policy":         "camera=(), microphone=(), geolocation=(), payment=()",
  "Strict-Transport-Security":  "max-age=63072000; includeSubDomains; preload",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-DNS-Prefetch-Control":     "off",
};

// ---------------------------------------------------------------------------
// Proxy entry point (Next.js 16+ — replaces middleware.js)
// ---------------------------------------------------------------------------
export function proxy(req) {
  const { pathname } = req.nextUrl;

  // Short-circuit OPTIONS preflight — CORS headers are set in next.config.js
  if (req.method === "OPTIONS") {
    return new NextResponse(null, { status: 204 });
  }

  const ip = getIp(req);
  const { exceeded, limit, remaining, retryAfter } = checkRateLimit(ip, pathname);

  const requestId = crypto.randomUUID();

  if (exceeded) {
    return new NextResponse(
      JSON.stringify({ error: "Too many requests. Please slow down.", requestId }),
      {
        status: 429,
        headers: {
          "Content-Type":          "application/json",
          "Retry-After":           String(retryAfter),
          "X-RateLimit-Limit":     String(limit),
          "X-RateLimit-Remaining": "0",
          "X-Request-ID":          requestId,
          ...SEC_HEADERS,
        },
      },
    );
  }

  // Forward the request ID to the route handler via a request header
  const res = NextResponse.next({
    request: {
      headers: new Headers({ ...Object.fromEntries(req.headers), "x-request-id": requestId }),
    },
  });

  res.headers.set("X-Request-ID", requestId);
  if (limit !== undefined) {
    res.headers.set("X-RateLimit-Limit",     String(limit));
    res.headers.set("X-RateLimit-Remaining", String(remaining));
  }

  for (const [k, v] of Object.entries(SEC_HEADERS)) {
    res.headers.set(k, v);
  }

  return res;
}

export const config = {
  matcher: ["/api/:path*"],
};
