import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Only used for local `pnpm dev`; in Docker the backend serves the built
      // static files directly, so no proxy is needed there.
      "/api": "http://localhost:3000",
    },
  },
});
