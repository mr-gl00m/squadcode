// One-off helper to populate assets/repomap/wasm/ from the tree-sitter-wasms
// package without committing tree-sitter-wasms as a permanent devDependency
// (it's ~52MB unpacked). Run:
//
//   node scripts/refresh-repomap-wasm.mjs
//
// The script does a no-save install of tree-sitter-wasms, copies the five
// WASMs the repo map and shell-safety parser care about into
// assets/repomap/wasm/, then leaves package.json untouched. The vendored WASMs
// are committed so downstream installs don't need to re-fetch.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const assetDir = join(repoRoot, "assets", "repomap", "wasm");
mkdirSync(assetDir, { recursive: true });

const LANGUAGES = [
  "typescript",
  "tsx",
  "javascript",
  "python",
  "rust",
  "go",
  "bash",
];

const sourceDir = join(repoRoot, "node_modules", "tree-sitter-wasms", "out");
const alreadyInstalled = existsSync(sourceDir);

if (!alreadyInstalled) {
  console.log("installing tree-sitter-wasms (no-save)...");
  const r = spawnSync("npm", ["install", "--no-save", "tree-sitter-wasms"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
  });
  if (r.status !== 0) {
    console.error("npm install failed; aborting");
    process.exit(1);
  }
}

if (!existsSync(sourceDir)) {
  console.error(
    `expected ${sourceDir} after install — package layout changed?`,
  );
  process.exit(1);
}

let copied = 0;
for (const lang of LANGUAGES) {
  const filename = `tree-sitter-${lang}.wasm`;
  const src = join(sourceDir, filename);
  const dest = join(assetDir, filename);
  if (!existsSync(src)) {
    console.warn(`missing: ${src}`);
    continue;
  }
  copyFileSync(src, dest);
  copied++;
  console.log(`copied ${filename}`);
}

console.log(`\n${copied} WASM(s) copied to ${assetDir}`);
console.log(
  "If you didn't have tree-sitter-wasms before, you can `npm uninstall --no-save tree-sitter-wasms` to remove it.",
);
