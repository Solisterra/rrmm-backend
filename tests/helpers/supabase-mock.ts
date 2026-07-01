import { vi } from "vitest";

// ── Supabase test harness ─────────────────────────────────────────────────────
// A chainable stand-in for `supabaseAdmin`. The real client builds queries like
//   supabaseAdmin.from("t").select("*").eq("id", x).single()
// and is thenable for write chains (`await ...update().eq()`). This mock mirrors
// that: every filter/modifier returns the builder; `.single()`, `.maybeSingle()`
// and awaiting all settle via a per-test `resolver`, which decides the
// `{ data, error }` from the table + recorded operations.
//
// Each call is recorded in `log`, so a test can assert exactly what was written
// (e.g. that a marketplace settlement bumped `license_count` but never flipped
// `status` or `rights_transferred`).

export interface Op {
  m: string;
  args: unknown[];
}
export interface LogEntry {
  table: string;
  ops: Op[];
}
export interface ResolveCtx {
  table: string;
  ops: Op[];
  terminal: "single" | "maybeSingle" | "await";
}
export type Resolver = (ctx: ResolveCtx) => { data: unknown; error: unknown };

const CHAIN_METHODS = [
  "select",
  "insert",
  "update",
  "delete",
  "upsert",
  "eq",
  "neq",
  "not",
  "in",
  "is",
  "or",
  "filter",
  "match",
  "order",
  "limit",
  "range",
  "gte",
  "lte",
  "lt",
  "gt",
  "contains",
  "ilike",
  "like",
];

export function makeSupabaseHarness() {
  const log: LogEntry[] = [];
  let resolver: Resolver = () => ({ data: null, error: null });
  let signedUrl: string | null = "https://signed.example/full.jpg";

  function from(table: string) {
    const ops: Op[] = [];
    log.push({ table, ops });
    const builder: Record<string, unknown> = {};
    const settle = (terminal: ResolveCtx["terminal"]) =>
      Promise.resolve(resolver({ table, ops, terminal }));
    for (const m of CHAIN_METHODS) {
      builder[m] = (...args: unknown[]) => {
        ops.push({ m, args });
        return builder;
      };
    }
    builder.single = () => settle("single");
    builder.maybeSingle = () => settle("maybeSingle");
    // Thenable: makes `await supabaseAdmin.from(t).update(x).eq(...)` resolve.
    builder.then = (
      onF: (v: unknown) => unknown,
      onR?: (e: unknown) => unknown,
    ) => settle("await").then(onF, onR);
    return builder;
  }

  const storage = {
    from: vi.fn(() => ({
      createSignedUrl: vi.fn(async () => ({
        data: signedUrl ? { signedUrl } : null,
        error: signedUrl ? null : { message: "sign failed" },
      })),
      createSignedUploadUrl: vi.fn(async () => ({
        data: { signedUrl: "https://upload", path: "p", token: "t" },
        error: null,
      })),
      getPublicUrl: vi.fn(() => ({ data: { publicUrl: "https://public" } })),
      remove: vi.fn(async () => ({ error: null })),
    })),
  };

  const supabaseAdmin = {
    from: vi.fn(from),
    storage,
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };

  return {
    supabaseAdmin,
    // Auth + query helpers some routes import alongside supabaseAdmin.
    getUserFromRequest: vi.fn(),
    supabaseQuery: vi.fn(async (q: unknown) => q),
    supabase: { auth: { getUser: vi.fn() } },

    log,
    setResolver: (fn: Resolver) => {
      resolver = fn;
    },
    setSignedUrl: (u: string | null) => {
      signedUrl = u;
    },

    // ── assertion helpers ─────────────────────────────────────────────
    /** Payload objects passed to every `.update(...)` against a table. */
    updates: (table: string): Record<string, unknown>[] =>
      log
        .filter((e) => e.table === table)
        .flatMap((e) =>
          e.ops
            .filter((o) => o.m === "update")
            .map((o) => o.args[0] as Record<string, unknown>),
        ),
    /** Payload objects passed to every `.insert(...)` against a table. */
    inserts: (table: string): Record<string, unknown>[] =>
      log
        .filter((e) => e.table === table)
        .flatMap((e) =>
          e.ops
            .filter((o) => o.m === "insert")
            .map((o) => o.args[0] as Record<string, unknown>),
        ),

    reset: () => {
      log.length = 0;
      resolver = () => ({ data: null, error: null });
      signedUrl = "https://signed.example/full.jpg";
      supabaseAdmin.from.mockClear();
    },
  };
}

export type SupabaseHarness = ReturnType<typeof makeSupabaseHarness>;
