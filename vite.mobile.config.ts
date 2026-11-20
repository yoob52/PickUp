import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/mobile",
  base: "./",
  plugins: [react()],
  resolve: { conditions: ["browser"] },
  worker: { format: "es" },
  build: { outDir: "../../out/mobile", emptyOutDir: true, target: "es2022" },
  preview: { host: "127.0.0.1", port: 4174, strictPort: true },
});
