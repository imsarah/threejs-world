import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const entry = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig(({ command }) => ({
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      // two entries: the WebGPU desktop app and the lightweight WebGL2 mobile scene
      input: {
        main: entry("./index.html"),
        mobile: entry("./mobile.html"),
      },
    },
  },
  server: {
    // no fixed port — Vite picks the first free port (default 5173, then
    // increments). strictPort:false makes the fallback automatic.
    strictPort: false,
    // tool-driven file writes are missed by fsevents on this setup; poll so
    // the module graph never serves stale code (cost: dev-only CPU)
    watch: { usePolling: true, interval: 200 },
  },
  esbuild: {
    target: "esnext",
  },
  base: command === "build" ? "/laas/" : "/",
}));
