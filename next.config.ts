import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // node-postgres (`pg`) is a CommonJS package that lazily requires optional
  // native helpers (`pg-native`); keep it out of the server bundle so Next does
  // not try to trace/bundle those. Must be TOP-LEVEL (not under experimental.*)
  // on Next 15.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
