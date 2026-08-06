import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // Three.js is isolated below as a stable, cacheable engine chunk.
    chunkSizeWarningLimit: 525,
    rollupOptions: {
      output: {
        manualChunks(moduleId) {
          return moduleId.includes("/node_modules/three/") ? "three-engine" : undefined;
        },
      },
    },
  },
});
