import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    __UI_BUILD_TIME__: JSON.stringify(new Date().toISOString())
  },
  base: "./",
  resolve: {
    alias: {
      "@pona-flow/composer": path.resolve(__dirname, "../composer/src/index.ts"),
      "@pona-flow/regex-validator": path.resolve(__dirname, "../regex-validator/src/index.ts"),
      "@pona-flow/connector": path.resolve(__dirname, "../connector/src/index.ts"),
      "@pona-flow/authoring": path.resolve(__dirname, "../authoring/src/index.ts"),
    },
  },
  server: {
    host: "127.0.0.1",
    // 5273 avoids clashing with other local Vite apps that default to 5173.
    port: 5273,
    strictPort: mode === "e2e",
    // Allow importing the shared JS modules that live in App/js (outside App/ui).
    fs: {
      allow: ["../.."]
    },
    proxy: {
      // Keep the browser Host (e.g. 127.0.0.1:5273) visible to the API as
      // X-Forwarded-Host so the local-auth CSRF Origin check accepts Vite POSTs.
      // changeOrigin would rewrite Host to :8765 and trip "Cross-site request rejected."
      "/api": {
        target: "http://127.0.0.1:8765",
        changeOrigin: false,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            const host = req.headers.host;
            if (host) {
              proxyReq.setHeader("Host", host);
              proxyReq.setHeader("X-Forwarded-Host", host);
            }
          });
        },
      },
    },
  }
}));
