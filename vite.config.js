import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During local dev, Vercel's `vercel dev` serves both the site and /api/*.
// Plain `vite` alone won't run the serverless function — see README.
export default defineConfig({
  plugins: [react()],
});
