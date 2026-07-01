import type { NextApiRequest, NextApiResponse } from "next";

// Minimal NextApiRequest stand-in for exercising route handlers directly.
export function mockReq(
  init: Partial<{
    method: string;
    query: Record<string, unknown>;
    body: unknown;
    headers: Record<string, string>;
  }> = {},
): NextApiRequest {
  return {
    method: init.method ?? "GET",
    query: init.query ?? {},
    body: init.body ?? {},
    headers: init.headers ?? {},
  } as unknown as NextApiRequest;
}

export interface CapturedRes extends NextApiResponse {
  statusCode: number;
  body: unknown;
  ended: boolean;
  headers: Record<string, string>;
}

// Captures status + JSON payload so assertions can read res.statusCode / res.body.
// withErrorHandling also calls setHeader (CORS) and end (OPTIONS), so both exist.
export function mockRes(): CapturedRes {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    ended: false,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
  };
  return res as unknown as CapturedRes;
}
