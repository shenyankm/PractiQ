import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
export default defineConfig({
  test: {
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test-setup.ts", "src/contracts.generated.ts", "src/components/ui/**", "src/locales/**"],
      reportsDirectory: "../coverage/app",
      thresholds: { statements: 80, branches: 73, functions: 73, lines: 85 },
    },
  },
  plugins: [
    {
      name: "katex-woff2",
      enforce: "pre",
      transform(code, id) {
        // macOS 14+ WebView supports WOFF2; keep every KaTeX font family.
        if (id.endsWith("/katex/dist/katex.min.css")) {
          return code.replace(/,url\([^)]*\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, "");
        }
      },
    },
    react(), tailwindcss(),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  clearScreen: false,
});
