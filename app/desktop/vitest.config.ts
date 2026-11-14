import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  environment: "node", include: ["desktop/**/*.test.ts"], maxWorkers: 2,
  reporters: ["default", ["junit", { outputFile: ".build/reports/desktop.xml" }]],
  coverage: {
    provider: "v8", include: ["desktop/**/*.ts"], exclude: ["desktop/**/*.test.ts"], reportOnFailure: true,
    reportsDirectory: "../coverage/desktop", reporter: ["text-summary", "json-summary", "lcov", "cobertura"],
    thresholds: { statements: 90, lines: 90, functions: 90, branches: 85 },
  },
} });
