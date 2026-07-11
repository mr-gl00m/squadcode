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
    const fragment = await loadProjectInstructions(cwd);
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
    accumulator.apply(messages, [await loadProjectInstructions(root)]);
    await writeFile(path, "second rule", "utf8");
    accumulator.apply(messages, [await loadProjectInstructions(root)]);

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
      await loadProjectInstructions(root),
    ).content;
    expect(rendered).toContain("squad rule");
    expect(rendered).not.toContain("agents rule");
  });
});
