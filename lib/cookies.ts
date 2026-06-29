import type { NextApiRequest, NextApiResponse } from "next";

// httpOnly session cookies. Tokens never touch JS/localStorage — the browser
// holds them and sends them automatically on same-site (dev proxy) and
// cross-site (prod) requests. Cross-site delivery needs SameSite=None; Secure,
// which only works over HTTPS, so dev (http://localhost) uses Lax without Secure.
export const ACCESS_COOKIE = "rrmm_at";
export const REFRESH_COOKIE = "rrmm_rt";

const isProd = process.env.NODE_ENV === "production";

// 30 days — the access *token* still expires hourly (Supabase) and is rotated
// via /auth/refresh; this is just how long the session survives without use.
const MAX_AGE = 60 * 60 * 24 * 30;

function serialize(name: string, value: string, maxAge: number): string {
  const parts = [
    `${name}=${value}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${maxAge}`,
    `SameSite=${isProd ? "None" : "Lax"}`,
  ];
  if (isProd) parts.push("Secure");
  return parts.join("; ");
}

export function setAuthCookies(
  res: NextApiResponse,
  accessToken: string,
  refreshToken: string,
): void {
  res.setHeader("Set-Cookie", [
    serialize(ACCESS_COOKIE, accessToken, MAX_AGE),
    serialize(REFRESH_COOKIE, refreshToken, MAX_AGE),
  ]);
}

export function clearAuthCookies(res: NextApiResponse): void {
  res.setHeader("Set-Cookie", [
    serialize(ACCESS_COOKIE, "", 0),
    serialize(REFRESH_COOKIE, "", 0),
  ]);
}

// Access token for request authentication: prefer the httpOnly cookie, fall
// back to the Authorization header for non-browser callers (scripts, tests).
export function getAccessToken(req: NextApiRequest): string | undefined {
  return (
    req.cookies?.[ACCESS_COOKIE] ||
    req.headers.authorization?.replace("Bearer ", "") ||
    undefined
  );
}
