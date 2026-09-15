// Installs flow into ~/.local/bin as two files that depend on nothing else:
//
//   flow       a shell shim with the bundle path baked in
//   flow.cjs   the self-contained bundle
//
// The shim exists so the command is `flow` rather than `flow.cjs`, and it bakes an
// absolute path rather than resolving $0 at runtime, which keeps capture fast.

import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Prefer somewhere already on PATH, so the install works without touching a shell
// profile. FLOW_BIN overrides. Falling back to ~/.local/bin keeps the default
// conventional even when nothing suitable is on PATH yet.
function chooseBin() {
  if (process.env.FLOW_BIN) return process.env.FLOW_BIN;
  const path = (process.env.PATH ?? "").split(":");
  const candidates = [join(homedir(), ".local", "bin"), join(homedir(), "bin")];
  return candidates.find((dir) => path.includes(dir)) ?? candidates[0];
}

const BIN = chooseBin();
const BUNDLE = join(BIN, "flow.cjs");
const SHIM = join(BIN, "flow");

await mkdir(BIN, { recursive: true });
await copyFile("dist-cli/flow.cjs", BUNDLE);
await chmod(BUNDLE, 0o755);

await writeFile(SHIM, `#!/bin/sh\nexec node ${JSON.stringify(BUNDLE)} "$@"\n`, "utf8");
await chmod(SHIM, 0o755);

// Prove the installed copy actually runs before claiming success.
const { stdout } = await run(SHIM, ["version"]);
console.log(`installed ${SHIM}`);
console.log(`  ${stdout.trim()}`);

const onPath = (process.env.PATH ?? "").split(":").includes(BIN);
if (!onPath) {
  console.log("");
  console.log(`  NOTE: ${BIN} is not on your PATH, so \`flow\` won't resolve yet.`);
  console.log(`  Add this to ~/.zshrc, then restart your shell:`);
  console.log(`    export PATH="$HOME/.local/bin:$PATH"`);
}
