import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyPaste,
  composerBackspace,
  composerDeleteWord,
  composerEnd,
  composerForwardDelete,
  composerHome,
  composerInsert,
  composerMoveLeft,
  composerMoveRight,
  detectPaste,
  expandPastes,
  formatElapsed,
  formatTokenCount,
  getCompletionSuggestion,
  isLiteralSlashCommand,
  isSubmitInput,
  isTerminalFocusReport,
  normalizeComposerValue,
  type PasteEntry,
  placeholderLabel,
  splitComposerCommand,
  stripPasteMarkers,
} from "../src/cli/repl.js";
import {
  AssistantTextReflow,
  reflowAssistantText,
} from "../src/cli/text-reflow.js";
import { applyEnvFiles } from "../src/env.js";
import {
  atomicWriteJson,
  atomicWriteText,
  fileExists,
  readJsonFile,
} from "../src/fs-io.js";
import { calculateCost, formatCost, lookupPricing } from "../src/pricing.js";
import {
  formatSkillForLLM,
  parseFrontmatter,
  type SkillEntry,
} from "../src/skills.js";
import { sanitizeForTerminal } from "../src/terminal.js";

describe("fs-io", () => {
  it("atomicWriteText round-trips through the real filesystem", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squad-code-"));
    const target = join(dir, "note.txt");
    await atomicWriteText(target, "hello\n");
    const content = await readFile(target, "utf-8");
    expect(content).toBe("hello\n");
    expect(await fileExists(target)).toBe(true);
  });

  it("atomicWriteJson round-trips through readJsonFile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squad-code-"));
    const target = join(dir, "data.json");
    const payload = { accent: "#7aa2f7", count: 3, tags: ["a", "b"] };
    await atomicWriteJson(target, payload);
    const loaded = await readJsonFile<typeof payload>(target);
    expect(loaded).toEqual(payload);
  });

  it("atomicWriteText creates missing parent directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squad-code-"));
    const target = join(dir, "nested", "deep", "file.txt");
    await atomicWriteText(target, "ok");
    expect(await readFile(target, "utf-8")).toBe("ok");
  });
});

describe("env files", () => {
  it("loads global values and lets local values override them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squad-code-"));
    const globalEnv = join(dir, "global.env");
    const localEnv = join(dir, "local.env");
    await writeFile(globalEnv, "DEEPSEEK_API_KEY=global-key\nLOG_LEVEL=info\n");
    await writeFile(localEnv, "DEEPSEEK_API_KEY=local-key\n", "utf-8");

    const env: NodeJS.ProcessEnv = {};
    applyEnvFiles([globalEnv, localEnv], env);

    expect(env["DEEPSEEK_API_KEY"]).toBe("local-key");
    expect(env["LOG_LEVEL"]).toBe("info");
  });

  it("does not overwrite variables already set by the shell", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squad-code-"));
    const globalEnv = join(dir, "global.env");
    await writeFile(globalEnv, "DEEPSEEK_API_KEY=global-key\n", "utf-8");

    const env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "shell-key" };
    applyEnvFiles([globalEnv], env);

    expect(env["DEEPSEEK_API_KEY"]).toBe("shell-key");
  });
});

describe("terminal sanitization", () => {
  it("strips ANSI/control sequences while preserving readable text", () => {
    expect(sanitizeForTerminal("\x1b[31mred\x1b[0m\nok\t!\x07")).toBe(
      "red\nok\t!",
    );
  });

  it("strips OSC-8 hyperlink wrappers but keeps the visible link text", () => {
    const link = "\x1b]8;;https://evil.test\x1b\\click here\x1b]8;;\x1b\\";
    expect(sanitizeForTerminal(`see: ${link}`)).toBe("see: click here");
  });

  it("strips zero-width characters used for token splitting", () => {
    expect(sanitizeForTerminal("h​el‌lo")).toBe("hello");
    expect(sanitizeForTerminal("﻿prompt")).toBe("prompt");
  });

  it("strips bidi-override codepoints that flip display direction", () => {
    // U+202E = right-to-left override, U+202D = left-to-right override
    expect(sanitizeForTerminal("safe‮evil‬end")).toBe("safeevilend");
    expect(sanitizeForTerminal("⁦hidden⁩")).toBe("hidden");
  });

  it("strips soft hyphen and other non-rendering format chars", () => {
    expect(sanitizeForTerminal("real­word")).toBe("realword");
    expect(sanitizeForTerminal("a⁠b⁡c")).toBe("abc");
  });

  it("preserves normal newlines and tabs", () => {
    expect(sanitizeForTerminal("line1\nline2\n\tindented")).toBe(
      "line1\nline2\n\tindented",
    );
  });
});

describe("assistant text reflow", () => {
  it("joins soft model-inserted line breaks inside paragraphs", () => {
    expect(
      reflowAssistantText(
        "They\nare a significant antagonistic force in the early adventures\nof Bilbo.",
      ),
    ).toBe(
      "They are a significant antagonistic force in the early adventures of Bilbo.",
    );
  });

  it("preserves markdown paragraph, list, and code block boundaries", () => {
    expect(
      reflowAssistantText(
        "Intro line\ncontinues here.\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\nAfter\nwrap.",
      ),
    ).toBe(
      "Intro line continues here.\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\nAfter wrap.",
    );
  });

  it("collapses excessive blank lines outside code fences", () => {
    expect(reflowAssistantText("One.\n\n\n\nTwo.")).toBe("One.\n\nTwo.");
  });

  it("preserves repeated blank lines inside code fences", () => {
    expect(reflowAssistantText("```txt\none\n\n\ntwo\n```\nDone.")).toBe(
      "```txt\none\n\n\ntwo\n```\nDone.",
    );
  });

  it("works across streaming chunks", () => {
    const reflow = new AssistantTextReflow();
    expect(reflow.push("They\nare")).toBe("");
    expect(reflow.preview()).toBe("They are");
    expect(reflow.push(" here.\n\nNext")).toBe("They are here.\n\n");
    expect(reflow.flush()).toBe("Next");
  });
});

describe("pricing", () => {
  it("returns the wildcard rate for ollama regardless of model name", () => {
    expect(lookupPricing("ollama", "gemma-3-9b")).toEqual({
      inputPerM: 0,
      outputPerM: 0,
    });
    expect(lookupPricing("OLLAMA", "anything")).toEqual({
      inputPerM: 0,
      outputPerM: 0,
    });
  });

  it("matches longer model prefixes before shorter ones", () => {
    const mini = lookupPricing("openai", "gpt-4o-mini-2024-07-18");
    expect(mini?.inputPerM).toBe(0.15);
    const fourO = lookupPricing("openai", "gpt-4o-2024-08-06");
    expect(fourO?.inputPerM).toBe(2.5);
  });

  it("returns null for unknown providers and unknown models", () => {
    expect(lookupPricing("unknown-provider", "unknown-model")).toBeNull();
    expect(lookupPricing("openai", "imaginary-model-id")).toBeNull();
  });

  it("calculates incremental cost from input/output token splits", () => {
    const cost = calculateCost({ inputPerM: 3, outputPerM: 15 }, 10_000, 2_000);
    // (10_000 / 1M) * 3 + (2_000 / 1M) * 15 = 0.03 + 0.03 = 0.06
    expect(cost).toBeCloseTo(0.06, 6);
  });

  it("formats costs with cents under $0.01 and dollars above", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.0042)).toBe("0.42¢");
    expect(formatCost(0.18)).toBe("$0.180");
    expect(formatCost(1.234)).toBe("$1.23");
    expect(formatCost(125)).toBe("$125");
  });
});

describe("skills", () => {
  it("parses frontmatter with name and description, returns body", () => {
    const md =
      "---\nname: red-team-audit\ndescription: Adversarial whole-project audit.\n---\n# Body\nThe body content.\n";
    const fm = parseFrontmatter(md);
    expect(fm).not.toBeNull();
    expect(fm?.name).toBe("red-team-audit");
    expect(fm?.description).toBe("Adversarial whole-project audit.");
    expect(fm?.body).toBe("# Body\nThe body content.");
  });

  it("returns null when frontmatter is missing or malformed", () => {
    expect(parseFrontmatter("# Just a heading\nNo frontmatter.")).toBeNull();
    expect(parseFrontmatter("---\ndescription: no name\n---\nbody")).toBeNull();
  });

  it("handles single-line descriptions and blank fields", () => {
    const md = "---\nname: tiny\ndescription: \n---\nbody";
    const fm = parseFrontmatter(md);
    expect(fm?.name).toBe("tiny");
    expect(fm?.description).toBe("");
  });

  it("formatSkillForLLM injects body and args, falls back to default tail", () => {
    const skill: SkillEntry = {
      name: "ship-it",
      description: "Forces the gap-closing conversation.",
      body: "Read the project. Identify blockers.",
      source: "user",
      path: "/fake/path/SKILL.md",
    };
    const withArgs = formatSkillForLLM(skill, "my-project");
    expect(withArgs).toContain("[Skill activated: ship-it]");
    expect(withArgs).toContain("Read the project.");
    expect(withArgs).toContain("my-project");

    const noArgs = formatSkillForLLM(skill, "");
    expect(noArgs).toContain("(No arguments provided");
  });
});

describe("Ink composer", () => {
  it("normalizes pasted multiline input into one line", () => {
    expect(
      normalizeComposerValue(
        "\x1b[200~first line\r\nsecond\tline\x1b[201~\x07",
      ),
    ).toBe("first line second line");
  });

  it("normalizes bullet-list paste text without submit-only newlines", () => {
    const pasted =
      "• Fixed the paste/composer issue more directly.\n\n  What changed:\n";
    expect(normalizeComposerValue(pasted)).toBe(
      "• Fixed the paste/composer issue more directly. What changed: ",
    );
    expect(isSubmitInput("", true)).toBe(false);
    expect(isSubmitInput("\r", true)).toBe(true);
  });

  it("rejects terminal focus reports before they reach the composer", () => {
    expect(isTerminalFocusReport("\x1b[O")).toBe(true);
    expect(isTerminalFocusReport("[I")).toBe(true);
    expect(isTerminalFocusReport("\u009bO")).toBe(true);
    expect(isTerminalFocusReport("[O[I[O")).toBe(true);
    expect(isTerminalFocusReport("ordinary [O text")).toBe(false);
  });

  it("detects pastes by length, embedded newlines, or bracketed markers over the word threshold", () => {
    expect(detectPaste("a")).toBe(false);
    expect(detectPaste("a".repeat(201))).toBe(true);
    expect(detectPaste("two\nlines")).toBe(true);
    // Short bracketed pastes (<= 18 words, no newlines) render inline as typed text.
    expect(detectPaste("\x1b[200~tiny\x1b[201~")).toBe(false);
    expect(detectPaste("[200~tiny[201~")).toBe(false);
    // Bracketed pastes that exceed the word threshold collapse to a placeholder.
    const manyWords = `\x1b[200~${"word ".repeat(20).trim()}\x1b[201~`;
    expect(detectPaste(manyWords)).toBe(true);
    // Bracketed paste with embedded newline always collapses regardless of length.
    expect(detectPaste("\x1b[200~one\ntwo\x1b[201~")).toBe(true);
  });

  it("strips paste markers with or without leading ESC byte", () => {
    expect(stripPasteMarkers("\x1b[200~a\nb\x1b[201~")).toBe("a\nb");
    expect(stripPasteMarkers("[200~a\nb[201~")).toBe("a\nb");
  });

  it("normalizeComposerValue strips both forms of paste markers", () => {
    expect(normalizeComposerValue("[200~hello[201~")).toBe("hello");
    expect(normalizeComposerValue("\x1b[200~hi\x1b[201~")).toBe("hi");
  });

  it("expands paste/file/image placeholders back into the value", () => {
    const pastes = new Map<number, PasteEntry>([
      [1, { kind: "text", content: "hello\nworld" }],
      [2, { kind: "file", content: "notes.md", path: "/abs/notes.md" }],
      [3, { kind: "image", content: "a.png", path: "/abs/a.png" }],
    ]);
    expect(
      expandPastes("see [Pasted Content #1] · [File #2] · [Image #3]", pastes),
    ).toBe(
      "see hello\nworld · [file at /abs/notes.md] · [image at /abs/a.png]",
    );
  });

  it("classifies paste content by kind, falling back to text on missing path", () => {
    const cwd = process.cwd();
    expect(classifyPaste("just plain text", cwd).kind).toBe("text");
    expect(classifyPaste("/nonexistent/path/foo.png", cwd).kind).toBe("text");
    // package.json exists at the project root in this repo
    const real = classifyPaste("package.json", cwd);
    expect(real.kind).toBe("file");
    expect(real.path?.endsWith("package.json")).toBe(true);
  });

  it("placeholderLabel maps kinds to display strings", () => {
    expect(placeholderLabel({ kind: "text", content: "" }, 1)).toBe(
      "[Pasted Content 0 chars #1]",
    );
    expect(placeholderLabel({ kind: "file", content: "" }, 2)).toBe(
      "[File #2]",
    );
    expect(placeholderLabel({ kind: "image", content: "" }, 7)).toBe(
      "[Image #7]",
    );
  });

  it("backspace removes any placeholder kind atomically", () => {
    const pastes = new Map<number, PasteEntry>([
      [4, { kind: "image", content: "a.png", path: "/abs/a.png" }],
    ]);
    const next = composerBackspace({ value: "[Image #4]", cursor: 10 }, pastes);
    expect(next).toEqual({ value: "", cursor: 0 });
    expect(pastes.has(4)).toBe(false);
  });

  it("isLiteralSlashCommand rejects all placeholder kinds", () => {
    expect(isLiteralSlashCommand("/[File #1] /clear")).toBe(false);
    expect(isLiteralSlashCommand("[Image #1] /clear")).toBe(false);
    expect(isLiteralSlashCommand("[Pasted Content #1]")).toBe(false);
    expect(isLiteralSlashCommand("/clear")).toBe(true);
  });

  it("formatTokenCount picks compact units appropriately", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1000)).toBe("1.0k");
    expect(formatTokenCount(8200)).toBe("8.2k");
    expect(formatTokenCount(24_543)).toBe("25k");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
  });

  it("treats placeholder-bearing input as user text, not slash commands", () => {
    expect(isLiteralSlashCommand("/clear")).toBe(true);
    expect(isLiteralSlashCommand("/model deepseek-chat")).toBe(true);
    expect(isLiteralSlashCommand("[Pasted Content #1]")).toBe(false);
    expect(isLiteralSlashCommand("[Pasted Content #1] /clear")).toBe(false);
    expect(isLiteralSlashCommand("/[Pasted Content #1]")).toBe(false);
    expect(isLiteralSlashCommand("ask /clear")).toBe(false);
  });

  it("formats elapsed turn duration in s, m s, and h m s", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(12_400)).toBe("12s");
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(272_000)).toBe("4m 32s");
    expect(formatElapsed(3_725_000)).toBe("1h 2m 5s");
  });

  it("inserts text at the cursor and advances by codepoint count", () => {
    expect(composerInsert({ value: "hello", cursor: 5 }, " world")).toEqual({
      value: "hello world",
      cursor: 11,
    });
    expect(composerInsert({ value: "abef", cursor: 2 }, "cd")).toEqual({
      value: "abcdef",
      cursor: 4,
    });
    // Surrogate pair: emoji is 2 UTF-16 code units, 1 codepoint
    expect(composerInsert({ value: "", cursor: 0 }, "🙂")).toEqual({
      value: "🙂",
      cursor: 1,
    });
  });

  it("backspace removes the codepoint before the cursor", () => {
    expect(composerBackspace({ value: "abc", cursor: 3 })).toEqual({
      value: "ab",
      cursor: 2,
    });
    expect(composerBackspace({ value: "abc", cursor: 2 })).toEqual({
      value: "ac",
      cursor: 1,
    });
    expect(composerBackspace({ value: "🙂a", cursor: 2 })).toEqual({
      value: "🙂",
      cursor: 1,
    });
    expect(composerBackspace({ value: "🙂a", cursor: 1 })).toEqual({
      value: "a",
      cursor: 0,
    });
    expect(composerBackspace({ value: "abc", cursor: 0 })).toEqual({
      value: "abc",
      cursor: 0,
    });
  });

  it("backspace at end of a paste placeholder removes the whole token", () => {
    const pastes = new Map<number, string>([[1, "long text"]]);
    const next = composerBackspace(
      { value: "[Pasted Content #1]", cursor: 19 },
      pastes,
    );
    expect(next).toEqual({ value: "", cursor: 0 });
    expect(pastes.has(1)).toBe(false);
  });

  it("forward-delete removes the codepoint after the cursor and is no-op at end", () => {
    expect(composerForwardDelete({ value: "abc", cursor: 0 })).toEqual({
      value: "bc",
      cursor: 0,
    });
    expect(composerForwardDelete({ value: "abc", cursor: 1 })).toEqual({
      value: "ac",
      cursor: 1,
    });
    expect(composerForwardDelete({ value: "abc", cursor: 3 })).toEqual({
      value: "abc",
      cursor: 3,
    });
    expect(composerForwardDelete({ value: "🙂x", cursor: 0 })).toEqual({
      value: "x",
      cursor: 0,
    });
  });

  it("forward-delete at start of a paste placeholder removes the whole token", () => {
    const pastes = new Map<number, string>([[1, "long text"]]);
    const next = composerForwardDelete(
      { value: "[Pasted Content #1]end", cursor: 0 },
      pastes,
    );
    expect(next).toEqual({ value: "end", cursor: 0 });
    expect(pastes.has(1)).toBe(false);
  });

  it("ctrl+w deletes the previous word, skipping trailing whitespace", () => {
    expect(composerDeleteWord({ value: "one two three", cursor: 13 })).toEqual({
      value: "one two ",
      cursor: 8,
    });
    expect(composerDeleteWord({ value: "one two   ", cursor: 10 })).toEqual({
      value: "one ",
      cursor: 4,
    });
    expect(composerDeleteWord({ value: "abc", cursor: 0 })).toEqual({
      value: "abc",
      cursor: 0,
    });
  });

  it("cursor moves clamp to bounds and skip surrogate halves", () => {
    expect(composerMoveLeft({ value: "ab", cursor: 1 })).toEqual({
      value: "ab",
      cursor: 0,
    });
    expect(composerMoveLeft({ value: "ab", cursor: 0 })).toEqual({
      value: "ab",
      cursor: 0,
    });
    expect(composerMoveRight({ value: "ab", cursor: 1 })).toEqual({
      value: "ab",
      cursor: 2,
    });
    expect(composerMoveRight({ value: "ab", cursor: 2 })).toEqual({
      value: "ab",
      cursor: 2,
    });
    expect(composerHome({ value: "abc", cursor: 2 })).toEqual({
      value: "abc",
      cursor: 0,
    });
    expect(composerEnd({ value: "🙂xyz", cursor: 0 })).toEqual({
      value: "🙂xyz",
      cursor: 4,
    });
  });

  it("suggests slash-command completions for builtins and skills", () => {
    const skills = ["red-team-audit", "red-team-remediate", "ship-it"];
    expect(getCompletionSuggestion("/he", 3, skills)).toBe("lp");
    expect(getCompletionSuggestion("/comp", 5, skills)).toBe("act");
    expect(getCompletionSuggestion("/red-tea", 8, skills)).toBe("m-audit");
    expect(getCompletionSuggestion("/ship", 5, skills)).toBe("-it");
  });

  it("does not suggest when the cursor is mid-value or after a space", () => {
    expect(getCompletionSuggestion("/help", 3, [])).toBe("");
    expect(getCompletionSuggestion("/model deepseek", 15, [])).toBe("");
    expect(getCompletionSuggestion("plain text", 10, [])).toBe("");
    expect(getCompletionSuggestion("/", 1, [])).toBe("");
    expect(getCompletionSuggestion("/help", 5, [])).toBe("");
    expect(getCompletionSuggestion("/zzz", 4, [])).toBe("");
  });

  it("recognizes only the leading slash command token for composer highlighting", () => {
    expect(splitComposerCommand("/")).toEqual({ command: "/", rest: "" });
    expect(splitComposerCommand("/model")).toEqual({
      command: "/model",
      rest: "",
    });
    expect(splitComposerCommand("/model deepseek-v4-pro")).toEqual({
      command: "/model",
      rest: " deepseek-v4-pro",
    });
    expect(splitComposerCommand("ask about /model")).toBeNull();
  });
});

describe("pricing with cached input tokens", () => {
  it("calculateCost ignores cached arg when provider has no cached rate", async () => {
    const { calculateCost } = await import("../src/pricing.js");
    const pricing = { inputPerM: 1.0, outputPerM: 2.0 };
    const baseline = calculateCost(pricing, 1_000_000, 0);
    const withCached = calculateCost(pricing, 1_000_000, 0, 500_000);
    expect(withCached).toBeCloseTo(baseline, 6);
  });

  it("calculateCost discounts the cached portion when cachedInputPerM is set", async () => {
    const { calculateCost } = await import("../src/pricing.js");
    const pricing = { inputPerM: 1.0, outputPerM: 2.0, cachedInputPerM: 0.1 };
    const cost = calculateCost(pricing, 1_000_000, 0, 700_000);
    expect(cost).toBeCloseTo(0.3 * 1.0 + 0.7 * 0.1, 6);
  });

  it("calculateCost clamps cached tokens that exceed total input", async () => {
    const { calculateCost } = await import("../src/pricing.js");
    const pricing = { inputPerM: 1.0, outputPerM: 2.0, cachedInputPerM: 0.1 };
    const cost = calculateCost(pricing, 100_000, 0, 999_999);
    expect(cost).toBeCloseTo((100_000 / 1_000_000) * 0.1, 6);
  });

  it("DeepSeek pricing table includes a cached rate at ~10% of input", async () => {
    const { lookupPricing } = await import("../src/pricing.js");
    const chat = lookupPricing("deepseek", "deepseek-chat");
    expect(chat?.cachedInputPerM).toBeDefined();
    expect(chat?.cachedInputPerM).toBeCloseTo((chat?.inputPerM ?? 0) * 0.1, 4);
  });
});

describe("project permissions", () => {
  it("loadProjectRules returns an empty map when no settings file exists", async () => {
    const { loadProjectRules } = await import("../src/permissions/project.js");
    const dir = await mkdtemp(join(tmpdir(), "squad-code-"));
    const result = await loadProjectRules(dir);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("persistProjectRule writes a new file with the rule under permissions.rules", async () => {
    const { persistProjectRule, loadProjectRules, getProjectSettingsPath } =
      await import("../src/permissions/project.js");
    const dir = await mkdtemp(join(tmpdir(), "squad-code-"));
    await persistProjectRule(dir, "Shell", "git status *", "allow");
    const path = getProjectSettingsPath(dir);
    const raw = JSON.parse(await readFile(path, "utf-8"));
    expect(raw.permissions.rules).toEqual({
      Shell: { "git status *": "allow" },
    });
    const reloaded = await loadProjectRules(dir);
    expect(reloaded.get("Shell")).toEqual([
      { pattern: "git status *", action: "allow" },
    ]);
  });

  it("persistProjectRule merges into an existing rule set and preserves unknown keys", async () => {
    const { persistProjectRule, loadProjectRules, getProjectSettingsPath } =
      await import("../src/permissions/project.js");
    const dir = await mkdtemp(join(tmpdir(), "squad-code-"));
    const path = getProjectSettingsPath(dir);
    await atomicWriteJson(path, {
      version: "0.2.0",
      permissions: { rules: { Read: { "*.md": "allow" } } },
      futureFeature: { example: true },
    });
    await persistProjectRule(dir, "Shell", "npm test *", "allow");
    const raw = JSON.parse(await readFile(path, "utf-8"));
    expect(raw.permissions.rules).toEqual({
      Read: { "*.md": "allow" },
      Shell: { "npm test *": "allow" },
    });
    expect(raw.futureFeature).toEqual({ example: true });
    const reloaded = await loadProjectRules(dir);
    expect(reloaded.get("Read")).toEqual([
      { pattern: "*.md", action: "allow" },
    ]);
    expect(reloaded.get("Shell")).toEqual([
      { pattern: "npm test *", action: "allow" },
    ]);
  });

  it("persistProjectRule is idempotent — same tool/pattern/action doesn't duplicate or churn", async () => {
    const { persistProjectRule, getProjectSettingsPath } = await import(
      "../src/permissions/project.js"
    );
    const dir = await mkdtemp(join(tmpdir(), "squad-code-"));
    await persistProjectRule(dir, "Read", "*.md", "allow");
    await persistProjectRule(dir, "Read", "*.md", "allow");
    const raw = JSON.parse(
      await readFile(getProjectSettingsPath(dir), "utf-8"),
    );
    expect(raw.permissions.rules).toEqual({ Read: { "*.md": "allow" } });
  });

  it("loadProjectRules converts the legacy permissions.alwaysAllowed array into wildcard-allow rules", async () => {
    const { loadProjectRules, getProjectSettingsPath } = await import(
      "../src/permissions/project.js"
    );
    const dir = await mkdtemp(join(tmpdir(), "squad-code-"));
    const path = getProjectSettingsPath(dir);
    await atomicWriteJson(path, {
      version: "0.1.0",
      permissions: { alwaysAllowed: ["Read", "Glob"] },
    });
    const map = await loadProjectRules(dir);
    expect(map.get("Read")).toEqual([{ pattern: "*", action: "allow" }]);
    expect(map.get("Glob")).toEqual([{ pattern: "*", action: "allow" }]);
  });

  it("loadProjectRules handles a malformed settings file gracefully", async () => {
    const { loadProjectRules, getProjectSettingsPath } = await import(
      "../src/permissions/project.js"
    );
    const dir = await mkdtemp(join(tmpdir(), "squad-code-"));
    const path = getProjectSettingsPath(dir);
    await atomicWriteText(path, "{ this is not valid json");
    const result = await loadProjectRules(dir);
    expect(result.size).toBe(0);
  });
});
