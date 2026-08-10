import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
var __dirname = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig(function (_a) {
    var mode = _a.mode;
    return ({
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
            port: 5173,
            strictPort: mode === "e2e",
            // Allow importing the shared JS modules that live in App/js (outside App/ui).
            fs: {
                allow: ["../.."]
            },
            proxy: {
                "/api": "http://127.0.0.1:8765"
            }
        }
    });
});
