import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server (`.next/standalone/` with a pruned node_modules
  // produced by output file tracing) so the production image needs no `npm install`
  // and excludes the heavy ingest-only `@pkmn/dex`/`mods`/`data` (~217 MB). The
  // small `@pkmn/sets` (the only @pkmn runtime import in the app graph) is traced
  // in. The Dockerfile copies `.next/standalone`, `.next/static` and runs
  // `node server.js`. See docs/architecture + fly.toml.
  output: "standalone",
  // Keep these out of the server bundle and require them at runtime; with
  // standalone output, file tracing then copies them into
  // `.next/standalone/node_modules`.
  //   - `pg`: CommonJS package that lazily requires optional native helpers
  //     (`pg-native`) — bundling tries to trace those and breaks.
  //   - `drizzle-orm`: must be a real on-disk module (not webpack-bundled) so the
  //     plain-ESM `migrate.mjs` (the Fly release_command, NOT part of the Next
  //     bundle) can `import "drizzle-orm/node-postgres/migrator"` at runtime.
  // Must be TOP-LEVEL (not under experimental.*) on Next 15.
  serverExternalPackages: ["pg", "drizzle-orm"],
};

export default nextConfig;
