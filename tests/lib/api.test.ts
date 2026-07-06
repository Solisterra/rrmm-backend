import { describe, expect, it } from "vitest";
import { withErrorHandling } from "../../lib/api";
import { mockReq, mockRes } from "../helpers/http";

const okHandler = withErrorHandling(async (_req, res) => {
  res.status(200).json({ ok: true });
});

describe("withErrorHandling CORS", () => {
  it("reflects an allowlisted origin with credentials", async () => {
    const res = mockRes();
    await okHandler(
      mockReq({ method: "GET", headers: { origin: "https://rrmm.io" } }),
      res,
    );

    expect(res.headers["Access-Control-Allow-Origin"]).toBe("https://rrmm.io");
    expect(res.headers["Access-Control-Allow-Credentials"]).toBe("true");
    expect(res.headers["Vary"]).toBe("Origin");
    expect(res.statusCode).toBe(200);
  });

  it("emits no CORS headers for an unknown origin", async () => {
    const res = mockRes();
    await okHandler(
      mockReq({
        method: "GET",
        headers: { origin: "https://evil.example.com" },
      }),
      res,
    );

    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(res.headers["Access-Control-Allow-Credentials"]).toBeUndefined();
    // handler still runs — CORS is enforced by the browser, not the server
    expect(res.statusCode).toBe(200);
  });

  it("emits no CORS headers for same-origin requests (no Origin header)", async () => {
    const res = mockRes();
    await okHandler(mockReq({ method: "GET" }), res);

    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(res.statusCode).toBe(200);
  });

  it("short-circuits OPTIONS preflight with CORS headers", async () => {
    const res = mockRes();
    await okHandler(
      mockReq({ method: "OPTIONS", headers: { origin: "https://rrmm.io" } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.ended).toBe(true);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("https://rrmm.io");
    expect(res.headers["Access-Control-Allow-Methods"]).toContain("POST");
  });
});
