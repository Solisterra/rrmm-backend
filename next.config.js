/** @type {import('next').NextConfig} */
const nextConfig = {
  // Remove the "X-Powered-By: Next.js" header — don't advertise the stack
  poweredByHeader: false,

  reactStrictMode: true,

  async headers() {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;

    return [
      {
        // Applied to every route (security baseline)
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options",    value: "nosniff" },
          { key: "X-Frame-Options",           value: "DENY" },
          { key: "X-XSS-Protection",          value: "0" },
          { key: "Referrer-Policy",           value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control",    value: "off" },
          { key: "Permissions-Policy",        value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
      {
        // API-specific: CORS + resource policy
        source: "/api/:path*",
        headers: [
          // CORS: only allow the configured frontend; never fall back to wildcard
          // when credentials are involved (browser would reject it anyway)
          {
            key: "Access-Control-Allow-Origin",
            value: appUrl ?? "",
          },
          { key: "Access-Control-Allow-Credentials", value: "true" },
          { key: "Access-Control-Allow-Methods",     value: "GET,POST,PATCH,DELETE,OPTIONS" },
          {
            key: "Access-Control-Allow-Headers",
            value: "Authorization,Content-Type,X-Request-ID",
          },
          { key: "Access-Control-Expose-Headers",    value: "X-Request-ID,X-RateLimit-Limit,X-RateLimit-Remaining" },
          // API responses must never be cached by CDN/proxy
          { key: "Cache-Control",                    value: "no-store" },
          // No Content-Security-Policy for a JSON API; it only applies to HTML documents
        ],
      },
    ];
  },
};

export default nextConfig;
