# tests/

The dedicated, tests-only folder for the RRMM backend. **Tests are never
co-located with source** — they live here and mirror the source tree.

```
tests/
  lib/        ← unit tests for lib/*        (money, format, auction-engine, …)
  api/        ← tests for pages/api/*       (marketplace, stripe/webhook, …)
  helpers/    ← shared mocks + factories (NOT test files; no *.test.ts here)
```

## Running

```bash
npm test               # run once
npm run test:watch     # watch mode
npm run test:coverage   # v8 coverage → coverage/
```

`npm run typecheck` also type-checks this folder — keep tests well-typed (no `any`).

## Conventions

- **Pure logic** (`lib/money.ts`, `lib/format.ts`) → import and assert directly.
- **DB / Stripe / route logic** → mock the modules and use the helpers:
  - `helpers/supabase-mock.ts` — `makeSupabaseHarness()` returns a chainable
    `supabaseAdmin` stand-in. Drive reads with `setResolver(({ table, terminal,
    ops }) => ({ data, error }))`; assert writes with `db.updates(table)` /
    `db.inserts(table)`.
  - `helpers/http.ts` — `mockReq()` / `mockRes()` (captures `statusCode` + `body`).
  - `helpers/factories.ts` — `makeUser/makeAuction/makeBid/makeTransaction/…`
    with sensible defaults; override only what the test cares about.
- **Mocking pattern** (engine, routes, webhook): define the harness + `vi.mock(...)`
  factories at the top of the file, then **dynamically `import()` the
  module-under-test inside `beforeEach`**. This runs the lazy mock factories after
  the harness exists, avoiding hoisting/TDZ errors.
- To test logic inside a route file, `export` the helper (Next.js only treats
  `default` and `config` specially, so extra named exports are harmless) — see
  `pages/api/stripe/webhook.ts` exporting `resolveTransaction` / `deliver*`.

## The rule

Always add or extend tests when you add or change logic. Priorities, highest
first: money math, auction/marketplace state transitions, Stripe webhook
settlement. A ticket isn't done until its behavior is covered and `npm test`
is green.
