import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ContextFragmentAccumulator,
  fragmentId,
  renderContextFragment,
} from "../src/context/fragment.js";
import {
  findProjectRoot,
  loadProjectInstructions,
} from "../src/instructions.js";
import type { CanonicalMessage } from "../src/providers/types.js";

describe("project instruction ingestion", () => {
  function withoutUserInstructions(root: string) {
    return { homeDir: join(root, "empty-home") };
  }

  it("loads root-to-cwd with narrower instructions last", async () => {
    const root = await mkdtemp(join(tmpdir(), "squad-instructions-"));
    const cwd = join(root, "packages", "app");
    await mkdir(join(root, ".git"));
    await mkdir(join(cwd, ".squad"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "root rule", "utf8");
    await writeFile(
      join(cwd, ".squad", "instructions.md"),
      "nested <rule>",
      "utf8",
    );

    expect(await findProjectRoot(cwd)).toBe(root);
    const fragment = await loadProjectInstructions(
      cwd,
      withoutUserInstructions(root),
    );
    const rendered = renderContextFragment(fragment).content;
    expect(fragmentId(fragment)).toBe("project:instructions:active");
    expect(fragment.merge).toBe("replace");
    expect(fragment.attributes?.files).toBe(2);
    expect(rendered.indexOf("root rule")).toBeLessThan(
      rendered.indexOf("nested &lt;rule&gt;"),
    );
  });

  it("refreshes one replaceable fragment when a file changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "squad-instructions-"));
    await mkdir(join(root, ".git"));
    const path = join(root, "AGENTS.md");
    await writeFile(path, "first rule", "utf8");
    const messages: CanonicalMessage[] = [];
    const accumulator = new ContextFragmentAccumulator();
    accumulator.apply(messages, [
      await loadProjectInstructions(root, withoutUserInstructions(root)),
    ]);
    await writeFile(path, "second rule", "utf8");
    accumulator.apply(messages, [
      await loadProjectInstructions(root, withoutUserInstructions(root)),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("second rule");
    expect(messages[0]?.content).not.toContain("first rule");
  });

  it("prefers .squad instructions over AGENTS.md in the same directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "squad-instructions-"));
    await mkdir(join(root, ".git"));
    await mkdir(join(root, ".squad"));
    await writeFile(join(root, "AGENTS.md"), "agents rule", "utf8");
    await writeFile(
      join(root, ".squad", "instructions.md"),
      "squad rule",
      "utf8",
    );
    const rendered = renderContextFragment(
      await loadProjectInstructions(root, withoutUserInstructions(root)),
    ).content;
    expect(rendered).toContain("squad rule");
    expect(rendered).not.toContain("agents rule");
  });

  it("prepends user-wide instructions before project instructions", async () => {
    const base = await mkdtemp(join(tmpdir(), "squad-instructions-"));
    const home = join(base, "home");
    const root = join(base, "project");
    const cwd = join(root, "packages", "app");
    await mkdir(join(home, ".squad"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(home, ".squad", "instructions.md"),
      "user-wide rule",
      "utf8",
    );
    await writeFile(join(root, "AGENTS.md"), "project rule", "utf8");

    const fragment = await loadProjectInstructions(cwd, { homeDir: home });
    const rendered = renderContextFragment(fragment).content;

    expect(fragment.attributes?.files).toBe(2);
    expect(rendered).toContain("~/.squad/instructions.md");
    expect(rendered.indexOf("user-wide rule")).toBeLessThan(
      rendered.indexOf("project rule"),
    );
  });
});
