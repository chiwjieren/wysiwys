import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // Keep build discovery and generated files inside app in this npm workspace.
  turbopack: { root: path.resolve(".") },
  outputFileTracingRoot: path.resolve("."),
};
export default config;
