import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleSlash, type SlashContext } from "../src/cli/slash.js";
import {
  composeSystemPrompt,
  loadOutputStyles,
  type OutputStyle,
} from "../src/output-styles.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "squad-style-"));
}

const STYLE_TERSE = `---
name: terse
description: Short one-line answers, no preamble.
---

Respond in one sentence. No bullet lists, no headers, no preamble.
`;

const STYLE_RATIONALE = `---
name: rationale
description: Always show reasoning before the conclusion.
---

For every answer, first explain your reasoning in 2-3 sentences, then state the conclusion.
`;

describe("loadOutputStyles", () => {
  it("returns an empty map when neither user nor project dir exists", async () => {
    const cwd = await makeTempDir();
    const map = await loadOutputStyles(cwd);
    // The user dir at ~/.squad/output-styles may or may not exist on the host;
    // size could be > 0 in that case. We only assert the project-local part is
    // absent by checking nothing claims project source.
    for (const s of map.values()) {
      expect(s.source).not.toBe("project");
    }
  });

  it("loads project styles from ./.squad/output-styles/*.md", async () => {
    const cwd = await makeTempDir();
    const dir = join(cwd, ".squad", "output-styles");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "terse.md"), STYLE_TERSE);
    await writeFile(join(dir, "rationale.md"), STYLE_RATIONALE);

    const map = await loadOutputStyles(cwd);
    const terse = map.get("terse");
    const rationale = map.get("rationale");
    expect(terse).toBeDefined();
    expect(terse!.source).toBe("project");
    expect(terse!.description).toBe("Short one-line answers, no preamble.");
    expect(terse!.body).toContain("one sentence");
    expect(rationale).toBeDefined();
    expect(rationale!.source).toBe("project");
  });

  it("skips files without a valid frontmatter block", async () => {
    const cwd = await makeTempDir();
    const dir = join(cwd, ".squad", "output-styles");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "broken.md"), "no frontmatter here, just text");
    await writeFile(join(dir, "ok.md"), STYLE_TERSE);

    const map = await loadOutputStyles(cwd);
    expect(map.has("terse")).toBe(true);
    expect(map.size).toBeGreaterThanOrEqual(1);
    for (const s of map.values()) {
      if (s.source === "project") {
        expect(s.name).toBe("terse");
      }
    }
  });

  it("ignores non-.md files in the directory", async () => {
    const cwd = await makeTempDir();
    const dir = join(cwd, ".squad", "output-styles");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "terse.md"), STYLE_TERSE);
    await writeFile(join(dir, "README.txt"), "not a style");
    await writeFile(join(dir, "config.json"), "{}");

    const map = await loadOutputStyles(cwd);
    const projectStyles = Array.from(map.values()).filter(
      (s) => s.source === "project",
    );
    expect(projectStyles.length).toBe(1);
    expect(projectStyles[0]!.name).toBe("terse");
  });
});

describe("composeSystemPrompt", () => {
  const style: OutputStyle = {
    name: "terse",
    description: "",
    body: "Be terse.",
    source: "user",
    path: "/x",
  };

  it("returns the base prompt unchanged when no style is active", () => {
    expect(composeSystemPrompt(null, "You are an agent.")).toBe(
      "You are an agent.",
    );
  });

  it("returns undefined when no style and no base", () => {
    expect(composeSystemPrompt(null, undefined)).toBeUndefined();
  });

  it("prepends the style body when a style is active", () => {
    expect(composeSystemPrompt(style, "You are an agent.")).toBe(
      "Be terse.\n\nYou are an agent.",
    );
  });

  it("returns just the style body when there is no base prompt", () => {
    expect(composeSystemPrompt(style, undefined)).toBe("Be terse.");
    expect(composeSystemPrompt(style, "")).toBe("Be terse.");
  });
});

function makeContext(
  overrides: Partial<SlashContext> & {
    styles?: Map<string, OutputStyle>;
    activeName?: string | null;
  } = {},
): SlashContext & { lastSet?: string; cleared?: boolean } {
  const styles = overrides.styles ?? new Map<string, OutputStyle>();
  let activeName: string | null = overrides.activeName ?? null;
  const ctx = {
    providerName: "test",
    model: "test-model",
    setProvider: () => null,
    setModel: () => undefined,
    clear: () => undefined,
    messageCount: () => 0,
    skills: () => new Map(),
    outputStyles: () => styles,
    activeStyleName: () => activeName,
    setStyle: (name: string) => {
      const s = styles.get(name.toLowerCase());
      if (!s) return `unknown output style "${name}"`;
      activeName = s.name;
      return null;
    },
    clearStyle: () => {
      activeName = null;
    },
    costSummary: () => "",
    toolList: () => "",
    sessionList: () => "",
    ...overrides,
  } as SlashContext;
  return ctx as SlashContext & { lastSet?: string; cleared?: boolean };
}

describe("/output-style slash command", () => {
  const terse: OutputStyle = {
    name: "terse",
    description: "Short answers.",
    body: "Be terse.",
    source: "user",
    path: "/x",
  };

  it("lists styles and marks the active one when called with no argument", () => {
    const ctx = makeContext({
      styles: new Map([["terse", terse]]),
      activeName: "terse",
    });
    const result = handleSlash("/output-style", ctx);
    expect(result.message).toContain("active: terse");
    expect(result.message).toContain("terse");
    expect(result.message).toContain("(active)");
  });

  it("indicates no active style when none is set", () => {
    const ctx = makeContext({
      styles: new Map([["terse", terse]]),
    });
    const result = handleSlash("/output-style", ctx);
    expect(result.message).toContain("no active style");
  });

  it("reports the empty-state message when no styles are loaded", () => {
    const ctx = makeContext();
    const result = handleSlash("/output-style", ctx);
    expect(result.message).toContain("no output styles loaded");
  });

  it("activates a style by name", () => {
    const ctx = makeContext({ styles: new Map([["terse", terse]]) });
    const result = handleSlash("/output-style terse", ctx);
    expect(result.message).toBe("output style switched to terse");
    expect(ctx.activeStyleName()).toBe("terse");
  });

  it("returns an error message for an unknown style", () => {
    const ctx = makeContext({ styles: new Map([["terse", terse]]) });
    const result = handleSlash("/output-style nope", ctx);
    expect(result.message).toContain("output style switch failed");
  });

  it("clears the active style on /output-style none", () => {
    const ctx = makeContext({
      styles: new Map([["terse", terse]]),
      activeName: "terse",
    });
    const result = handleSlash("/output-style none", ctx);
    expect(result.message).toBe("output style cleared");
    expect(ctx.activeStyleName()).toBeNull();
  });

  it("supports /style as a short alias", () => {
    const ctx = makeContext({ styles: new Map([["terse", terse]]) });
    const result = handleSlash("/style terse", ctx);
    expect(result.message).toBe("output style switched to terse");
  });
});
