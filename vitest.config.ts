import { defineConfig } from "vitest/config";

// All tests live under tests/ (a dedicated, tests-only folder). Source files are
// never co-located with tests. See context/code-standards.md → "Testing".
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Each test file gets its own module registry, so module-level mocks
    // (lib/supabase, lib/stripe, …) don't leak between files.
    isolate: true,
    clearMocks: true,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: ["lib/**/*.ts", "pages/api/**/*.ts"],
      exclude: ["**/*.d.ts", "tests/**"],
    },
  },
});
