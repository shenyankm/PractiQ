import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:8090", changeOrigin: false } },
  },
  preview: { host: "127.0.0.1", port: 5174, strictPort: true },
  build: { outDir: "dist", sourcemap: false },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    maxWorkers: 2,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test-setup.ts", "src/test-fixtures.ts", "src/contracts.generated.ts", "src/main.tsx", "src/components/ui/**"],
      reporter: ["text", "json-summary", "html"],
      thresholds: { statements: 80, branches: 73, functions: 73, lines: 85 },
    },
  },
});
