import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 4096,
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
