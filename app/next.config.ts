import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  distDir: process.env.WYSIWYS_NEXT_DIST || ".next",
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // The app is a root npm workspace, so `next` is hoisted to the repo root
  // node_modules. Turbopack must resolve from there; output stays in app/.
  turbopack: { root: path.resolve("..") },
  outputFileTracingRoot: path.resolve(".."),
};
export default config;
