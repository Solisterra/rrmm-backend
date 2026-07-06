import { afterEach, describe, expect, it, vi } from "vitest";
import { getAllowedOrigin } from "../../lib/cors";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getAllowedOrigin", () => {
  it.each([
    "https://rrmm.io",
    "https://www.rrmm.io",
    "https://rrmm-frontend.vercel.app",
    "http://localhost:5173",
    "http://localhost:3000",
  ])("reflects allowlisted origin %s", (origin) => {
    expect(getAllowedOrigin(origin)).toBe(origin);
  });

  it("allows frontend preview deploys", () => {
    const origin = "https://rrmm-frontend-git-main-solisterra.vercel.app";
    expect(getAllowedOrigin(origin)).toBe(origin);
  });

  it.each([
    "https://evil.example.com",
    // must not match on prefix/suffix tricks
    "https://rrmm.io.evil.example.com",
    "https://xrrmm-frontend.vercel.app",
    // scheme matters
    "http://rrmm.io",
  ])("rejects unknown origin %s", (origin) => {
    expect(getAllowedOrigin(origin)).toBeNull();
  });

  it("returns null for a missing origin", () => {
    expect(getAllowedOrigin(undefined)).toBeNull();
    expect(getAllowedOrigin(null)).toBeNull();
    expect(getAllowedOrigin("")).toBeNull();
  });

  it("accepts extra origins from FRONTEND_URL (comma-separated)", () => {
    vi.stubEnv(
      "FRONTEND_URL",
      "https://staging.rrmm.io, http://localhost:4321",
    );
    expect(getAllowedOrigin("https://staging.rrmm.io")).toBe(
      "https://staging.rrmm.io",
    );
    expect(getAllowedOrigin("http://localhost:4321")).toBe(
      "http://localhost:4321",
    );
    // static entries still work alongside env ones
    expect(getAllowedOrigin("https://rrmm.io")).toBe("https://rrmm.io");
  });
});
