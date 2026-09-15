// Bundles the CLI into one self-contained file.
//
// The point is that the installed `flow` must not depend on this repo. A shim
// that requires ../dist-cli breaks the moment the repo is moved, renamed or
// cleaned — and it breaks silently, at the exact moment you are trying to write
// a thought down. One file with no requires cannot break that way.

import { build } from "esbuild";
import { chmod, mkdir } from "node:fs/promises";

// .cjs, not an extensionless file: node picks the module system from the nearest
// package.json, and ~/package.json here declares "type": "module". An extensionless
// bundle would therefore be parsed as ESM once installed under $HOME and die on its
// first require. The extension pins it to CommonJS no matter where it lands.
const OUT = "dist-cli/flow.cjs";

await mkdir("dist-cli", { recursive: true });

const result = await build({
  entryPoints: ["src/cli/index.ts"],
  outfile: OUT,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  banner: { js: "#!/usr/bin/env node" },
  define: { __FLOW_BUILT__: JSON.stringify(new Date().toISOString()) },
  legalComments: "none",
  metafile: true,
});

await chmod(OUT, 0o755);

const bytes = Object.values(result.metafile.outputs)[0].bytes;
console.log(`built ${OUT}  (${(bytes / 1024).toFixed(0)} KB, self-contained)`);
