// Single source of truth for which browser origins may call the API.
// Used by both proxy.ts (routing layer, answers preflights) and lib/api.ts
// (route handlers) so the two layers can never disagree about an origin.
const STATIC_ORIGINS: Array<string | RegExp> = [
  "https://rrmm.io",
  "https://www.rrmm.io",
  "https://rrmm-frontend.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
  // Vercel preview deploys for the frontend project
  /^https:\/\/rrmm-frontend-[a-z0-9-]+\.vercel\.app$/,
];

// FRONTEND_URL (comma-separated) can add origins without a code change.
// Read at call time so env changes are picked up in tests.
function envOrigins(): string[] {
  return (process.env.FRONTEND_URL ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function getAllowedOrigin(
  origin: string | null | undefined,
): string | null {
  if (!origin) return null;
  if (envOrigins().includes(origin)) return origin;
  for (const entry of STATIC_ORIGINS) {
    if (typeof entry === "string" ? entry === origin : entry.test(origin)) {
      return origin;
    }
  }
  return null;
}
