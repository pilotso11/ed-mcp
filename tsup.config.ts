import { defineConfig } from "tsup";

const requireShim = [
  'import { createRequire as __createRequire } from "node:module";',
  "const require = __createRequire(import.meta.url);",
];

const common = {
  format: ["esm" as const],
  target: "node22",
  platform: "node" as const,
  sourcemap: true,
  // Self-contained files: npx and Claude Desktop never install dependencies.
  // The build script empties dist first; tsup's clean would race between the two entries.
  noExternal: [/.*/],
};

export default defineConfig([
  {
    ...common,
    entry: ["src/index.ts"],
    banner: { js: ["#!/usr/bin/env node", ...requireShim].join("\n") },
  },
  {
    // The `ed-mcp/journal` library, for other programs such as ED Chat. Its types come from
    // tsconfig.lib.json: TypeScript 7 has no compiler API for tsup's dts option.
    ...common,
    entry: { journal: "src/lib/journal.ts" },
    banner: { js: requireShim.join("\n") },
  },
]);
