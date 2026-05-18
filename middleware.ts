import { NextResponse, type NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Rate limit store — fixed-window counter, in-memory per isolate
// ---------------------------------------------------------------------------
const _store = new Map<string, number>();

interface RateLimitRule {
  id: string;
  re: RegExp;
  windowMs: number;
  max: number;
}

const RULES: RateLimitRule[] = [
  { id: "apply", re: /^\/api\/access\/apply$/, windowMs: 15 * 60_000, max: 5 },
  {
    id: "register",
    re: /^\/api\/users\/register$/,
    windowMs: 15 * 60_000,
    max: 5,
  },
  { id: "bid", re: /\/bid$/, windowMs: 30_000, max: 30 },
  { id: "uploads", re: /^\/api\/uploads/, windowMs: 30_000, max: 20 },
  { id: "cron", re: /^\/api\/cron/, windowMs: 30_000, max: 10 },
  { id: "admin", re: /^\/api\/admin/, windowMs: 30_000, max: 120 },
  { id: "api", re: /^\/api/, windowMs: 60_000, max: 100 },
];

function getIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "127.0.0.1";
}

interface RateLimitResult {
  exceeded: boolean;
  limit?: number;
  remaining?: number;
  retryAfter?: number;
}

function checkRateLimit(ip: string, pathname: string): RateLimitResult {
  const rule = RULES.find((r) => r.re.test(pathname));
  if (!rule) return { exceeded: false };

  const bucket = Math.floor(Date.now() / rule.windowMs);
  const key = `${ip}|${rule.id}|${bucket}`;

  const count = (_store.get(key) ?? 0) + 1;
  _store.set(key, count);

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
// Security headers
// ---------------------------------------------------------------------------
const SEC_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "0",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-DNS-Prefetch-Control": "off",
};

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (req.method === "OPTIONS") {
    return new NextResponse(null, { status: 204 });
  }

  const ip = getIp(req);
  const { exceeded, limit, remaining, retryAfter } = checkRateLimit(
    ip,
    pathname,
  );
  const requestId = crypto.randomUUID();

  if (exceeded) {
    return new NextResponse(
      JSON.stringify({
        error: "Too many requests. Please slow down.",
        requestId,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": "0",
          "X-Request-ID": requestId,
          ...SEC_HEADERS,
        },
      },
    );
  }

  const res = NextResponse.next({
    request: {
      headers: new Headers({
        ...Object.fromEntries(req.headers),
        "x-request-id": requestId,
      }),
    },
  });

  res.headers.set("X-Request-ID", requestId);
  if (limit !== undefined) {
    res.headers.set("X-RateLimit-Limit", String(limit));
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
