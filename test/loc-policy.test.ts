import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const HARD_STOP = 800;

function maintainedTypeScript(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...maintainedTypeScript(path));
      continue;
    }
    if (entry.isFile() && [".ts", ".tsx"].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

describe("maintained source line-count policy", () => {
  it("keeps every TypeScript source file at or below the hard stop", () => {
    const root = join(process.cwd(), "src");
    const violations = maintainedTypeScript(root)
      .map((path) => ({
        path: relative(process.cwd(), path).replaceAll("\\", "/"),
        lines: readFileSync(path, "utf8").split(/\r?\n/).length,
      }))
      .filter((entry) => entry.lines > HARD_STOP)
      .sort((left, right) => right.lines - left.lines);

    expect(violations).toEqual([]);
  });

  it("documents the target and hard stop where contributors will read them", () => {
    const rootInstructions = readFileSync(
      join(process.cwd(), "AGENTS.md"),
      "utf8",
    );
    const cliInstructions = readFileSync(
      join(process.cwd(), "src", "cli", "AGENTS.md"),
      "utf8",
    );
    expect(rootInstructions).toContain("Target 500 lines");
    expect(rootInstructions).toContain("800 lines is a hard stop");
    expect(cliInstructions).toContain("repl-app.tsx");
    expect(cliInstructions).toContain("program.ts");
  });
});
