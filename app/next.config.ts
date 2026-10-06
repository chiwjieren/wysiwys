import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  distDir: process.env.WYSIWYS_NEXT_DIST || ".next",
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // Keep build discovery and generated files inside app in this npm workspace.
  turbopack: { root: path.resolve(".") },
  outputFileTracingRoot: path.resolve("."),
};
export default config;
